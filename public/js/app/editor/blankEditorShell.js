/**
 * Blank PDF editor — full application chrome (PDFAid-style).
 *
 * Wraps the object-canvas engine (`blankPdfEditor.js`) in a complete, self-owned
 * editor UI: a two-row header (brand · document tab · Saved/Share/account), a
 * labelled-icon tool bar, a compact Pages panel (thumbnails + add/delete/reorder),
 * a tabbed right properties panel, and a rich status bar (page size, dimensions,
 * page nav, zoom slider, word/char counts, dark toggle).
 *
 * In blank mode the shared shell chrome is collapsed and this owns the whole
 * window, so the surface matches a dedicated commercial PDF editor. Everything is
 * wired to the engine's imperative API + callbacks; file actions (Export)
 * are relayed on the bus so the existing command router handles them.
 */
import { el } from '../../workspace/utils/dom.js';
import { renderIcon } from '../../workspace/icons.js';
import { renderControls } from '../shell/controls.js';
import { builtinPropertyProviders, FONT_OPTIONS } from '../properties/index.js';
import { createBlankPdfEditor, shapeSvgMarkup } from './blankPdfEditor.js';
import { renderPdfToPages } from './pdfImport.js';
import { exportEditorToPdf, renderPageCanvas, modelHasVisibleContent } from './pdfExport.js';
import { createExportPanel } from './exportPanel.js';
import { pdfModelToPositionedDoc } from '../services/convert/positionedImport.js';
import { packProject, unpackProject } from '../core/document/project.js';
import { STAMP_CATEGORIES, stampSvgMarkup, makeStampDef } from './stampLibrary.js';

const providersByKind = Object.fromEntries(builtinPropertyProviders.map((p) => [p.kind, p]));

// Toolbar tools (icon-with-label). `tool` → engine tool id; `action` → a command.
const TOOLS = [
  { id: 'undo', icon: 'undo', label: 'Undo', action: 'undo' },
  { id: 'redo', icon: 'redo', label: 'Redo', action: 'redo' },
  { sep: true },
  { id: 'select', icon: 'edit', label: 'Edit', tool: 'select' },
  { id: 'text', icon: 'text', label: 'Add Text', tool: 'text' },
  { id: 'image', icon: 'image', label: 'Image', tool: 'image' },
  { id: 'shape', icon: 'shapes', label: 'Shape', action: 'shape-menu' },
  { id: 'highlight', icon: 'highlight', label: 'Highlight', tool: 'highlight' },
  { id: 'signature', icon: 'signature', label: 'Signature', tool: 'signature' },
  { id: 'stamp', icon: 'stamp', label: 'Stamp', action: 'stamp-panel' },
  { sep: true, grow: true },
  { id: 'tools', icon: 'layers', label: 'Tools', action: 'tools' },
  { id: 'properties', icon: 'sliders', label: 'Properties', action: 'properties' },
  { id: 'export', icon: 'export', label: 'Export', action: 'export' },
];

// The Shape button opens this picker — a curated set of annotation shapes that
// covers the vast majority of PDF editing needs (no full vector-design palette).
const SHAPES = [
  { value: 'rect', label: 'Rectangle' },
  { value: 'roundRect', label: 'Rounded Rectangle' },
  { value: 'circle', label: 'Circle' },
  { value: 'ellipse', label: 'Ellipse' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'line', label: 'Line' },
  { value: 'arrow', label: 'Arrow' },
  { value: 'doubleArrow', label: 'Double Arrow' },
  { value: 'speech', label: 'Speech Bubble' },
];

export function createBlankEditorShell({ container, bus }) {
  let lastDescriptor = null;

  // The canvas slot is created up front; the engine is created *after* all the
  // chrome elements exist, because the engine invokes onZoom/onDims during
  // construction and those callbacks touch status-bar elements.
  const loadingEl = el('div', { class: 'bpx-loading', hidden: true }, [
    el('span', { class: 'bpx-loading__spin' }), el('span', { class: 'bpx-loading__txt' }, 'Opening PDF…'),
  ]);
  const canvasSlot = el('div', { class: 'bpx-canvas' }, loadingEl);
  let engine, tabName;

  /* ------------------------------- header ------------------------------- */
  const goHome = () => bus.emit('nav:command', { command: 'view', arg: 'home' });
  const header = el('header', { class: 'bpx-top' }, [
    el('button', { class: 'bpx-brand', type: 'button', title: 'Advance Office Doc home', onClick: goHome }, [
      el('span', { class: 'bpx-brand__mark' }, [el('img', { class: 'bpx-brand__img', src: '/images/logo-mark.png', alt: '' })]),
      el('span', { class: 'bpx-brand__name' }, [el('b', {}, 'Advance'), ' Office Doc']),
    ]),
    el('div', { class: 'bpx-tabs' }, [
      el('div', { class: 'bpx-tab is-active' }, [
        el('span', { class: 'bpx-tab__ico', html: renderIcon('pdf') }),
        (tabName = el('span', { class: 'bpx-tab__name' }, 'Untitled.pdf')),
        el('button', { class: 'bpx-tab__close', type: 'button', 'aria-label': 'Close document', html: renderIcon('close'), onClick: goHome }),
      ]),
      el('button', { class: 'bpx-tab-add', type: 'button', 'aria-label': 'New tab', html: renderIcon('plus'), onClick: () => bus.emit('toast', 'Multiple documents — coming soon.') }),
    ]),
    el('div', { class: 'bpx-top__right' }, [
      // "Transfer" — the headline handoff: convert this PDF to an editable document
      // and open it in the Document editor. Given a distinct glowing style so it
      // reads as a primary feature, not a hidden menu item.
      el('button', { class: 'bpx-transfer', type: 'button', title: 'Transfer this PDF into the Document editor as an editable document', onClick: () => transferToDoc() },
        [el('span', { class: 'bpx-transfer__ico', html: renderIcon('document') }), 'Transfer to Doc']),
      el('button', { class: 'bpx-import', type: 'button', title: 'Import a PDF to edit', onClick: () => bus.emit('nav:command', { command: 'open', arg: 'pdf' }) },
        [el('span', { html: renderIcon('upload') }), 'Import PDF']),
      iconBtn('help', 'Help', () => bus.emit('toast', 'Help center — coming soon.')),
      iconBtn('bell', 'Notifications', () => bus.emit('toast', 'No new notifications.')),
    ]),
  ]);

  /* ------------------------------ toolbar ------------------------------- */
  // Contextual text formatting group — the most-used text controls (font, size,
  // B/I/U/S, colour, alignment). It lives INSIDE the main toolbar's empty middle
  // section and only appears when a text object is selected, so editing never
  // needs a trip to the right sidebar. The right Properties panel keeps only
  // advanced settings (case, spacing, opacity, …).
  const applyText = (key, value) => {
    // Only act on a live text selection — otherwise applyProperty would record
    // an empty undo step (or apply nothing) while the bar is shown-but-inactive.
    if (!engine.hasSelection() || lastDescriptor?.kind !== 'text') return;
    engine.applyProperty('text', key, value);
    if (lastDescriptor?.values) lastDescriptor.values[key] = value;
    if (propsOpen && lastDescriptor?.kind === 'text') renderProps(lastDescriptor);
  };
  const fmtFont = el('select', { class: 'bpx-fmt__font', title: 'Font', 'aria-label': 'Font',
    onChange: (e) => applyText('fontFamily', e.target.value) },
    FONT_OPTIONS.map((o) => el('option', { value: o.value }, o.label)));
  const fmtSize = el('input', { class: 'bpx-fmt__size', type: 'number', min: '6', max: '400', title: 'Font size', 'aria-label': 'Font size',
    onChange: (e) => applyText('fontSize', Number(e.target.value) || 16) });
  const styleBtns = {};
  // mousedown + preventDefault keeps the caret/selection alive so toggling a
  // style mid-edit doesn't blur the text box out from under the user.
  const keepFocus = (e) => e.preventDefault();
  const mkStyle = (key, node, title) => {
    const b = el('button', { class: 'bpx-fmt__btn', type: 'button', title, onMouseDown: keepFocus, onClick: () => { if (engine.hasSelection()) engine.toggleTextStyle(key); } }, node);
    styleBtns[key] = b; return b;
  };
  const fmtColor = el('input', { class: 'bpx-fmt__color', type: 'color', title: 'Text colour', 'aria-label': 'Text colour',
    onChange: (e) => applyText('color', e.target.value) });
  const alignBtns = {};
  const mkAlign = (val, title) => {
    const b = el('button', { class: 'bpx-fmt__btn', type: 'button', title, onMouseDown: keepFocus, onClick: () => setAlign(val) }, el('span', { html: alignSvg(val) }));
    alignBtns[val] = b; return b;
  };
  const setAlign = (v) => { applyText('align', v); for (const a in alignBtns) alignBtns[a].classList.toggle('is-on', a === v); };
  const fsep = () => el('span', { class: 'bpx-fmt__sep' });
  const fmtBar = el('div', { class: 'bpx-fmtbar is-inactive', role: 'group', 'aria-label': 'Text formatting' }, [
    fmtFont, fmtSize, fsep(),
    mkStyle('bold', el('b', {}, 'B'), 'Bold'),
    mkStyle('italic', el('i', {}, 'I'), 'Italic'),
    mkStyle('underline', el('u', {}, 'U'), 'Underline'),
    mkStyle('strike', el('s', {}, 'S'), 'Strikethrough'),
    fsep(), fmtColor, fsep(),
    mkAlign('left', 'Align left'), mkAlign('center', 'Align center'),
    mkAlign('right', 'Align right'), mkAlign('justify', 'Justify'),
  ]);

  // The bar is ALWAYS visible in the toolbar; selecting a text object just makes
  // it active (undimmed + interactive). With no text selected it stays shown but
  // dimmed, so the controls are always in view.
  function showFmtBar(on) { fmtBar.classList.toggle('is-inactive', !on); }
  function syncFmtBar(values) {
    if (!values) return;
    fmtFont.value = values.fontFamily || 'Inter';
    fmtSize.value = values.fontSize != null ? Math.round(values.fontSize) : 16;
    fmtColor.value = normHex(values.color);
    const st = Array.isArray(values.style) ? values.style : [];
    for (const k of ['bold', 'italic', 'underline', 'strike']) styleBtns[k].classList.toggle('is-on', st.includes(k));
    const al = values.align || 'left';
    for (const a in alignBtns) alignBtns[a].classList.toggle('is-on', a === al);
  }

  let undoBtn, redoBtn;
  const toolbar = el('div', { class: 'bpx-toolbar', role: 'toolbar' });
  for (const t of TOOLS) {
    if (t.sep) {
      toolbar.appendChild(el('span', { class: `bpx-tsep${t.grow ? ' bpx-tsep--grow' : ''}` }));
      // The single "grow" gap in the middle hosts the contextual formatting bar,
      // flanked by a second grow spacer so it stays centred (and collapses to an
      // empty gap when hidden).
      if (t.grow) { toolbar.appendChild(fmtBar); toolbar.appendChild(el('span', { class: 'bpx-tsep bpx-tsep--grow' })); }
      continue;
    }
    const btn = el('button', {
      class: 'bpx-tool', type: 'button', 'data-id': t.id, title: t.label,
      onClick: () => runTool(t),
    }, [
      el('span', { class: 'bpx-tool__ico', html: renderIcon(t.icon) }),
      el('span', { class: 'bpx-tool__lbl' }, t.label),
    ]);
    if (t.id === 'undo') undoBtn = btn;
    if (t.id === 'redo') redoBtn = btn;
    toolbar.appendChild(btn);
  }
  undoBtn.disabled = true; redoBtn.disabled = true;

  function runTool(t) {
    if (t.tool) { setStampMode(false); return engine.setTool(t.tool); }
    switch (t.action) {
      case 'undo': return engine.undo();
      case 'redo': return engine.redo();
      case 'export': return openExportMenu();
      case 'properties': return toggleProps();
      case 'tools': return toggleTools();
      case 'shape-menu': setStampMode(false); return toggleShapeMenu();
      case 'stamp-panel': return toggleStampMode();
    }
  }

  /* --------------------- Shape picker flyout --------------------------- */
  let shapeMenu = null;
  function closeShapeMenu() {
    if (!shapeMenu) return;
    shapeMenu.remove();
    shapeMenu = null;
    toolbar.querySelector('.bpx-tool[data-id="shape"]')?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', closeShapeMenu);
  }
  function toggleShapeMenu() {
    if (shapeMenu) return closeShapeMenu();
    const btn = toolbar.querySelector('.bpx-tool[data-id="shape"]');
    const r = btn.getBoundingClientRect();
    shapeMenu = el('div', { class: `bpx-shape-menu${rootEl.classList.contains('is-dark') ? ' is-dark' : ''}`, role: 'menu' },
      SHAPES.map((s) => el('button', {
        class: 'bpx-shape-item', type: 'button', role: 'menuitem', title: s.label,
        onClick: (e) => { e.stopPropagation(); closeShapeMenu(); pickShape(s.value); },
      }, [
        el('span', { class: 'bpx-shape-item__ico', html: shapeSvgMarkup({ shape: s.value, fill: '#e0e7ff', stroke: '#4f46e5', strokeWidth: 3, radius: s.value === 'roundRect' ? 16 : 6, opacity: 1 }) }),
        el('span', { class: 'bpx-shape-item__lbl' }, s.label),
      ]))
    );
    shapeMenu.style.top = `${Math.round(r.bottom + 6)}px`;
    // Keep the flyout on-screen even if the button sits near the right edge.
    const left = Math.min(Math.round(r.left), window.innerWidth - 296);
    shapeMenu.style.left = `${Math.max(8, left)}px`;
    document.body.appendChild(shapeMenu);
    btn.setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('click', closeShapeMenu), 0);
  }
  function pickShape(value) {
    engine.setShape(value);
    engine.setTool('shape');
    bus.emit('toast', 'Drag on the page to draw the shape.');
  }

  /* ----------------------- Export menu (Quick / Advanced) ---------------- */
  // Clicking Export offers two paths: Quick Export downloads the edited PDF
  // immediately (the original, fastest behaviour); Advanced Export opens the
  // conversion workspace without downloading. The editor stays mounted beneath
  // the panel, so returning loses no work.
  let exportMenu = null;
  let exportPanel = null;
  function closeExportMenu() {
    if (!exportMenu) return;
    exportMenu.remove();
    exportMenu = null;
    toolbar.querySelector('.bpx-tool[data-id="export"]')?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', closeExportMenu);
  }
  function getExportPanel() {
    if (!exportPanel) {
      exportPanel = createExportPanel({
        mount: rootEl,
        bus,
        getModel: () => engine.getExportModel(),
        getDocName: () => docName,
        downloadBlob,
        isDark: () => rootEl.classList.contains('is-dark'),
      });
    }
    return exportPanel;
  }
  function openExportMenu() {
    if (exportMenu) return closeExportMenu();
    const btn = toolbar.querySelector('.bpx-tool[data-id="export"]');
    const r = btn.getBoundingClientRect();
    const item = (icon, title, sub, onClick, extraClass) => el('button', {
      class: `bpx-export-item${extraClass ? ' ' + extraClass : ''}`, type: 'button', role: 'menuitem',
      onClick: (e) => { e.stopPropagation(); closeExportMenu(); onClick(); },
    }, [
      el('span', { class: 'bpx-export-item__ico', html: renderIcon(icon) }),
      el('span', { class: 'bpx-export-item__txt' }, [
        el('span', { class: 'bpx-export-item__lbl' }, title),
        el('span', { class: 'bpx-export-item__sub' }, sub),
      ]),
    ]);
    exportMenu = el('div', { class: `bpx-export-menu${rootEl.classList.contains('is-dark') ? ' is-dark' : ''}`, role: 'menu' }, [
      item('export', 'Quick Export', 'Download the edited PDF now', () => bus.emit('action', 'export')),
      item('sparkle', 'Advanced Export', 'Compress or convert to Word, Excel, image…', () => getExportPanel().open(), 'bpx-export-item--glow'),
    ]);
    exportMenu.style.top = `${Math.round(r.bottom + 6)}px`;
    const left = Math.min(Math.round(r.right - 288), window.innerWidth - 296);
    exportMenu.style.left = `${Math.max(8, left)}px`;
    document.body.appendChild(exportMenu);
    btn.setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('click', closeExportMenu), 0);
  }

  /* ---------------------- Transfer → Document editor -------------------- */
  // Hand the open PDF to the Document workspace as an EXACT-LAYOUT (positioned)
  // document: each page keeps its native size, the PDF page raster becomes the
  // page background (so borders/shading/lines/images stay pixel-exact), and every
  // text line becomes an absolutely-positioned, independently-editable box at its
  // real PDF coordinates with the real font/size/weight/colour/alignment. Nothing
  // reflows, resizes or re-centres. Built entirely client-side from the PDF's own
  // extracted coordinates (positionedImport.js) and handed over as a model — no
  // download, no docx round-trip. See documentEditor.layoutPositioned().
  //
  // A focused, full-editor processing overlay shows progress before the Document
  // editor opens automatically. Reuses the editor spinner styling.
  let transferOverlay = null, transferStepEl = null;
  function openTransferOverlay() {
    transferStepEl = el('div', { class: 'bpx-xfer__step' }, 'Reading the PDF…');
    transferOverlay = el('div', { class: `bpx-xfer${rootEl.classList.contains('is-dark') ? ' is-dark' : ''}`, role: 'status', 'aria-live': 'polite' }, [
      el('div', { class: 'bpx-xfer__card' }, [
        el('div', { class: 'bpx-xfer__spin' }),
        el('div', { class: 'bpx-xfer__title' }, 'Transferring to Document editor'),
        transferStepEl,
        el('div', { class: 'bpx-xfer__bar' }, [el('span', { class: 'bpx-xfer__bar-fill' })]),
        el('div', { class: 'bpx-xfer__hint' }, 'Rebuilding your PDF as an editable document — text, tables and images kept in place.'),
      ]),
    ]);
    rootEl.appendChild(transferOverlay);
  }
  function closeTransferOverlay() { transferOverlay?.remove(); transferOverlay = null; transferStepEl = null; }

  let transferring = false;
  async function transferToDoc() {
    if (transferring) return;
    const model = engine.getExportModel();
    if (!modelHasContent(model)) {
      bus.emit('toast', 'Nothing to transfer yet — open or edit a PDF first.');
      return;
    }
    transferring = true;
    openTransferOverlay();
    const say = (msg) => { if (transferStepEl) transferStepEl.textContent = msg; };
    try {
      say('Reading the PDF page geometry…');
      await new Promise((r) => requestAnimationFrame(r)); // let the overlay paint first
      say('Reproducing the exact layout (positions, fonts, tables, images)…');
      // Build a positioned exact-layout Document directly from the PDF's own
      // coordinates — masked page raster + editable text boxes at their real x/y.
      // OCR is OFF on purpose: it re-reads text BAKED into the page (rotated/vertical
      // border frames, diagonal watermarks, template labels — all of which pdfImport
      // already leaves baked) and dumps it back as misplaced boxes, which was the
      // clutter over the exact layout. Without it, only the real PDF text-layer runs
      // become editable boxes and every decoration stays pixel-exact in the raster.
      const doc = await pdfModelToPositionedDoc(model, docName, { ocr: false });
      say('Opening in the Document editor…');
      // Hand the model straight to the Document workspace (no file, no import).
      bus.emit('workspace:open-doc-model', { model: doc, name: docName });
    } catch (err) {
      console.error('[transfer-to-doc]', err);
      bus.emit('toast', 'Sorry — this PDF could not be transferred to the Document editor.');
    } finally {
      transferring = false;
      closeTransferOverlay();
    }
  }

  /* ------------------ right sidebar (Properties / PDF Tools) ------------- */
  // Exactly ONE right panel is visible at a time — opening one closes the other,
  // so the two never share (waste) horizontal space. Each toolbar button toggles
  // its own panel.
  let propsOpen = false, toolsOpen = false; // remembered while this editor lives
  function markTool(id, on) { toolbar.querySelector(`.bpx-tool[data-id="${id}"]`)?.classList.toggle('is-active', on); }
  function setProps(open) {
    propsOpen = open;
    if (open && toolsOpen) setTools(false); // mutual exclusion
    rootEl.classList.toggle('is-props-open', open);
    markTool('properties', open);
  }
  function setTools(open) {
    toolsOpen = open;
    if (open && propsOpen) setProps(false); // mutual exclusion
    rootEl.classList.toggle('is-tools-open', open);
    markTool('tools', open);
  }
  const toggleTools = () => setTools(!toolsOpen);
  const openProps = () => setProps(true);
  const closeProps = () => setProps(false);
  // Manual toggle only makes sense for a live selection — with nothing selected
  // there are no object properties to show, so keep the panel hidden.
  const toggleProps = () => {
    if (propsOpen) { closeProps(); return; }
    // Always open — with a live selection show that object's properties, with
    // nothing selected fall back to document properties. No "select something
    // first" gate: the panel is available at any time.
    renderProps(lastDescriptor);
    openProps();
  };
  // Reveal the inspector focused on the current selection (context-menu "Font",
  // "Fill Color", … jump straight here rather than duplicating every control).
  const showInspector = () => { openProps(); if (lastDescriptor) renderProps(lastDescriptor); };

  /* --------------------- Right-click context menu --------------------- */
  let ctxMenu = null;
  function closeContextMenu() {
    if (!ctxMenu) return;
    ctxMenu.remove();
    ctxMenu = null;
    document.removeEventListener('pointerdown', onCtxOutside, true);
  }
  function onCtxOutside(e) { if (ctxMenu && !ctxMenu.contains(e.target)) closeContextMenu(); }

  function openContextMenu(info) {
    // While Stamp mode is armed, right-click opens the on-screen stamp picker at
    // the cursor (pick one → it drops there) instead of the normal object menu.
    if (stampMode) return openStampPicker({ clientX: info.clientX, clientY: info.clientY });
    closeContextMenu();
    closeShapeMenu();
    ctxMenu = el('div', {
      class: `bpx-ctx${rootEl.classList.contains('is-dark') ? ' is-dark' : ''}`, role: 'menu',
      onContextmenu: (e) => e.preventDefault(),
    }, contextItems(info).map((it) => it.sep
      ? el('div', { class: 'bpx-ctx__sep' })
      : el('button', {
          class: `bpx-ctx__item${it.danger ? ' is-danger' : ''}`, type: 'button', role: 'menuitem',
          disabled: !!it.disabled,
          onClick: (e) => { e.stopPropagation(); closeContextMenu(); it.on && it.on(); },
        }, [
          el('span', { class: 'bpx-ctx__lbl' }, it.label),
          it.key ? el('span', { class: 'bpx-ctx__key' }, it.key) : null,
        ])
    ));
    document.body.appendChild(ctxMenu);
    // Position at the cursor, flipped to stay fully on-screen.
    const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
    let x = info.clientX, y = info.clientY;
    if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
    if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8;
    ctxMenu.style.left = `${Math.max(8, x)}px`;
    ctxMenu.style.top = `${Math.max(8, y)}px`;
    setTimeout(() => document.addEventListener('pointerdown', onCtxOutside, true), 0);
  }

  function contextItems(info) {
    const L = info.locked;
    const lockItem = { label: L ? 'Unlock' : 'Lock', on: () => engine.toggleLock() };
    const copy = { label: 'Copy', key: 'Ctrl+C', on: () => engine.copySelected() };
    const dup = { label: 'Duplicate', key: 'Ctrl+D', disabled: L, on: () => engine.duplicateSelected() };
    const fwd = { label: 'Bring Forward', disabled: L, on: () => engine.bringForward() };
    const back = { label: 'Send Backward', disabled: L, on: () => engine.sendBackward() };
    const del = { label: 'Delete', key: 'Del', danger: true, disabled: L, on: () => engine.deleteSelected() };

    if (info.target === 'text') {
      return [
        { label: 'Edit', disabled: L, on: () => engine.editSelected() },
        { sep: true },
        copy,
        { label: 'Cut', key: 'Ctrl+X', disabled: L, on: () => engine.cutSelected() },
        { label: 'Paste', key: 'Ctrl+V', disabled: !info.hasClipboard, on: () => engine.pasteClipboard() },
        dup,
        { sep: true },
        { label: 'Font…', on: showInspector },
        { label: 'Text Color…', on: showInspector },
        { label: 'Highlight…', on: showInspector },
        { sep: true },
        { label: 'Bold', key: 'Ctrl+B', disabled: L, on: () => engine.toggleTextStyle('bold') },
        { label: 'Italic', key: 'Ctrl+I', disabled: L, on: () => engine.toggleTextStyle('italic') },
        { label: 'Underline', key: 'Ctrl+U', disabled: L, on: () => engine.toggleTextStyle('underline') },
        { sep: true },
        fwd, back, lockItem,
        { sep: true },
        del,
      ];
    }
    if (info.target === 'image') {
      return [
        { label: 'Replace Image', disabled: L, on: () => engine.replaceImage() },
        { label: 'Crop Image', disabled: L, on: () => engine.cropImage() },
        { label: 'Delete Image', key: 'Del', danger: true, disabled: L, on: () => engine.deleteSelected() },
        { sep: true },
        { label: 'Rotate 90°', disabled: L, on: () => engine.rotateSelected(90) },
        copy, dup,
        { sep: true },
        fwd, back, lockItem,
      ];
    }
    if (info.target === 'shape') {
      return [
        copy, dup,
        { sep: true },
        { label: 'Fill Color…', on: showInspector },
        { label: 'Border Color…', on: showInspector },
        { label: 'Border Width…', on: showInspector },
        { label: 'Opacity…', on: showInspector },
        { sep: true },
        fwd, back, lockItem,
        { sep: true },
        del,
      ];
    }
    // Empty canvas.
    return [
      { label: 'Paste', key: 'Ctrl+V', disabled: !info.hasClipboard, on: () => engine.pasteClipboard() },
      { sep: true },
      { label: 'Add Text', on: () => engine.addTextAt() },
      { label: 'Add Image', on: () => engine.addImageAt() },
      { label: 'Add Shape', on: () => engine.addShapeAt() },
      { sep: true },
      { label: 'Select All', key: 'Ctrl+A', on: () => engine.selectAll() },
      { sep: true },
      { label: 'Zoom In', on: () => engine.zoomIn() },
      { label: 'Zoom Out', on: () => engine.zoomOut() },
      { label: 'Fit Page', on: () => engine.fit() },
      { sep: true },
      { label: 'Undo', key: 'Ctrl+Z', disabled: !info.canUndo, on: () => engine.undo() },
      { label: 'Redo', key: 'Ctrl+Y', disabled: !info.canRedo, on: () => engine.redo() },
    ];
  }

  /* --------------------------- left panel ------------------------------- */
  const thumbs = el('div', { class: 'bpx-thumbs' });
  const pagesPanel = el('div', { class: 'bpx-pages' }, [
    el('div', { class: 'bpx-ptabs' }, [
      el('button', { class: 'bpx-ptab is-active', type: 'button' }, 'Pages'),
    ]),
    el('div', { class: 'bpx-psearch' }, [
      el('span', { class: 'bpx-psearch__ico', html: renderIcon('search') }),
      el('input', { class: 'bpx-psearch__in', type: 'text', placeholder: 'Search pages' }),
      el('button', { class: 'bpx-psearch__btn', type: 'button', 'aria-label': 'Reorder', html: renderIcon('reorder') }),
    ]),
    thumbs,
    el('div', { class: 'bpx-pfoot' }, [
      el('button', { class: 'bpx-addpage', type: 'button', onClick: () => engine.addPage() }, [el('span', { html: renderIcon('plus') }), 'Add Page']),
      el('button', { class: 'bpx-pdel', type: 'button', 'aria-label': 'Delete page', html: renderIcon('delete-pages'), onClick: () => engine.deletePage() }),
    ]),
  ]);
  /* --- Stamp library (an on-screen picker; opened by the Stamp button or a
     right-click while Stamp mode is active — no left sidebar panel). --- */
  const customStamps = []; // stamps the user adds this session
  let stampCat = 'all';    // active category filter (shared across opens)
  let stampMode = false;   // Stamp tool armed → right-click opens the picker

  function stampThumb(def, onPick) {
    return el('button', {
      class: 'bpx-stamp-item', type: 'button', title: def.text, draggable: 'true',
      onClick: () => onPick(def),
      onDragStart: (e) => {
        e.dataTransfer.setData('application/x-dm-stamp', JSON.stringify(def));
        e.dataTransfer.effectAllowed = 'copy';
      },
    }, el('span', { class: 'bpx-stamp-item__art', html: stampSvgMarkup(def) }));
  }

  // Build the picker's inner UI (search + category tabs + grid + add-custom),
  // wired to a `pick(def)` callback. Rebuilt fresh each time the picker opens.
  function buildStampPickerBody(pick) {
    let query = '';
    const grid = el('div', { class: 'bpx-stamp-picker__grid' });
    const tabsEl = el('div', { class: 'bpx-stamps__tabs' });
    const allCats = () => STAMP_CATEGORIES.concat(customStamps.length ? [{ id: 'custom', name: 'Custom', stamps: customStamps }] : []);
    const renderGrid = () => {
      const q = query.trim().toLowerCase();
      const defs = allCats()
        .filter((c) => stampCat === 'all' || c.id === stampCat)
        .flatMap((c) => c.stamps)
        .filter((d) => !q || d.text.toLowerCase().includes(q));
      grid.replaceChildren(...(defs.length
        ? defs.map((d) => stampThumb(d, pick))
        : [el('div', { class: 'bpx-stamps__empty' }, 'No stamps match your search.')]));
    };
    const renderTabs = () => {
      const cats = [{ id: 'all', name: 'All' }, ...STAMP_CATEGORIES.map((c) => ({ id: c.id, name: c.name })),
        ...(customStamps.length ? [{ id: 'custom', name: 'Custom' }] : [])];
      tabsEl.replaceChildren(...cats.map((c) => el('button', {
        class: `bpx-stamps__tab${c.id === stampCat ? ' is-active' : ''}`, type: 'button',
        onClick: () => { stampCat = c.id; renderTabs(); renderGrid(); },
      }, c.name)));
    };
    const addCustom = () => {
      const text = (window.prompt('Custom stamp text', '') || '').trim();
      if (!text) return;
      const def = makeStampDef(text.toUpperCase(), 'double', '#dc2626');
      customStamps.unshift(def);
      stampCat = 'custom';
      renderTabs(); renderGrid();
      pick(def);
    };
    const search = el('input', { class: 'bpx-psearch__in', type: 'text', placeholder: 'Search stamps…',
      onInput: (e) => { query = e.target.value; renderGrid(); } });
    renderTabs(); renderGrid();
    return el('div', { class: 'bpx-stamp-picker__body' }, [
      el('div', { class: 'bpx-stamp-picker__head' }, 'Choose a stamp'),
      el('div', { class: 'bpx-psearch' }, [el('span', { class: 'bpx-psearch__ico', html: renderIcon('search') }), search]),
      tabsEl,
      grid,
      el('div', { class: 'bpx-pfoot' }, [
        el('button', { class: 'bpx-addpage', type: 'button', onClick: addCustom },
          [el('span', { html: renderIcon('plus') }), 'Add Custom Stamp']),
      ]),
    ]);
  }

  // Open the picker either at the cursor (right-click) or centred over the canvas
  // (Stamp button). Picking a stamp drops it and leaves Stamp mode armed so the
  // user can right-click again to place more.
  function openStampPicker(pos) {
    closeContextMenu(); closeShapeMenu();
    const atCursor = pos && pos.clientX != null;
    const pick = (def) => {
      closeContextMenu();
      if (atCursor) engine.insertStampAtClient(def, pos.clientX, pos.clientY);
      else engine.insertStamp(def);
      // Don't force the Properties panel open — it only appears when the user
      // clicks Properties. Selecting the new stamp still refreshes it if it's open.
    };
    ctxMenu = el('div', {
      class: `bpx-stamp-picker${rootEl.classList.contains('is-dark') ? ' is-dark' : ''}`, role: 'dialog',
      onContextmenu: (e) => e.preventDefault(),
    }, buildStampPickerBody(pick));
    document.body.appendChild(ctxMenu);
    const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
    let x, y;
    if (atCursor) { x = pos.clientX; y = pos.clientY; }
    else { const r = canvasSlot.getBoundingClientRect(); x = r.left + r.width / 2 - mw / 2; y = r.top + r.height / 2 - mh / 2; }
    x = Math.min(x, window.innerWidth - mw - 8);
    y = Math.min(y, window.innerHeight - mh - 8);
    ctxMenu.style.left = `${Math.max(8, x)}px`;
    ctxMenu.style.top = `${Math.max(8, y)}px`;
    setTimeout(() => document.addEventListener('pointerdown', onCtxOutside, true), 0);
  }

  function setStampMode(on) {
    stampMode = on;
    toolbar.querySelector('.bpx-tool[data-id="stamp"]')?.classList.toggle('is-active', on);
    if (!on) closeContextMenu();
  }
  function toggleStampMode() {
    // Toggle on the PICKER's visibility, not on the armed flag. Placing a stamp
    // leaves Stamp mode armed (so right-click can drop more), which previously
    // made the next button click merely disarm it — so the picker couldn't be
    // reopened without a second click. Now the button always reopens the picker
    // when it's closed, and closes it when it's open.
    const pickerOpen = !!ctxMenu && ctxMenu.classList.contains('bpx-stamp-picker');
    if (pickerOpen) { setStampMode(false); return; }
    setStampMode(true);
    openStampPicker(); // centred over the canvas so the stamps show immediately
    bus.emit('toast', 'Pick a stamp, then right-click the page to place more.');
  }

  const leftPanel = el('aside', { class: 'bpx-left' }, [pagesPanel]);

  /* -------------------- right-side PDF tools rail ---------------------- */
  // Every PDF tool, always visible on the right of the canvas. Each routes
  // through the same `pdf-tool` channel the home cards use (index.js decides
  // what each does), so behaviour stays consistent in one place.
  const PDF_FEATURES = [
    { label: 'Merge', arg: 'merge', icon: 'merge' },
    { label: 'Split', arg: 'split', icon: 'split' },
    { label: 'Rotate', arg: 'rotate', icon: 'rotate' },
    { label: 'Image → PDF', arg: 'image-to-pdf', icon: 'image' },
    { label: 'Extract Pages', arg: 'extract-pages', icon: 'layers' },
    { label: 'Organize Pages', arg: 'organize-pages', icon: 'reorder' },
  ];
  const featuresPanel = el('aside', { class: 'bpx-features' }, [
    el('div', { class: 'bpx-features__head' }, 'PDF Tools'),
    el('div', { class: 'bpx-features__list' },
      PDF_FEATURES.map((f) => el('button', {
        class: 'bpx-feature', type: 'button', title: f.label,
        onClick: () => runPdfTool(f.arg),
      }, [
        el('span', { class: 'bpx-feature__ico', html: renderIcon(f.icon) }),
        el('span', { class: 'bpx-feature__lbl' }, f.label),
      ]))
    ),
  ]);

  /* ------------------------- PDF tool handlers -------------------------- */
  // Shared helpers. All tools operate on the SAME in-editor model + export
  // pipeline (renderPageCanvas / exportEditorToPdf), so results are WYSIWYG.
  function baseName() { return (docName || 'document').replace(/\.[^.]+$/, ''); }
  function outName(suffix) { return `${baseName()}-${suffix}.pdf`; }
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function pickFiles(accept, multiple, onPick) {
    const input = el('input', { type: 'file', accept, multiple: multiple ? 'multiple' : null, style: 'position:fixed;left:-9999px' });
    document.body.appendChild(input);
    input.addEventListener('change', () => { const files = Array.from(input.files || []); input.remove(); if (files.length) onPick(files); });
    input.click();
  }
  // "Has content" == "the export would actually paint something". Object COUNT
  // is not enough: an empty text box / unrevealed imported run / draw / link all
  // composite to nothing, so counting them would still hand the user a blank PDF.
  const modelHasContent = modelHasVisibleContent;
  // Parse "1,3,5-7" into zero-based, de-duplicated, in-range page indices.
  function parsePageList(str, count) {
    const set = new Set();
    for (const part of String(str).split(',')) {
      const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!m) continue;
      let a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
      if (a > b) [a, b] = [b, a];
      for (let n = a; n <= b; n += 1) if (n >= 1 && n <= count) set.add(n - 1);
    }
    return [...set].sort((x, y) => x - y);
  }
  // Image → PDF resolution presets. The long edge is capped and the image is
  // re-encoded: a fuller cap keeps more detail at the cost of a larger file and a
  // heavier editor (huge photos decoded at full resolution can freeze it, which is
  // why even "Maximum" keeps a safe ceiling). Higher presets also use less JPEG
  // compression. Transparency (PNG) is preserved regardless.
  const IMG_RES = [
    { id: 'standard', label: 'Standard', maxDim: 1600, quality: 0.82 },
    { id: 'high', label: 'High', maxDim: 2400, quality: 0.92 },
    { id: 'max', label: 'Maximum', maxDim: 3000, quality: 0.95 },
  ];
  const DEFAULT_IMG_RES = 'high'; // don't lose visible quality by default
  const imgPreset = (id) => IMG_RES.find((p) => p.id === id) || IMG_RES[1];

  // Read an image file → a data URL at the given resolution preset and rotation
  // (0/90/180/270°, clockwise). Keeps the source `file` so the tray can RE-encode
  // it losslessly when the resolution or rotation changes (never compounding JPEG
  // generations). Returns null if the file can't be decoded.
  function loadImageItem(file, preset, rot = 0) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => {
        const img = new Image();
        img.onload = () => {
          const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
          const sc = Math.min(preset.maxDim / Math.max(w, h), 1);
          const dw = Math.max(1, Math.round(w * sc)), dh = Math.max(1, Math.round(h * sc));
          const swap = rot === 90 || rot === 270;
          const c = document.createElement('canvas');
          c.width = swap ? dh : dw; c.height = swap ? dw : dh;
          const x = c.getContext('2d');
          x.translate(c.width / 2, c.height / 2);
          x.rotate((rot * Math.PI) / 180);
          x.drawImage(img, -dw / 2, -dh / 2, dw, dh);
          const mime = /^data:image\/png/i.test(r.result) ? 'image/png' : 'image/jpeg';
          resolve({ file, rot, src: c.toDataURL(mime, preset.quality), w: c.width, h: c.height });
        };
        img.onerror = () => resolve(null);
        img.src = r.result;
      };
      r.onerror = () => resolve(null);
      r.readAsDataURL(file);
    });
  }

  async function runPdfTool(arg) {
    try {
      if (arg === 'merge') return mergePdf();
      if (arg === 'split') return splitPdf();
      if (arg === 'rotate') return rotatePage();
      if (arg === 'image-to-pdf') return imageToPdf();
      if (arg === 'extract-pages') return extractPages();
      if (arg === 'organize-pages') return organizePages();
    } catch (err) {
      console.error('[pdf-tool]', arg, err);
      setLoading(false);
      bus.emit('toast', 'Sorry — that action could not be completed.');
    }
  }

  function mergePdf() {
    pickFiles('application/pdf', true, async (files) => {
      setLoading(true, 'Merging…');
      let added = 0;
      for (const f of files) {
        try { const doc = await renderPdfToPages(f); added += engine.appendImportedDoc(doc) || 0; }
        catch (e) { console.error('[merge]', e); }
      }
      setLoading(false);
      bus.emit('toast', added ? `Merged ${added} page${added > 1 ? 's' : ''} into this document.` : 'Nothing could be merged.');
    });
  }


  async function extractPages() {
    if (!modelHasContent(engine.getExportModel())) return bus.emit('toast', 'Nothing to extract yet — add or open a PDF first.');
    const n = engine.getPageCount();
    const input = window.prompt(`Which pages to extract? (1–${n}, e.g. 1,3,5-7)`, `1-${n}`);
    if (input == null) return;
    const idxs = parsePageList(input, n);
    if (!idxs.length) return bus.emit('toast', 'No valid pages in that range.');
    setLoading(true, 'Extracting…');
    const blob = await exportEditorToPdf(engine.getExportModel(), { pageIndices: idxs });
    setLoading(false);
    downloadBlob(blob, outName('extract'));
    bus.emit('toast', `Extracted ${idxs.length} page${idxs.length > 1 ? 's' : ''}.`);
  }

  async function splitPdf() {
    if (!modelHasContent(engine.getExportModel())) return bus.emit('toast', 'Nothing to split yet — add or open a PDF first.');
    const n = engine.getPageCount();
    if (n < 2) return bus.emit('toast', 'Add more pages before splitting.');
    const at = parseInt(window.prompt(`Split AFTER which page? (1–${n - 1})`, String(Math.ceil(n / 2))), 10);
    if (!at || at < 1 || at >= n) return bus.emit('toast', `Enter a page number between 1 and ${n - 1}.`);
    setLoading(true, 'Splitting…');
    const model = engine.getExportModel();
    const first = Array.from({ length: at }, (_, i) => i);
    const rest = Array.from({ length: n - at }, (_, i) => i + at);
    const b1 = await exportEditorToPdf(model, { pageIndices: first });
    const b2 = await exportEditorToPdf(model, { pageIndices: rest });
    setLoading(false);
    downloadBlob(b1, outName('part1'));
    downloadBlob(b2, outName('part2'));
    bus.emit('toast', `Split into 2 files (${at} + ${n - at} pages).`);
  }

  // Image → PDF: images are shown as a selectable tray over the workspace (NOT
  // added as document pages). The user clicks them in the order they want; each
  // pick shows an order badge. "Create PDF" exports those images, in that order.
  let imgTray = null;
  function closeImgTray() { imgTray?.root.remove(); imgTray = null; }
  function imageToPdf() {
    pickFiles('image/*', true, async (files) => {
      setLoading(true, 'Loading images…');
      const preset = imgPreset(DEFAULT_IMG_RES);
      const images = [];
      for (const f of files) { const it = await loadImageItem(f, preset, 0); if (it) images.push(it); }
      setLoading(false);
      if (!images.length) return bus.emit('toast', 'No images could be loaded.');
      openImgTray(images);
    });
  }
  function openImgTray(images) {
    closeImgTray();
    const order = []; // indices, in the order the user selected them
    let res = DEFAULT_IMG_RES; // current resolution preset id
    let reencoding = false;
    const grid = el('div', { class: 'bpx-tray__grid' });
    const createBtn = el('button', { class: 'bpx-tray__create', type: 'button', disabled: 'disabled', onClick: () => createPdfFromImages(order.map((i) => images[i])) }, 'Create PDF');
    const hint = el('span', { class: 'bpx-tray__count' }, '0 selected');
    // Rotate ONE image 90° clockwise: re-encode it FROM THE ORIGINAL FILE at the
    // current resolution with the accumulated angle, so rotating never compounds
    // JPEG loss. Keeps its selection/order — only the pixels change.
    const rotateTrayImage = async (i) => {
      const im = images[i];
      if (!im || !im.file) return;
      const it = await loadImageItem(im.file, imgPreset(res), ((im.rot || 0) + 90) % 360);
      if (it) { images[i] = it; rebuild(); }
    };
    // Switch resolution: re-encode every image from its source file at the new
    // preset (keeping each image's rotation). Selection order is preserved because
    // items are replaced in place.
    const setRes = async (id) => {
      if (id === res || reencoding) return;
      res = id;
      for (const b of resRow.querySelectorAll('.bpx-tray__res-opt')) b.classList.toggle('is-on', b.dataset.res === id);
      reencoding = true;
      setLoading(true, 'Applying resolution…');
      const preset = imgPreset(id);
      for (let i = 0; i < images.length; i += 1) {
        if (!images[i] || !images[i].file) continue;
        const it = await loadImageItem(images[i].file, preset, images[i].rot || 0);
        if (it) images[i] = it;
      }
      setLoading(false);
      reencoding = false;
      rebuild();
    };
    const resRow = el('div', { class: 'bpx-tray__res' }, [
      el('span', { class: 'bpx-tray__res-lbl' }, 'Resolution'),
      ...IMG_RES.map((p) => el('button', {
        class: `bpx-tray__res-opt${p.id === res ? ' is-on' : ''}`, type: 'button', 'data-res': p.id,
        title: `Long edge up to ${p.maxDim}px`, onClick: () => setRes(p.id),
      }, p.label)),
    ]);
    const rebuild = () => {
      grid.replaceChildren(...images.map((im, i) => {
        const pos = order.indexOf(i);
        const badge = el('span', { class: 'bpx-tray__badge' }, pos >= 0 ? String(pos + 1) : '');
        const rotBtn = el('button', {
          class: 'bpx-tray__rot', type: 'button', title: 'Rotate 90°', 'aria-label': 'Rotate image',
          html: renderIcon('rotate'),
          onClick: (e) => { e.stopPropagation(); rotateTrayImage(i); },
        });
        const item = el('div', {
          class: `bpx-tray__item${pos >= 0 ? ' is-selected' : ''}`, title: 'Click to select / deselect',
          onClick: () => {
            const at = order.indexOf(i);
            if (at >= 0) order.splice(at, 1); else order.push(i);
            rebuild();
          },
        }, [el('img', { class: 'bpx-tray__img', src: im.src, alt: '', draggable: 'false' }), badge, rotBtn]);
        return item;
      }));
      const n = order.length;
      hint.textContent = `${n} selected`;
      if (n) createBtn.removeAttribute('disabled'); else createBtn.setAttribute('disabled', 'disabled');
    };
    rebuild();
    const addMore = el('button', { class: 'bpx-tray__btn', type: 'button', onClick: () => {
      pickFiles('image/*', true, async (files) => {
        setLoading(true, 'Loading images…');
        const preset = imgPreset(res);
        for (const f of files) { const it = await loadImageItem(f, preset, 0); if (it) images.push(it); }
        setLoading(false); rebuild();
      });
    } }, 'Add more');
    const selectAll = el('button', { class: 'bpx-tray__btn', type: 'button', onClick: () => { order.length = 0; images.forEach((_, i) => order.push(i)); rebuild(); } }, 'Select all');
    const root = el('div', { class: 'bpx-tray' }, [
      el('div', { class: 'bpx-tray__head' }, [
        el('span', { class: 'bpx-tray__title' }, 'Image → PDF'),
        el('span', { class: 'bpx-tray__sub' }, 'Click images in the order you want them, then Create PDF.'),
        el('span', { class: 'bpx-tray__sp' }),
        hint,
        el('button', { class: 'bpx-tray__x', type: 'button', 'aria-label': 'Close', html: renderIcon('close'), onClick: () => closeImgTray() }),
      ]),
      grid,
      el('div', { class: 'bpx-tray__foot' }, [addMore, selectAll, resRow, el('span', { class: 'bpx-tray__sp' }), el('button', { class: 'bpx-tray__btn', type: 'button', onClick: () => closeImgTray() }, 'Cancel'), createBtn]),
    ]);
    imgTray = { root };
    canvasSlot.appendChild(root); // lives over the workspace, not the pages panel
  }
  // Turn the selected images into PAGES in this editor (in the chosen order) — it
  // does NOT download. The user reviews them on-screen and clicks Export to save.
  function createPdfFromImages(list) {
    if (!list.length) return;
    // If the document is still a single untouched blank page, drop it so the PDF
    // is just the images (no leading blank page).
    const model = engine.getExportModel();
    const docBlank = model.pages.length === 1 && !model.pages[0].bg && (!model.pages[0].objects || model.pages[0].objects.length === 0);
    const added = engine.appendImagePages(list);
    if (docBlank && added) engine.deletePage(0);
    engine.goToPage(0, true);
    closeImgTray();
    bus.emit('toast', added ? `Added ${added} image${added > 1 ? 's' : ''} as page${added > 1 ? 's' : ''}. Click Export to save the PDF.` : 'No images added.');
  }

  async function rotatePage() {
    const idx = engine.getPageIndex();
    const model = engine.getExportModel();
    const pg = model.pages[idx];
    if (!pg) return bus.emit('toast', 'No page to rotate.');
    setLoading(true, 'Rotating…');
    const { canvas } = await renderPageCanvas(pg, model, 2);
    // 90° clockwise: swap dimensions.
    const rc = document.createElement('canvas'); rc.width = canvas.height; rc.height = canvas.width;
    const rx = rc.getContext('2d'); rx.translate(rc.width, 0); rx.rotate(Math.PI / 2); rx.drawImage(canvas, 0, 0);
    const url = rc.toDataURL('image/jpeg', 0.92);
    const pw = pg.w || model.PW, ph = pg.h || model.PH;
    engine.replacePageRaster(idx, url, ph, pw); // note: swapped w/h
    setLoading(false);
    bus.emit('toast', 'Rotated page 90°.');
  }

  /* ----- Organize Pages dialog (reorder + delete) ----- */
  let organizeEl = null;
  function closeOrganize() { organizeEl?.remove(); organizeEl = null; }
  function organizePages() {
    closeOrganize();
    const list = el('div', { class: 'bpx-org__list' });
    const rebuild = () => {
      const thumbs = engine.getPageThumbs();
      list.replaceChildren(...thumbs.map((t) => {
        const thumb = el('div', { class: 'bpx-org__thumb' });
        if (t.bg) thumb.style.backgroundImage = `url("${t.bg}")`;
        const row = el('div', { class: 'bpx-org__row' }, [
          thumb,
          el('span', { class: 'bpx-org__num' }, `Page ${t.index + 1}`),
          el('span', { class: 'bpx-org__sp' }),
          el('button', { class: 'bpx-org__btn', type: 'button', title: 'Move up', disabled: t.index === 0 ? 'disabled' : null, html: renderIcon('chevron'), onClick: () => { engine.movePage(t.index, t.index - 1); rebuild(); } }),
          el('button', { class: 'bpx-org__btn bpx-org__btn--down', type: 'button', title: 'Move down', disabled: t.index === thumbs.length - 1 ? 'disabled' : null, html: renderIcon('chevron'), onClick: () => { engine.movePage(t.index, t.index + 1); rebuild(); } }),
          el('button', { class: 'bpx-org__btn bpx-org__btn--del', type: 'button', title: 'Delete page', html: renderIcon('close'), onClick: () => { engine.deletePage(t.index); rebuild(); } }),
        ]);
        return row;
      }));
    };
    rebuild();
    organizeEl = el('div', { class: `bpx-org${rootEl.classList.contains('is-dark') ? ' is-dark' : ''}`, onClick: (e) => { if (e.target === organizeEl) closeOrganize(); } }, [
      el('div', { class: 'bpx-org__dialog' }, [
        el('div', { class: 'bpx-org__head' }, [
          el('span', { class: 'bpx-org__title' }, 'Organize Pages'),
          el('button', { class: 'bpx-org__x', type: 'button', 'aria-label': 'Close', html: renderIcon('close'), onClick: () => closeOrganize() }),
        ]),
        list,
        el('div', { class: 'bpx-org__foot' }, [el('button', { class: 'bpx-org__done', type: 'button', onClick: () => closeOrganize() }, 'Done')]),
      ]),
    ]);
    document.body.appendChild(organizeEl);
  }

  /* --------------------------- right panel ------------------------------ */
  // A single, un-tabbed inspector: it shows EVERY property group for whatever is
  // selected, stacked in one scroll (each `heading` becomes a collapsible card).
  // No per-kind tabs — a shape shows all its shape controls, a text box all its
  // typography/paragraph/appearance controls, etc.
  const propsBody = el('div', { class: 'bpx-props__body' });
  const propsIcon = el('span', { class: 'bpx-props__ico', html: renderIcon('sliders') });
  const propsTitle = el('span', { class: 'bpx-props__title' }, 'Properties');
  const propHead = el('div', { class: 'bpx-props__head' }, [
    propsIcon, propsTitle,
    el('span', { class: 'bpx-ptabrow__sp' }),
    el('button', { class: 'bpx-props__close', type: 'button', 'aria-label': 'Close panel', html: renderIcon('close'), onClick: () => closeProps() }),
  ]);
  const rightPanel = el('aside', { class: 'bpx-props' }, [propHead, propsBody]);

  const ICON_BY_KIND = { text: 'text', image: 'image', shape: 'shapes', stamp: 'stamp', page: 'document', none: 'sliders' };

  function renderProps(descriptor) {
    const kind = descriptor?.kind || 'none';
    const provider = providersByKind[kind] || providersByKind.shape;
    propsTitle.textContent = descriptor?.label || provider.title || 'Properties';
    propsIcon.innerHTML = renderIcon(ICON_BY_KIND[kind] || 'sliders');
    const values = { ...(descriptor?.values || {}) };
    propsBody.replaceChildren(renderControls(provider.schema(descriptor || {}), {
      getValue: (k) => values[k],
      onChange: (k, v) => { values[k] = v; if (engine.hasSelection()) engine.applyProperty(provider.kind, k, v); },
      // Editor-local panel actions are handled straight on the engine (they need
      // the live selection); anything else bubbles to the app-level action bus.
      onAction: (a) => {
        if (a === 'replace-image') return engine.replaceImage();
        if (a === 'crop-image') return engine.cropImage();
        bus.emit('action', a);
      },
    }));
  }

  // Selecting text shows the top formatting bar. The right properties panel never
  // opens on its own — it only appears when the user clicks the Properties button
  // (toggleProps). Selection just refreshes its contents when it's already open.
  function onSelect(descriptor) {
    lastDescriptor = descriptor;
    if (descriptor && descriptor.kind === 'text') {
      syncFmtBar(descriptor.values);
      showFmtBar(true);
      if (propsOpen) renderProps(descriptor);
    } else if (descriptor) {
      showFmtBar(false);
      if (propsOpen) renderProps(descriptor);
    } else {
      showFmtBar(false);
      if (propsOpen) renderProps(null);
    }
  }

  /* ------------------------------ status -------------------------------- */
  const sizeSel = el('select', { class: 'bpx-sizesel', 'aria-label': 'Page size', onChange: (e) => engine.setPageSize(e.target.value) },
    ['A4', 'Letter', 'Legal'].map((s) => el('option', { value: s }, s)));
  const dimsEl = el('span', { class: 'bpx-dims' }, '21 × 29.7 cm');
  const pageInput = el('input', { class: 'bpx-pageno', type: 'text', value: '1', 'aria-label': 'Current page',
    onChange: (e) => { const n = parseInt(e.target.value, 10); if (n) engine.goToPage(n - 1); } });
  const pageTotal = el('span', { class: 'bpx-pagetotal' }, '1');
  const zoomRange = el('input', { class: 'bpx-zrange', type: 'range', min: '10', max: '300', value: '100', 'aria-label': 'Zoom',
    onInput: (e) => engine.setZoom(Number(e.target.value) / 100) });
  const zoomPct = el('span', { class: 'bpx-zpct' }, '100%');
  const wordsEl = el('span', { class: 'bpx-count' }, 'Words: 0');
  const charsEl = el('span', { class: 'bpx-count' }, 'Characters: 0');
  const darkBtn = el('button', { class: 'bpx-dark', type: 'button', 'aria-label': 'Toggle dark mode', html: renderIcon('moon'),
    onClick: () => rootEl.classList.toggle('is-dark') });

  const status = el('footer', { class: 'bpx-status' }, [
    el('div', { class: 'bpx-status__l' }, [
      el('span', { class: 'bpx-sizewrap' }, [sizeSel, el('span', { class: 'bpx-caret', html: renderIcon('chevron') })]),
      dimsEl,
    ]),
    el('div', { class: 'bpx-status__c' }, [
      el('button', { class: 'bpx-pnav', type: 'button', 'aria-label': 'Previous page', html: renderIcon('chevron'), onClick: () => engine.goToPage(engine.getPageIndex() - 1) }),
      el('span', { class: 'bpx-pageof' }, [pageInput, el('span', { class: 'bpx-pageof__sl' }, '/'), pageTotal]),
      el('button', { class: 'bpx-pnav bpx-pnav--next', type: 'button', 'aria-label': 'Next page', html: renderIcon('chevron'), onClick: () => engine.goToPage(engine.getPageIndex() + 1) }),
    ]),
    el('div', { class: 'bpx-status__r' }, [
      el('button', { class: 'bpx-zbtn', type: 'button', 'aria-label': 'Zoom out', html: renderIcon('minus'), onClick: () => engine.zoomOut() }),
      zoomRange,
      el('button', { class: 'bpx-zbtn', type: 'button', 'aria-label': 'Zoom in', html: renderIcon('plus'), onClick: () => engine.zoomIn() }),
      zoomPct,
      el('span', { class: 'bpx-status__div' }),
      wordsEl, charsEl,
      darkBtn,
    ]),
  ]);

  /* ------------------------------- engine ------------------------------- */
  // Created now that every chrome element exists (onZoom/onDims fire on init).
  engine = createBlankPdfEditor({
    container: canvasSlot,
    onSelect,
    onHistory: ({ canUndo, canRedo }) => { undoBtn.disabled = !canUndo; redoBtn.disabled = !canRedo; },
    onToolChange: syncTool,
    onZoom: syncZoom,
    onDirty: syncStats,
    onPages: syncPages,
    onDims: (d) => { dimsEl.textContent = d; },
    onWarn: (m) => bus.emit('toast', m),
    onContext: openContextMenu,
  });

  /* ------------------------------- root --------------------------------- */
  // The Pages panel starts hidden: a brand-new blank document has nothing to
  // navigate, so it only earns its column once a PDF is opened (loadPdf). A new
  // document hides it again. `is-nopages` also collapses the grid column so the
  // canvas reclaims the freed width instead of leaving a 220px gap.
  const body = el('div', { class: 'bpx-body is-nopages' }, [leftPanel, canvasSlot, featuresPanel, rightPanel]);
  const setPagesVisible = (on) => body.classList.toggle('is-nopages', !on);
  const rootEl = el('div', { class: 'bpx is-dark' }, [header, toolbar, body, status]);
  container.appendChild(rootEl);
  setTools(false); // PDF Tools panel starts closed; the Tools button opens it

  // Esc closes the context menu first, then the inspector.
  const onKeyDown = (e) => {
    if (e.key !== 'Escape') return;
    if (ctxMenu) { closeContextMenu(); return; }
    if (propsOpen) closeProps();
  };
  document.addEventListener('keydown', onKeyDown);

  // Initial sync
  syncTool('select');
  syncZoom(engine.getZoom());
  engine.onPagesReady();
  syncStats();
  renderProps(null);
  syncFmtBar({}); // seed the always-visible bar with sensible defaults
  requestAnimationFrame(() => engine.fit());

  /* --------------------------- sync helpers ----------------------------- */
  function syncTool(id) {
    // Leave the Properties toggle alone — its active state tracks the inspector.
    // The Stamp button tracks its library panel, not an engine tool, so keep it
    // lit while that panel is open (inserting a stamp flips the tool to select).
    toolbar.querySelectorAll('.bpx-tool').forEach((b) => {
      if (b.dataset.id === 'properties' || b.dataset.id === 'tools') return; // panel toggles, not engine tools
      if (b.dataset.id === 'stamp') { b.classList.toggle('is-active', stampMode); return; }
      b.classList.toggle('is-active', b.dataset.id === id);
    });
  }
  function syncZoom(z) {
    const pct = Math.round(z * 100);
    zoomPct.textContent = `${pct}%`;
    zoomRange.value = String(clamp(pct, 10, 300));
  }
  function syncPages({ count, index, pages }) {
    pageTotal.textContent = String(count);
    pageInput.value = String(index + 1);
    thumbs.replaceChildren(...Array.from({ length: count }, (_, i) => {
      const bg = pages?.[i]?.bg;
      const pg = el('span', { class: 'bpx-thumb__pg' });
      if (bg) pg.style.backgroundImage = `url("${bg}")`;
      const del = el('span', {
        class: 'bpx-thumb__del', role: 'button', tabindex: '0', title: 'Delete page',
        'aria-label': `Delete page ${i + 1}`, html: renderIcon('close'),
        onClick: (e) => { e.stopPropagation(); engine.deletePage(i); },
      });
      return el('button', {
        class: `bpx-thumb${i === index ? ' is-active' : ''}${bg ? ' has-bg' : ''}`, type: 'button', 'aria-label': `Page ${i + 1}`,
        onClick: () => engine.goToPage(i),
      }, [pg, el('span', { class: 'bpx-thumb__no' }, String(i + 1)), del]);
    }));
  }
  function syncStats() {
    const s = engine.stats();
    wordsEl.textContent = `Words: ${s.words}`;
    charsEl.textContent = `Characters: ${s.chars}`;
  }

  /* ----------------------------- documents ------------------------------ */
  let docName = 'Untitled.pdf';
  function setDocName(name) { if (name) { docName = name; tabName.textContent = name; } }
  function setLoading(on, text) {
    loadingEl.hidden = !on;
    if (text) loadingEl.querySelector('.bpx-loading__txt').textContent = text;
  }

  /** Import a PDF: render its pages and load them as editable backgrounds. */
  async function loadPdf(file) {
    setLoading(true, 'Opening PDF…');
    try {
      const doc = await renderPdfToPages(file, (d, t) => setLoading(true, `Opening PDF… ${d}/${t}`));
      engine.loadDocument(doc);
      setDocName(doc.name);
      setPagesVisible(true); // a real PDF is loaded — reveal the Pages panel
      // Tell the user up front when a PDF is scanned (no text layer) — its text
      // is pixels, so it can't be edited as text.
      if (doc.scanned) bus.emit('toast', 'This PDF looks scanned — its text is an image, so it can’t be edited as text.');
    } catch (err) {
      console.error('[blank-pdf import]', err);
      bus.emit('toast', 'Sorry — that PDF could not be opened.');
    } finally {
      setLoading(false);
    }
  }

  /** Import an image: a fresh page with the image placed on it. */
  function loadImage(file) {
    engine.newDocument();
    engine.addImageFromFile(file);
    setDocName(file.name);
  }

  /* -------------------------------- api --------------------------------- */
  return {
    rootEl,
    engine,
    setActive(on) { engine.setActive(on); if (on) requestAnimationFrame(() => engine.fit()); },
    focus: () => engine.focus(),
    loadPdf,
    loadImage,
    newDocument: () => { engine.newDocument(); setDocName('Untitled.pdf'); setPagesVisible(false); },
    setDocName,
    stats: () => engine.stats(),
    exportPdf: () => {
      const model = engine.getExportModel();
      // A document that would composite to nothing (no page raster and no object
      // that actually paints — e.g. only empty text boxes) exports as silent white
      // pages, which reads as a broken "empty PDF" download. Stop and tell the user
      // instead of handing them a blank file. `modelHasVisibleContent` mirrors the
      // exporter's own draw rules, so this stays in sync with what really renders.
      if (!modelHasContent(model)) {
        bus.emit('toast', 'Nothing to export yet — add text, an image, a shape or a stamp first.');
        return null;
      }
      return exportEditorToPdf(model);
    },
    // Save the whole editable document to a local .dmz project (a DEFLATE zip of
    // the DocumentModel — pages, layer objects, raster backgrounds, images — all
    // client-side, never the server). Reopened losslessly by openProject. This is
    // the "keep documents in browser memory" persistence.
    async saveProject() {
      const doc = engine.getDocumentModel();
      const bytes = await packProject(doc, null);
      downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), `${baseName()}.dmz`);
      bus.emit('toast', 'Project saved (.dmz).');
    },
    openProject() {
      pickFiles('.dmz', false, async (files) => {
        try {
          const buf = new Uint8Array(await files[0].arrayBuffer());
          const { model } = await unpackProject(buf);
          engine.loadFromModel(model);
          setDocName(`${files[0].name.replace(/\.dmz$/i, '')}.pdf`);
          setPagesVisible(true); // a saved project can be multi-page — show Pages
          bus.emit('toast', 'Project opened.');
        } catch {
          bus.emit('toast', 'Could not open that project file.');
        }
      });
    },
    destroy() { closeShapeMenu(); closeContextMenu(); closeOrganize(); closeImgTray(); closeExportMenu(); exportPanel?.destroy(); document.removeEventListener('keydown', onKeyDown); engine.destroy(); rootEl.remove(); },
  };

  function iconBtn(icon, label, onClick) {
    return el('button', { class: 'bpx-iconbtn', type: 'button', 'aria-label': label, title: label, html: renderIcon(icon), onClick });
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** A native <input type=color> needs a 6-digit hex; fall back to the ink colour. */
function normHex(c) { return /^#[0-9a-fA-F]{6}$/.test(c || '') ? c : '#111827'; }

/** Inline alignment glyphs (no dedicated icons in the shared set). */
function alignSvg(v) {
  const lines = {
    left: ['M4 6h16', 'M4 10h9', 'M4 14h16', 'M4 18h9'],
    center: ['M4 6h16', 'M7 10h10', 'M4 14h16', 'M7 18h10'],
    right: ['M4 6h16', 'M11 10h9', 'M4 14h16', 'M11 18h9'],
    justify: ['M4 6h16', 'M4 10h16', 'M4 14h16', 'M4 18h16'],
  }[v];
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${lines.map((d) => `<path d="${d}"/>`).join('')}</svg>`;
}
