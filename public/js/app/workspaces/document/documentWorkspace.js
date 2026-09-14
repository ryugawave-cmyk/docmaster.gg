/**
 * Document workspace — a Word / Google-Docs style rich-text editor.
 *
 * This is a SEPARATE editing surface from the PDF workspace. Where the PDF
 * workspace annotates positioned pages (`blankEditorShell.js`), this one edits a
 * flowing document — headings, paragraphs, lists, tables and images — on a
 * `contentEditable` page via `editor/documentEditor.js`.
 *
 * The two editors deliberately share the Unified Document Model
 * (`model/documentModel.js`): the same block/run structure the PDF importer can
 * build is what this editor renders, edits and exports (DOCX / PDF / HTML). Only
 * the UI and tools differ.
 */
import { el } from '../../../workspace/utils/dom.js';
import { renderIcon } from '../../../workspace/icons.js';
import { selection, emptySelection, SelectionKind } from '../../core/selection.js';
import { createDocumentEditor } from '../../editor/documentEditor.js';
import { createBlankDocument, createDocument, createParagraph, createRun, documentToText } from '../../model/documentModel.js';
import { blockModelToDocx, blockModelToPdf, htmlBlob } from '../../services/convert/blockExport.js';
import { docxToBlockModel } from '../../services/convert/docxImport.js';
import { createDocExportPanel } from './docExportPanel.js';
import { openShapePicker } from './docShapePicker.js';
import { openStampPicker } from './docStampPicker.js';
import { stampSvgMarkup } from '../../editor/stampLibrary.js';
import { openChartPicker } from './chartPicker.js';
import { defaultChart } from '../../editor/chartRender.js';
import { openCalculator } from '../../editor/calculator.js';
import { openSymbolLibrary } from '../../editor/symbolLibrary.js';
import { FONT_OPTIONS } from '../../properties/index.js';

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64];

export function createDocumentWorkspace({ bus, store, services }) {
  let root = null;
  let menubarEl = null;
  let toolbarEl = null;
  let rulerEl = null;
  let outlineEl = null;
  let hostEl = null;
  let editor = null;
  let docZoom = 1; // page zoom factor (mirrors editor zoom; scales the ruler too)
  let hasDoc = false;
  let advExportPanel = null; // lazily-built Advanced Export modal
  let outlineOpen = true; // left "tabs & outline" panel open by default
  const ui = {}; // references to toolbar controls we reflect selection state into

  /* -------------------------------- mount ------------------------------- */
  function mount(container) {
    root = el('div', { class: 'app-ws app-ws--document' });
    container.appendChild(root);
    services.fileManager.enableDropZone(root, (files) => bus.emit('file:dropped', files));
    renderEmpty();
  }

  // Enter the dedicated word-processor layout (own menu/format bars; shared
  // toolbar/nav/panel hidden, status bar kept) only while a document is open.
  // The empty "create or open" screen keeps the normal shell so the nav is
  // reachable. Restored on deactivate / when the document is closed.
  function setDocMode(on) {
    store.setState({ docMode: on });
  }

  function renderEmpty() {
    hasDoc = false;
    setDocMode(false);
    root.replaceChildren(
      el('div', { class: 'app-drop' }, [
        el('span', { class: 'app-drop__icon', html: renderIcon('new-doc') }),
        el('h2', { class: 'app-drop__title' }, 'Create or open a document'),
        el('p', { class: 'app-drop__lead' }, 'Write from a blank page, or open a Word (.docx), text or Markdown file.'),
        el('div', { class: 'app-drop__actions' }, [
          el('button', { class: 'ws-btn ws-btn--lg ws-btn--accent', type: 'button', onClick: () => newBlank() }, 'New document'),
          el('button', { class: 'ws-btn ws-btn--lg', type: 'button', onClick: () => bus.emit('nav:command', { command: 'open', arg: 'document' }) }, 'Open document'),
        ]),
      ])
    );
  }

  /* --------------------------- editor scaffold -------------------------- */
  function ensureEditor() {
    if (editor) return editor;
    // A Word / Google-Docs style stack: a menu bar, then a single formatting
    // toolbar, then the scrolling page host. The document page is the focus.
    menubarEl = el('div', { class: 'doc-menubar', role: 'menubar', 'aria-label': 'Menus' });
    buildMenuBar(menubarEl);
    toolbarEl = el('div', { class: 'doc-toolbar', role: 'toolbar', 'aria-label': 'Formatting' });
    buildToolbar(toolbarEl);
    // Left "tabs & outline" panel (Google-Docs style), collapsible.
    outlineEl = el('div', { class: 'doc-outline is-open' });
    buildOutline(outlineEl);
    // Horizontal ruler bar (kept visible above the page); its measured region and
    // draggable margin markers mirror the page geometry.
    rulerEl = el('div', { class: 'doc-rulerbar', 'aria-hidden': 'true' });
    hostEl = el('div', { class: 'doc-host' });
    // Floating zoom control at the page's bottom-right (the shell's zoom lives in
    // the top toolbar, which is hidden in doc mode — so the editor carries its own).
    const zoomCtl = mkZoomControl();
    // Body row: [outline | main(ruler + page)] so the ruler sits above the page
    // only, with the outline panel spanning the full height to its left.
    const main = el('div', { class: 'doc-main' }, [rulerEl, hostEl, zoomCtl]);
    ui.docMain = main; // AI Assistant panel docks at the bottom of this column
    ui.docBody = el('div', { class: 'doc-body' }, [outlineEl, main]);
    root.replaceChildren(menubarEl, toolbarEl, ui.docBody);
    // Restore the remembered theme preference for the document editor.
    try { if (localStorage.getItem('alvion:doc-theme') === 'dark') setDark(true); } catch (e) { /* noop */ }
    editor = createDocumentEditor({
      container: hostEl,
      onChange: ({ canUndo, canRedo }) => { store.setState({ canUndo, canRedo }); refreshOutline(); },
      onSelection: reflectSelection,
      // Keep the shell's page counter in sync with the real laid-out pages (the
      // editor reports this after every pagination pass and on scroll).
      onPaginate: ({ pageCount, currentPage }) => store.setState({ totalPages: pageCount, currentPage }),
      // The header/footer "Options ▾ · Header & footer settings" opens our dialog.
      onRequestHfSettings: () => openHfSettings(),
    });
    return editor;
  }

  function loadDoc(doc, name) {
    ensureEditor();
    editor.load(doc);
    editor.setEditable(true);
    hasDoc = true;
    setDocMode(true);
    docZoom = editor.setZoom(1); // fresh document opens at 100%
    store.setState({
      file: { name, size: 0, type: 'application/vnd.docmaster.doc' },
      docName: name,
      // totalPages / currentPage are set by the editor's onPaginate callback,
      // which already fired during editor.load() above with the real page count.
      zoom: 1,
      // The properties panel stays hidden by default — all common formatting
      // now lives in the single top toolbar (Word/Docs feel).
      panelOpen: false,
      status: 'ready',
      statusMessage: 'Ready',
      canUndo: false,
      canRedo: false,
    });
    if (ui.docName) ui.docName.textContent = name;
    renderRuler();
    refreshOutline();
    bus.emit('selection:change', textSelection());
    requestAnimationFrame(() => editor.focus());
  }

  function newBlank() {
    loadDoc(createBlankDocument('Untitled document'), 'Untitled document');
  }

  /* ------------------------------- menu bar ----------------------------- */
  // A Word / Google-Docs style menu bar: File · Edit · View · Insert · Format ·
  // Tools. Each opens a popover of real actions (the menus route to the same
  // editor + export/save code the toolbar uses). One menu is open at a time and
  // hovering another top item switches to it, like a native menu bar.
  let openMenu = null; // { el, btn }
  let toolbarHidden = false;
  let highlightColor = '#ffe64d'; // current highlighter (marker) colour
  let highlightOn = false; // is the caret/selection currently highlighted?

  // ----- Dark theme toggle (mirrors the PDF editor's dark mode) -----------
  // Toggles `.is-dark` on the document root; the palette lives in app.css. The
  // choice is remembered per device. The page itself stays white paper.
  function setDark(on) {
    if (!root) return;
    root.classList.toggle('is-dark', !!on);
    if (ui.themeToggle) {
      ui.themeToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      ui.themeToggle.classList.toggle('is-on', !!on);
    }
    try { localStorage.setItem('alvion:doc-theme', on ? 'dark' : 'light'); } catch (e) { /* storage blocked */ }
  }
  function mkThemeToggle() {
    ui.themeToggle = el('button', {
      class: 'doc-btn doc-menubar__theme', type: 'button',
      'data-tip': 'Toggle dark mode', 'aria-label': 'Toggle dark mode', 'aria-pressed': 'false',
      onClick: () => setDark(!root.classList.contains('is-dark')),
    }, el('span', { class: 'doc-btn__ico', html: renderIcon('moon') }));
    return ui.themeToggle;
  }

  function buildMenuBar(bar) {
    const brand = el('button', {
      class: 'doc-menubar__brand', type: 'button', 'data-tip': 'Close document',
      'aria-label': 'Close document and go home', onClick: backHome,
    }, el('span', { class: 'doc-menubar__logo' }, [el('img', { class: 'doc-menubar__logo-img', src: '/images/logo-mark.png', alt: '' })]));
    ui.docName = el('span', { class: 'doc-menubar__title', title: 'Document name' }, store.getState().docName || 'Untitled document');

    bar.replaceChildren(
      el('div', { class: 'doc-menubar__left' }, [brand, ui.docName]),
      el('div', { class: 'doc-menubar__menus' }, [
        mkMenu('File', fileMenu),
        mkMenu('Edit', editMenu),
        mkMenu('View', viewMenu),
        mkMenu('Insert', insertMenu),
        mkMenu('Format', formatMenu),
        mkMenu('Tools', toolsMenu),
        // Quick-insert icons sit right after Tools, like the reference layout.
        el('div', { class: 'doc-menubar__insert' }, [
          mkTablePicker(),
          mkBtn('image', 'Insert image', pickImage),
          mkBtn('stamp', 'Insert stamp', insertStamp),
          mkBtn('chart', 'Professional Library — charts & graphs', openProLibrary),
        ]),
      ]),
      // Download lives at the top-right of the menu bar (pushed there via CSS).
      el('div', { class: 'doc-menubar__right' }, [mkThemeToggle(), mkAiAssistant(), mkExportMenu()]),
    );
  }

  // AI Assistant: a gradient-glow button at the top-right (next to Export) that
  // toggles a docked right-side assistant panel (see buildAiPanel).
  function mkAiAssistant() {
    ui.aiBtn = el('button', {
      class: 'doc-btn doc-ai-btn', type: 'button',
      'data-tip': 'AI Assistant', 'aria-label': 'AI Assistant', 'aria-pressed': 'false',
      onClick: () => toggleAiPanel(),
    }, [
      el('span', { class: 'doc-ai-btn__ico', html: renderIcon('sparkle') }),
      el('span', { class: 'doc-ai-btn__txt' }, 'AI Assistant'),
    ]);
    return ui.aiBtn;
  }

  /* ------------------------------ AI Assistant ------------------------------ */
  // A docked right-side panel: a chat surface plus quick actions that operate on the
  // current document. Built lazily on first open and reused thereafter.
  function toggleAiPanel() {
    if (!ui.aiPanel) buildAiPanel();
    const open = !root.classList.contains('is-ai-open');
    root.classList.toggle('is-ai-open', open);
    ui.aiBtn?.setAttribute('aria-pressed', open ? 'true' : 'false');
    ui.aiBtn?.classList.toggle('is-on', open);
    if (open) requestAnimationFrame(() => ui.aiInput?.focus());
  }
  function closeAiPanel() {
    root.classList.remove('is-ai-open');
    ui.aiBtn?.setAttribute('aria-pressed', 'false');
    ui.aiBtn?.classList.remove('is-on');
  }

  function buildAiPanel() {
    const msgs = el('div', { class: 'doc-ai__msgs', role: 'log', 'aria-live': 'polite' });
    ui.aiMsgs = msgs;
    const addMsg = (who, text) => {
      const bubble = el('div', { class: `doc-ai__msg doc-ai__msg--${who}` }, text);
      msgs.appendChild(bubble);
      msgs.scrollTop = msgs.scrollHeight;
      ui.aiUpdatePop?.(); // reveal the popover once there's a conversation
      return bubble;
    };

    // Quick actions prefill the prompt so a single click sends a common request.
    const chips = ['Summarize the document', 'Improve the writing', 'Fix spelling & grammar', 'Make it shorter', 'Continue writing']
      .map((label) => el('button', {
        class: 'doc-ai__chip', type: 'button',
        onClick: () => { ui.aiInput.value = label; ui.aiInput.focus(); submit(); },
      }, label));

    const input = el('textarea', {
      class: 'doc-ai__input', rows: '1', placeholder: 'Ask the AI to help with your document…',
      'aria-label': 'Message the AI Assistant',
      onKeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } },
      onInput: (e) => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(120, e.target.scrollHeight)}px`; },
    });
    ui.aiInput = input;
    const sendBtn = el('button', {
      class: 'doc-ai__send', type: 'button', 'data-tip': 'Send', 'aria-label': 'Send',
      onClick: () => submit(),
    }, el('span', { html: renderIcon('sparkle') }));

    function docText() {
      try { return documentToText(editor.getModel()).replace(/\n{2,}/g, '\n').trim(); } catch { return ''; }
    }
    // Local, no-cloud responses for the deterministic asks (the app is client-first,
    // with no API keys); anything else gets a clear, honest reply instead of a fake
    // answer. Emits `doc:ai-request` on the bus so a model can be wired in later.
    function respond(prompt) {
      const text = docText();
      const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
      const chars = text.length;
      const p = prompt.toLowerCase();
      if (!text) return 'Your document is empty — add some text and I can help summarise or refine it.';
      if (/\b(word|character|char|count|how many|length|reading time)\b/.test(p)) {
        const mins = Math.max(1, Math.round(words / 200));
        return `Your document has ${words.toLocaleString()} words and ${chars.toLocaleString()} characters — about a ${mins}-minute read.`;
      }
      return `AI Assistant isn't connected to a language model yet, so I can't ${prompt.replace(/[.!?]+$/, '')} for you here. I can already report word/character count and reading time. (This panel emits a "doc:ai-request" event, ready to wire to a model.)`;
    }

    function submit() {
      const prompt = (input.value || '').trim();
      if (!prompt) return;
      addMsg('user', prompt);
      input.value = ''; input.style.height = 'auto';
      try { bus?.emit?.('doc:ai-request', { prompt, text: docText() }); } catch { /* optional bus */ }
      const thinking = addMsg('ai', '…');
      // Small delay so the exchange reads like a conversation.
      setTimeout(() => { thinking.textContent = respond(prompt); ui.aiMsgs.scrollTop = ui.aiMsgs.scrollHeight; }, 250);
    }

    // Compact popover (messages + chips) that appears ABOVE the bar, only while the
    // input is focused or there's a conversation — so at rest it's just the small bar.
    const pop = el('div', { class: 'doc-ai-pop' }, [msgs, el('div', { class: 'doc-ai__chips' }, chips)]);
    ui.aiPop = pop;
    const updatePop = () => pop.classList.toggle('is-visible', document.activeElement === input || msgs.childElementCount > 0);
    input.addEventListener('focus', updatePop);
    input.addEventListener('blur', () => setTimeout(updatePop, 150));
    ui.aiUpdatePop = updatePop;

    // The small floating chat bar (Gemini-style pill): icon · input · send · close.
    const bar = el('div', { class: 'doc-ai-bar' }, [
      el('span', { class: 'doc-ai-bar__ico', html: renderIcon('sparkle') }),
      input,
      sendBtn,
      el('button', {
        class: 'doc-ai-bar__close', type: 'button', 'aria-label': 'Close AI Assistant',
        'data-tip': 'Close', onClick: () => closeAiPanel(),
      }, '✕'),
    ]);
    const dock = el('div', { class: 'doc-ai-dock', 'aria-label': 'AI Assistant' }, [pop, bar]);
    ui.aiPanel = dock;
    // Float a compact bar at the bottom-centre of the editor (not a full panel).
    (ui.docMain || ui.docBody || root).appendChild(dock);
  }

  function mkMenu(label, itemsFn) {
    const btn = el('button', {
      class: 'doc-menu__top', type: 'button', role: 'menuitem',
      'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onClick: (e) => { e.stopPropagation(); toggleMenu(btn, itemsFn); },
      // Once a menu is open, hovering a sibling switches to it (native feel).
      onMouseenter: () => { if (openMenu && openMenu.btn !== btn) toggleMenu(btn, itemsFn); },
    }, label);
    return el('div', { class: 'doc-menu-wrap' }, btn);
  }

  function toggleMenu(btn, itemsFn) {
    const wasThis = openMenu && openMenu.btn === btn;
    closeMenu();
    if (wasThis) return;
    const menu = el('div', { class: 'app-menu doc-menu', role: 'menu' }, itemsFn().map(renderMenuItem));
    btn.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    btn.parentElement.appendChild(menu);
    openMenu = { el: menu, btn };
    setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
  }

  function onDocClick(e) {
    if (openMenu && !openMenu.el.contains(e.target) && e.target !== openMenu.btn) closeMenu();
  }

  function closeMenu() {
    if (!openMenu) return;
    openMenu.btn.classList.remove('is-open');
    openMenu.btn.setAttribute('aria-expanded', 'false');
    openMenu.el.remove();
    openMenu = null;
    document.removeEventListener('click', onDocClick, true);
  }

  function renderMenuItem(it) {
    if (it.sep) return el('div', { class: 'app-menu__sep' });
    return el('button', {
      class: `app-menu__item${it.disabled ? ' is-disabled' : ''}`,
      type: 'button', role: 'menuitem', disabled: !!it.disabled,
      onMousedown: (e) => e.preventDefault(), // keep the editor caret/selection
      onClick: (e) => { e.stopPropagation(); closeMenu(); if (!it.disabled) it.onClick?.(); },
    }, [
      it.icon ? el('span', { class: 'app-menu__icon', html: renderIcon(it.icon) }) : null,
      el('span', { class: 'app-menu__label' }, it.label),
      it.shortcut ? el('span', { class: 'app-menu__shortcut' }, it.shortcut) : null,
    ].filter(Boolean));
  }

  /* ---- menu contents (built fresh on open so disabled state is current) --- */
  const fileMenu = () => [
    { label: 'New document', icon: 'new-doc', onClick: newBlank },
    { label: 'Open…', icon: 'open', shortcut: 'Ctrl+O', onClick: () => bus.emit('nav:command', { command: 'open', arg: 'document' }) },
    { label: 'Open project', icon: 'open', onClick: openProject },
    { sep: true },
    { label: 'Save project', icon: 'save', shortcut: '.dmdoc', onClick: saveProject },
    { sep: true },
    { label: 'Page setup', icon: 'sliders', onClick: openPageSetup },
    { label: 'Close document', onClick: backHome },
  ];
  const editMenu = () => [
    { label: 'Undo', shortcut: 'Ctrl+Z', disabled: !editor?.canUndo?.(), onClick: () => editor?.undo() },
    { label: 'Redo', shortcut: 'Ctrl+Y', disabled: !editor?.canRedo?.(), onClick: () => editor?.redo() },
    { sep: true },
    { label: 'Select all', shortcut: 'Ctrl+A', onClick: selectAll },
    { sep: true },
    { label: 'Symbol…', onClick: openSymbols },
    { label: 'Calculator', onClick: () => openCalculator() },
  ];
  const viewMenu = () => [
    { label: toolbarHidden ? 'Show formatting toolbar' : 'Hide formatting toolbar', onClick: toggleToolbar },
    { label: document.fullscreenElement ? 'Exit full screen' : 'Full screen', onClick: toggleFullscreen },
  ];
  const insertMenu = () => {
    const items = [
      { label: 'Image…', icon: 'image', onClick: pickImage },
      { label: 'Shape…', icon: 'shapes', onClick: insertShape },
      { label: 'Stamp…', icon: 'stamp', onClick: insertStamp },
      { label: 'Professional Library…', icon: 'chart', onClick: openProLibrary },
      { label: 'Table', icon: 'table', onClick: () => editor.insertTable(3, 3) },
      { sep: true },
      { label: 'Bulleted list', icon: 'list-bullet', onClick: () => editor.insertList(false) },
      { label: 'Numbered list', icon: 'list-numbered', onClick: () => editor.insertList(true) },
      { sep: true },
      { label: 'Header', onClick: () => editor.editHeader() },
      { label: 'Footer', onClick: () => editor.editFooter() },
      { label: 'Page number', onClick: () => editor.insertField('page') },
      { label: 'Page count', onClick: () => editor.insertField('pages') },
      { label: 'Headers & footers…', icon: 'sliders', onClick: () => openHfSettings() },
    ];
    // Row/column editing is only meaningful when the caret is inside a table.
    if (editor?.inTable?.()) {
      items.push(
        { sep: true },
        { label: 'Insert row above', onClick: () => editor.insertTableRow('above') },
        { label: 'Insert row below', onClick: () => editor.insertTableRow('below') },
        { label: 'Insert column left', onClick: () => editor.insertTableColumn('left') },
        { label: 'Insert column right', onClick: () => editor.insertTableColumn('right') },
        { sep: true },
        { label: 'Delete row', onClick: () => editor.deleteTableRow() },
        { label: 'Delete column', onClick: () => editor.deleteTableColumn() },
        { label: 'Delete table', onClick: () => editor.deleteTable() },
      );
    }
    return items;
  };
  const formatMenu = () => [
    { label: 'Bold', shortcut: 'Ctrl+B', onClick: () => editor.toggleMark('bold') },
    { label: 'Italic', shortcut: 'Ctrl+I', onClick: () => editor.toggleMark('italic') },
    { label: 'Underline', shortcut: 'Ctrl+U', onClick: () => editor.toggleMark('underline') },
    { sep: true },
    { label: 'Highlight', icon: 'highlight', onClick: () => applyHighlight(highlightColor) },
    { label: 'Remove highlight', onClick: () => applyHighlight('transparent') },
    { sep: true },
    { label: 'Align left', icon: 'align-left', onClick: () => editor.setAlign('left') },
    { label: 'Align center', icon: 'align-center', onClick: () => editor.setAlign('center') },
    { label: 'Align right', icon: 'align-right', onClick: () => editor.setAlign('right') },
    { label: 'Justify', icon: 'align-justify', onClick: () => editor.setAlign('justify') },
    { sep: true },
    { label: 'Normal text', onClick: () => editor.setBlockTag('p') },
    { label: 'Heading 1', onClick: () => editor.setBlockTag('h1') },
    { label: 'Heading 2', onClick: () => editor.setBlockTag('h2') },
    { label: 'Heading 3', onClick: () => editor.setBlockTag('h3') },
    { sep: true },
    { label: 'Table borders: Normal', icon: 'table', disabled: !editor?.inTable?.(), onClick: () => editor.setTableBorder('thin') },
    { label: 'Table borders: Thick', disabled: !editor?.inTable?.(), onClick: () => editor.setTableBorder('thick') },
    { label: 'Table borders: None', disabled: !editor?.inTable?.(), onClick: () => editor.setTableBorder('none') },
  ];
  const toolsMenu = () => [
    { label: 'Word count', onClick: wordCount },
  ];

  /* ---- menu-bar actions ---- */
  function backHome() {
    closeMenu();
    bus.emit('nav:command', { command: 'view', arg: 'home' });
  }
  function selectAll() {
    if (!editor) return;
    editor.focus();
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(editor.element);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function toggleToolbar() {
    toolbarHidden = !toolbarHidden;
    if (toolbarEl) toolbarEl.hidden = toolbarHidden;
  }
  // Paint / clear the highlighter. With a caret (no selection) this arms the
  // highlighter so typed text comes out highlighted (Google-Docs style);
  // 'transparent' clears it. Also updates the toolbar button's colour bar.
  function applyHighlight(color) {
    if (!editor) return;
    const on = color && color !== 'transparent';
    highlightOn = !!on;
    if (ui.highlight) ui.highlight.classList.toggle('is-active', highlightOn);
    editor.setHighlight(on ? color : 'transparent');
  }

  // Right-click colour panel for the highlighter: a small swatch grid + "None"
  // + custom picker. Swatches preventDefault on mousedown so the editor's
  // caret/selection survives — picking one sets the marker colour and applies it.
  const HL_COLORS = [
    '#ffff00', '#ffe64d', '#ffd54f', '#ffab40', '#ff8a80', '#ff80ab',
    '#ea80fc', '#b388ff', '#8c9eff', '#80d8ff', '#84ffff', '#a7ffeb',
    '#b9f6ca', '#ccff90', '#f4ff81', '#e0e0e0', '#9e9e9e', '#000000',
  ];
  let hlPalette = null;
  function closeHighlightPalette() {
    if (!hlPalette) return;
    hlPalette.remove();
    hlPalette = null;
    document.removeEventListener('click', onHlOutside, true);
    document.removeEventListener('contextmenu', onHlOutside, true);
  }
  function onHlOutside(e) {
    if (hlPalette && !hlPalette.contains(e.target)) closeHighlightPalette();
  }
  function openHighlightPalette(anchor) {
    if (hlPalette) return closeHighlightPalette();
    const pick = (color) => { closeHighlightPalette(); applyHighlight(color); };
    const none = el('button', {
      class: 'doc-hl__none', type: 'button', onMousedown: (e) => e.preventDefault(),
      onClick: () => pick('transparent'),
    }, [el('span', { class: 'doc-hl__none-swatch' }), 'None']);
    const grid = el('div', { class: 'doc-hl__grid' }, HL_COLORS.map((c) => el('button', {
      class: `doc-hl__swatch${c.toLowerCase() === highlightColor.toLowerCase() ? ' is-active' : ''}`,
      type: 'button', title: c, style: `background:${c}`,
      onMousedown: (e) => e.preventDefault(),
      onClick: () => pick(c),
    })));
    const custom = el('input', {
      class: 'doc-hl__custom', type: 'color', value: highlightColor, title: 'Custom colour',
      onChange: (e) => pick(e.target.value),
    });
    hlPalette = el('div', { class: 'app-menu doc-hl-menu', role: 'menu' }, [
      none, grid,
      el('div', { class: 'doc-hl__custom-row' }, [el('span', { class: 'doc-hl__custom-label' }, 'Custom'), custom]),
    ]);
    // Anchor under the button with the viewport rect (fixed) so it can't be
    // clipped by the toolbar and lands exactly beneath the highlighter.
    const rect = anchor.getBoundingClientRect();
    Object.assign(hlPalette.style, { position: 'fixed', top: `${rect.bottom + 6}px`, left: `${rect.left}px`, right: 'auto' });
    document.body.appendChild(hlPalette);
    setTimeout(() => {
      document.addEventListener('click', onHlOutside, true);
      document.addEventListener('contextmenu', onHlOutside, true);
    }, 0);
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.();
  }
  function wordCount() {
    const text = (editor?.element?.innerText || '').trim();
    const words = text ? text.split(/\s+/).length : 0;
    const chars = text.replace(/\s/g, '').length;
    bus.emit('toast', `${words} word${words === 1 ? '' : 's'} · ${chars} character${chars === 1 ? '' : 's'}.`);
  }

  /* ------------------------------ page setup ---------------------------- */
  // A Google-Docs style Page setup dialog: orientation, paper size, page colour
  // and per-side margins (in cm). Applying updates the live page and the model
  // (persists through save/export). Paper sizes are portrait dimensions in CSS px
  // at 96dpi; landscape swaps width/height.
  const PX_PER_CM = 96 / 2.54;
  const CM_PER_PX = 2.54 / 96;
  const PAPER_SIZES = [
    { id: 'a4', label: 'A4 (21.0 cm x 29.7 cm)', w: 794, h: 1123 },
    { id: 'letter', label: 'Letter (21.6 cm x 27.9 cm)', w: 816, h: 1056 },
    { id: 'legal', label: 'Legal (21.6 cm x 35.6 cm)', w: 816, h: 1344 },
    { id: 'a3', label: 'A3 (29.7 cm x 42.0 cm)', w: 1123, h: 1587 },
    { id: 'a5', label: 'A5 (14.8 cm x 21.0 cm)', w: 559, h: 794 },
    { id: 'tabloid', label: 'Tabloid (27.9 cm x 43.2 cm)', w: 1056, h: 1632 },
  ];
  let pageDialog = null;
  let pageKeyHandler = null;
  function closePageSetup() {
    if (pageKeyHandler) { document.removeEventListener('keydown', pageKeyHandler, true); pageKeyHandler = null; }
    if (pageDialog) { pageDialog.remove(); pageDialog = null; }
  }
  function openPageSetup() {
    closeMenu();
    if (!editor || !hasDoc) { bus.emit('toast', 'Create or open a document first.'); return; }
    if (pageDialog) return;

    const cur = editor.getPageSetup();
    const landscape = cur.width > cur.height;
    const pw = landscape ? cur.height : cur.width;
    const ph = landscape ? cur.width : cur.height;
    const paper = PAPER_SIZES.find((s) => Math.abs(s.w - pw) <= 3 && Math.abs(s.h - ph) <= 3) || PAPER_SIZES[0];
    const toCm = (px) => (px * CM_PER_PX).toFixed(2);
    let orientation = landscape ? 'landscape' : 'portrait';

    const orient = (val, label) => {
      const input = el('input', {
        type: 'radio', name: 'doc-orient', value: val, checked: orientation === val,
        onChange: () => { orientation = val; },
      });
      return el('label', { class: 'doc-dialog__radio' }, [input, el('span', {}, label)]);
    };
    const paperSelect = el('select', { class: 'doc-select doc-dialog__select' },
      PAPER_SIZES.map((s) => el('option', { value: s.id, selected: s.id === paper.id }, s.label)));
    const colorInput = el('input', { class: 'doc-dialog__color', type: 'color', value: cur.background || '#ffffff' });
    const mInput = (key) => el('input', { class: 'doc-dialog__num', type: 'number', min: '0', step: '0.1', value: toCm(cur.margins[key]) });
    const mTop = mInput('top'), mBottom = mInput('bottom'), mLeft = mInput('left'), mRight = mInput('right');
    const field = (label, input) => el('label', { class: 'doc-dialog__field' }, [el('span', { class: 'doc-dialog__flabel' }, label), input]);
    // "Show page margins": a view-only guide outlining the printable area. Off by
    // default; the checkbox reflects the current live state.
    const showMarginsInput = el('input', { type: 'checkbox', checked: !!editor.getShowMargins() });

    const apply = () => {
      const size = PAPER_SIZES.find((s) => s.id === paperSelect.value) || PAPER_SIZES[0];
      const width = orientation === 'landscape' ? size.h : size.w;
      const height = orientation === 'landscape' ? size.w : size.h;
      const cmToPx = (v) => Math.max(0, Math.round((parseFloat(v) || 0) * PX_PER_CM));
      editor.setPageSetup({
        width, height,
        margins: { top: cmToPx(mTop.value), right: cmToPx(mRight.value), bottom: cmToPx(mBottom.value), left: cmToPx(mLeft.value) },
        background: colorInput.value,
      });
      editor.setShowMargins(showMarginsInput.checked);
      renderRuler();
      closePageSetup();
      editor.focus();
      bus.emit('toast', 'Page setup applied.');
    };

    const dialog = el('div', { class: 'doc-dialog', role: 'dialog', 'aria-label': 'Page setup', onMousedown: (e) => e.stopPropagation() }, [
      el('h2', { class: 'doc-dialog__title' }, 'Page setup'),
      el('div', { class: 'doc-dialog__section' }, [
        el('div', { class: 'doc-dialog__label' }, 'Orientation'),
        el('div', { class: 'doc-dialog__row' }, [orient('portrait', 'Portrait'), orient('landscape', 'Landscape')]),
      ]),
      el('div', { class: 'doc-dialog__cols' }, [
        el('div', { class: 'doc-dialog__section' }, [el('div', { class: 'doc-dialog__label' }, 'Paper size'), paperSelect]),
        el('div', { class: 'doc-dialog__section' }, [el('div', { class: 'doc-dialog__label' }, 'Page colour'), colorInput]),
      ]),
      el('div', { class: 'doc-dialog__section' }, [
        el('div', { class: 'doc-dialog__label' }, 'Margins (centimetres)'),
        el('div', { class: 'doc-dialog__margins' }, [field('Top', mTop), field('Bottom', mBottom), field('Left', mLeft), field('Right', mRight)]),
      ]),
      el('div', { class: 'doc-dialog__section' }, [
        el('label', { class: 'doc-dialog__check' }, [showMarginsInput, el('span', {}, 'Show page margins')]),
      ]),
      el('div', { class: 'doc-dialog__foot' }, [
        el('button', { class: 'doc-dialog__btn', type: 'button', onClick: closePageSetup }, 'Cancel'),
        el('button', { class: 'doc-dialog__btn doc-dialog__btn--primary', type: 'button', onClick: apply }, 'OK'),
      ]),
    ]);

    // Backdrop click closes; keys: Esc cancels, Enter applies.
    pageDialog = el('div', { class: 'doc-modal', onMousedown: () => closePageSetup() }, dialog);
    pageKeyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closePageSetup(); }
      else if (e.key === 'Enter') { e.preventDefault(); apply(); }
    };
    document.body.appendChild(pageDialog);
    document.addEventListener('keydown', pageKeyHandler, true);
    setTimeout(() => paperSelect.focus(), 0);
  }

  /* --------------------------- header & footer -------------------------- */
  // The "Headers and footers" dialog (Google-Docs): header/footer distance from
  // the page edge (cm) + the Different-first / Different-odd-&-even layout flags.
  // Apply writes straight through editor.setHfSettings, which reflows the body.
  let hfDialog = null;
  let hfKeyHandler = null;
  function closeHfSettings() {
    if (hfKeyHandler) { document.removeEventListener('keydown', hfKeyHandler, true); hfKeyHandler = null; }
    if (hfDialog) { hfDialog.remove(); hfDialog = null; }
  }
  function openHfSettings() {
    closeMenu();
    if (!editor || !hasDoc) { bus.emit('toast', 'Create or open a document first.'); return; }
    if (hfDialog) return;
    const cur = editor.getHfSettings();
    const toCm = (px) => (px * CM_PER_PX).toFixed(2);
    const headerInput = el('input', { class: 'doc-dialog__num', type: 'number', min: '0', step: '0.1', value: toCm(cur.headerDistance) });
    const footerInput = el('input', { class: 'doc-dialog__num', type: 'number', min: '0', step: '0.1', value: toCm(cur.footerDistance) });
    const firstChk = el('input', { type: 'checkbox', checked: cur.differentFirst });
    const oddEvenChk = el('input', { type: 'checkbox', checked: cur.differentOddEven });
    const field = (label, input) => el('label', { class: 'doc-dialog__field' }, [el('span', { class: 'doc-dialog__flabel' }, label), input]);
    const check = (input, label) => el('label', { class: 'doc-dialog__check' }, [input, el('span', {}, label)]);

    const apply = () => {
      editor.setHfSettings({
        headerDistance: Math.max(0, Math.round((parseFloat(headerInput.value) || 0) * PX_PER_CM)),
        footerDistance: Math.max(0, Math.round((parseFloat(footerInput.value) || 0) * PX_PER_CM)),
        differentFirst: firstChk.checked,
        differentOddEven: oddEvenChk.checked,
      });
      closeHfSettings();
      editor.focus();
      bus.emit('toast', 'Header & footer settings applied.');
    };

    const dialog = el('div', { class: 'doc-dialog', role: 'dialog', 'aria-label': 'Headers and footers', onMousedown: (e) => e.stopPropagation() }, [
      el('h2', { class: 'doc-dialog__title' }, 'Headers and footers'),
      el('div', { class: 'doc-dialog__section' }, [
        el('div', { class: 'doc-dialog__label' }, 'Margins'),
        el('div', { class: 'doc-dialog__margins doc-dialog__margins--hf' }, [
          field('Header (centimetres from top)', headerInput),
          field('Footer (centimetres from bottom)', footerInput),
        ]),
      ]),
      el('div', { class: 'doc-dialog__section' }, [
        el('div', { class: 'doc-dialog__label' }, 'Layout'),
        check(firstChk, 'Different first page'),
        check(oddEvenChk, 'Different odd & even'),
      ]),
      el('div', { class: 'doc-dialog__foot' }, [
        el('button', { class: 'doc-dialog__btn', type: 'button', onClick: closeHfSettings }, 'Cancel'),
        el('button', { class: 'doc-dialog__btn doc-dialog__btn--primary', type: 'button', onClick: apply }, 'Apply'),
      ]),
    ]);

    hfDialog = el('div', { class: 'doc-modal', onMousedown: () => closeHfSettings() }, dialog);
    hfKeyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeHfSettings(); }
      else if (e.key === 'Enter') { e.preventDefault(); apply(); }
    };
    document.body.appendChild(hfDialog);
    document.addEventListener('keydown', hfKeyHandler, true);
    setTimeout(() => headerInput.focus(), 0);
  }

  /* -------------------------------- ruler ------------------------------- */
  // A Word / Google-Docs style horizontal ruler above the page. It shows a
  // centimetre scale (origin at the left margin), shades the margin areas, and
  // exposes draggable left/right margin markers that write back through
  // editor.setPageSetup — so the ruler and the page always agree.
  const RULER_PX_PER_CM = 96 / 2.54;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /** Floating − 100% + control at the page's bottom-right. */
  function mkZoomControl() {
    ui.zoomVal = el('button', {
      class: 'doc-zoom__val', type: 'button', title: 'Reset to 100%',
      onClick: () => applyDocZoom(editor?.setZoom(1)),
    }, '100%');
    const btn = (icon, label, fn) => el('button', {
      class: 'doc-zoom__btn', type: 'button', 'aria-label': label, 'data-tip': label,
      onClick: fn,
    }, el('span', { class: 'doc-btn__ico', html: renderIcon(icon) }));
    return el('div', { class: 'doc-zoom', role: 'group', 'aria-label': 'Zoom' }, [
      btn('minus', 'Zoom out', () => applyDocZoom(editor?.zoomOut())),
      ui.zoomVal,
      btn('plus', 'Zoom in', () => applyDocZoom(editor?.zoomIn())),
    ]);
  }

  /** Apply a new page zoom: update the floating control + store readout and scale
   *  the ruler to match. `z` is the editor's clamped value; null (no editor yet)
   *  makes it a no-op. */
  function applyDocZoom(z) {
    if (z == null) return false;
    docZoom = z;
    store.setState({ zoom: z });
    if (ui.zoomVal) ui.zoomVal.textContent = `${Math.round(z * 100)}%`;
    const r = rulerEl?.querySelector('.doc-ruler');
    if (r) r.style.zoom = String(z);
    return true;
  }

  function renderRuler() {
    if (!rulerEl || !editor || !hasDoc) return;
    const ps = editor.getPageSetup(); // { width, height, margins, background }
    const W = ps.width;
    const m = ps.margins;

    const ruler = el('div', { class: 'doc-ruler' });
    ruler.style.width = `${W}px`;

    // Shaded margin areas at both ends.
    const padL = el('div', { class: 'doc-ruler__pad' }); padL.style.left = '0'; padL.style.width = `${m.left}px`;
    const padR = el('div', { class: 'doc-ruler__pad' }); padR.style.right = '0'; padR.style.width = `${m.right}px`;
    ruler.append(padL, padR);

    // Quarter-cm ticks across the whole width. Numbers are measured from the
    // left margin (0 at content start) and MIRRORED into the margins — e.g. the
    // left margin reads 2, 1 back toward the page edge, exactly like Google Docs.
    const ticks = el('div', { class: 'doc-ruler__ticks' });
    const quarter = RULER_PX_PER_CM / 4;
    for (let k = Math.ceil((0 - m.left) / quarter); ; k += 1) {
      const x = m.left + k * quarter;
      if (x > W + 0.5) break;
      if (x < -0.5) continue;
      const isCm = k % 4 === 0;
      const isHalf = k % 2 === 0;
      const cls = isCm ? 'doc-ruler__tick doc-ruler__tick--major' : isHalf ? 'doc-ruler__tick doc-ruler__tick--half' : 'doc-ruler__tick';
      const tick = el('div', { class: cls }); tick.style.left = `${x}px`;
      ticks.appendChild(tick);
      if (isCm) {
        const cm = k / 4;
        if (cm !== 0) { const num = el('span', { class: 'doc-ruler__num' }, String(Math.abs(cm))); num.style.left = `${x}px`; ticks.appendChild(num); }
      }
    }
    ruler.appendChild(ticks);

    // Draggable margin markers.
    const mkMarker = (side, x) => {
      const mk = el('div', { class: `doc-ruler__marker doc-ruler__marker--${side}`, title: `${side === 'left' ? 'Left' : 'Right'} margin — drag to adjust` });
      mk.style.left = `${x}px`;
      mk.addEventListener('pointerdown', (e) => startMarginDrag(e, mk, side, ps));
      return mk;
    };
    ruler.appendChild(mkMarker('left', m.left));
    ruler.appendChild(mkMarker('right', W - m.right));

    ruler.style.zoom = String(docZoom); // scale with the page so ticks stay aligned
    rulerEl.replaceChildren(ruler);
  }

  function startMarginDrag(e, mk, side, ps0) {
    e.preventDefault();
    const W = ps0.width;
    const m0 = { ...ps0.margins };
    const startX = e.clientX;
    const MIN_CONTENT = 96; // keep ≥ ~1in of content between margins
    let val = side === 'left' ? m0.left : m0.right;
    try { mk.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      if (side === 'left') { val = clamp(m0.left + dx, 0, W - m0.right - MIN_CONTENT); mk.style.left = `${val}px`; }
      else { val = clamp(m0.right - dx, 0, W - m0.left - MIN_CONTENT); mk.style.left = `${W - val}px`; }
    };
    const onUp = () => {
      mk.removeEventListener('pointermove', onMove);
      mk.removeEventListener('pointerup', onUp);
      editor.setPageSetup({ width: W, height: ps0.height, margins: { ...m0, [side]: Math.round(val) }, background: ps0.background });
      renderRuler();
      editor.focus();
    };
    mk.addEventListener('pointermove', onMove);
    mk.addEventListener('pointerup', onUp);
  }

  /* ------------------------- tabs & outline panel ----------------------- */
  // A Google-Docs style left panel: a "Document tabs" section plus a live
  // outline of the document's headings (click to jump). Collapses to a small
  // round toggle button so the page stays the focus.
  function buildOutline(rootEl) {
    const toggle = el('button', {
      class: 'doc-outline__toggle', type: 'button', 'data-tip': 'Show tabs and outlines',
      'aria-label': 'Show tabs and outlines', onClick: () => setOutlineOpen(true),
    }, el('span', { class: 'doc-outline__ico', html: renderIcon('outline') }));

    const back = el('button', {
      class: 'doc-outline__back', type: 'button', 'data-tip': 'Hide',
      'aria-label': 'Hide tabs and outlines', onClick: () => setOutlineOpen(false),
    }, el('span', { class: 'doc-outline__ico', html: renderIcon('chevron') }));

    const tabs = el('div', { class: 'doc-outline__tabs' }, [
      el('div', { class: 'doc-outline__tabhead' }, [
        el('span', { class: 'doc-outline__label' }, 'Document tabs'),
        el('button', {
          class: 'doc-outline__add', type: 'button', 'data-tip': 'Add tab', 'aria-label': 'Add tab',
          onClick: () => bus.emit('toast', 'Multiple document tabs — coming soon.'),
        }, el('span', { class: 'doc-outline__ico', html: renderIcon('plus') })),
      ]),
      el('button', { class: 'doc-outline__tab is-active', type: 'button' }, [
        el('span', { class: 'doc-outline__tabico', html: renderIcon('document') }),
        el('span', {}, 'Tab 1'),
      ]),
    ]);

    ui.outlineList = el('div', { class: 'doc-outline__list' });
    const panel = el('div', { class: 'doc-outline__panel' }, [
      el('div', { class: 'doc-outline__head' }, [back]),
      tabs,
      el('div', { class: 'doc-outline__outhead' }, 'Outline'),
      ui.outlineList,
    ]);

    rootEl.replaceChildren(toggle, panel);
    setOutlineOpen(outlineOpen);
  }

  function setOutlineOpen(open) {
    outlineOpen = open;
    if (outlineEl) outlineEl.classList.toggle('is-open', open);
    if (open) refreshOutline();
  }

  function refreshOutline() {
    if (!ui.outlineList || !editor || !hasDoc) return;
    // Flow docs tag headings as h1/h2/h3; positioned (exact-layout) docs tag them
    // as .doc-posbox[data-heading]. Collect both, in document (DOM) order.
    const heads = Array.from(editor.element.querySelectorAll(
      'h1.doc-block, h2.doc-block, h3.doc-block, .doc-posbox[data-heading]'
    ));
    if (!heads.length) {
      ui.outlineList.replaceChildren(
        el('p', { class: 'doc-outline__empty' }, 'Headings that you add to the document will appear here.')
      );
      return;
    }
    ui.outlineList.replaceChildren(...heads.map((h) => {
      const level = h.dataset && h.dataset.heading ? `h${h.dataset.heading}` : h.tagName.toLowerCase();
      // Plain heading text only, with internal whitespace/newlines collapsed —
      // the outline shows clean names, never document markup or formatting.
      const text = (h.textContent || '').replace(/\s+/g, ' ').trim() || 'Heading';
      return el('button', {
        class: `doc-outline__item doc-outline__item--${level}`, type: 'button', title: text,
        onClick: () => {
          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
          editor.focus();
          const r = document.createRange();
          r.selectNodeContents(h);
          r.collapse(true);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
        },
      }, text);
    }));
  }

  /* -------------------------- formatting toolbar ------------------------ */
  function buildToolbar(bar) {
    // Paragraph style.
    ui.style = mkSelect([
      { value: 'p', label: 'Normal text' },
      { value: 'h1', label: 'Heading 1' },
      { value: 'h2', label: 'Heading 2' },
      { value: 'h3', label: 'Heading 3' },
    ], (v) => editor.setBlockTag(v), 'doc-toolbar__style');

    ui.font = mkSelect(FONT_OPTIONS, (v) => editor.setFontFamily(v), 'doc-toolbar__font');
    ui.size = mkSelect(FONT_SIZES.map((s) => ({ value: String(s), label: String(s) })), (v) => editor.setFontSize(v), 'doc-toolbar__size');
    ui.size.value = '16';

    ui.bold = mkBtn('bold', 'Bold (Ctrl+B)', () => editor.toggleMark('bold'));
    ui.italic = mkBtn('italic', 'Italic (Ctrl+I)', () => editor.toggleMark('italic'));
    ui.underline = mkBtn('underline', 'Underline (Ctrl+U)', () => editor.toggleMark('underline'));
    ui.strike = mkBtn('strikethrough', 'Strikethrough', () => editor.toggleMark('strikeThrough'));
    ui.superscript = mkBtn('superscript', 'Superscript', () => editor.toggleMark('superscript'));
    ui.subscript = mkBtn('subscript', 'Subscript', () => editor.toggleMark('subscript'));
    ui.clear = mkBtn('clear-format', 'Clear formatting', () => editor.clearFormatting());

    // Line spacing (paragraph-level) — writes lineHeight, which round-trips in the
    // block model. Options mirror Word's common presets.
    ui.lineSpacing = mkSelect(
      [['', 'Line spacing'], ['1', 'Single'], ['1.15', '1.15'], ['1.5', '1.5'], ['2', 'Double']]
        .map(([value, label]) => ({ value, label })),
      (v) => { if (v) editor.setBlockStyle('lineHeight', v); },
      'doc-toolbar__linespacing',
    );

    // Highlighter: a single marker button (like a highlighter pen). LEFT-click
    // highlights the selection / arms the marker so text you type comes out
    // highlighted; left-click again removes it. RIGHT-click opens a colour panel
    // to change the marker colour. Read the live state synchronously (not the
    // debounced highlightOn) so the toggle decision is never stale.
    ui.highlight = mkBtn('highlight', 'Highlight text · right-click for colours', () =>
      applyHighlight(editor.getFormat()?.highlight ? 'transparent' : highlightColor)
    );
    ui.highlight.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openHighlightPalette(ui.highlight);
    });

    // Apply on `change` (fires once when the picker closes) — not `input`, which
    // streams while dragging and would fight the editor re-focus. foreColor then
    // only affects the selection / next-typed text, never earlier text.
    ui.color = el('input', {
      class: 'doc-toolbar__color', type: 'color', value: '#111111', title: 'Text colour',
      onChange: (e) => editor.setColor(e.target.value),
    });

    ui.alignLeft = mkBtn('align-left', 'Align left', () => editor.setAlign('left'));
    ui.alignCenter = mkBtn('align-center', 'Align center', () => editor.setAlign('center'));
    ui.alignRight = mkBtn('align-right', 'Align right', () => editor.setAlign('right'));
    ui.alignJustify = mkBtn('align-justify', 'Justify', () => editor.setAlign('justify'));

    ui.bullet = mkBtn('list-bullet', 'Bulleted list', () => editor.insertList(false));
    ui.number = mkBtn('list-numbered', 'Numbered list', () => editor.insertList(true));

    bar.replaceChildren(
      grp([ui.style]),
      sep(),
      grp([ui.font, ui.size]),
      sep(),
      grp([ui.bold, ui.italic, ui.underline, ui.strike]),
      sep(),
      grp([ui.superscript, ui.subscript, ui.clear]),
      sep(),
      grp([ui.highlight, ui.color]),
      sep(),
      grp([ui.alignLeft, ui.alignCenter, ui.alignRight, ui.alignJustify]),
      sep(),
      grp([ui.bullet, ui.number, ui.lineSpacing]),
      // Insert (table/image) and Download now live in the top menu bar.
    );
  }

  const grp = (children) => el('div', { class: 'doc-toolbar__group' }, children);
  const sep = () => el('span', { class: 'doc-toolbar__sep' });

  function mkBtn(icon, tip, onClick) {
    return el('button', {
      class: 'doc-btn', type: 'button', 'data-tip': tip, 'aria-label': tip,
      // Keep the caret/selection in the editor when clicking a formatting button.
      onMousedown: (e) => e.preventDefault(),
      onClick,
    }, el('span', { class: 'doc-btn__ico', html: renderIcon(icon) }));
  }

  function mkSelect(options, onChange, cls) {
    const s = el('select', {
      class: `doc-select ${cls || ''}`,
      onMousedown: (e) => e.stopPropagation(),
      onChange: (e) => onChange(e.target.value),
    }, options.map((o) => el('option', { value: o.value }, o.label)));
    return s;
  }

  /**
   * Insert-table button with a Google-Docs-style size picker: click opens a grid,
   * hovering highlights an R×C rectangle (with a live "cols × rows" readout), and
   * clicking a cell inserts that table via the existing engine. The grid can be
   * dragged past its initial size — a bottom row/right column is added on demand
   * so you can build larger tables without a separate dialog.
   */
  function mkTablePicker() {
    const COLS = 20, ROWS = 20; // grid to pick table size up to 20 × 20
    let menu = null;
    const close = () => { if (menu) { menu.remove(); menu = null; document.removeEventListener('click', close); } };
    const btn = el('button', {
      class: 'doc-btn', type: 'button', 'data-tip': 'Insert table', 'aria-label': 'Insert table',
      onMousedown: (e) => e.preventDefault(),
      onClick: (e) => {
        e.stopPropagation();
        if (menu) return close();
        menu = buildPicker();
        document.body.appendChild(menu);
        const rect = btn.getBoundingClientRect();
        menu.style.top = `${Math.round(rect.bottom + 4)}px`;
        // Keep the popup on-screen (it's near the right edge of the menu bar).
        const w = menu.offsetWidth || 220;
        menu.style.left = `${Math.round(Math.min(rect.left, window.innerWidth - w - 8))}px`;
        setTimeout(() => document.addEventListener('click', close), 0);
      },
    }, el('span', { class: 'doc-btn__ico', html: renderIcon('table') }));

    function buildPicker() {
      const label = el('div', { class: 'doc-tablegrid__label' }, 'Insert table');
      const grid = el('div', { class: 'doc-tablegrid__grid', style: `grid-template-columns: repeat(${COLS}, 16px)` });
      const cells = [];
      for (let r = 1; r <= ROWS; r += 1) {
        for (let c = 1; c <= COLS; c += 1) {
          const cell = el('span', {
            class: 'doc-tablegrid__cell', dataset: { c, r },
            onMouseenter: () => hover(c, r),
            onClick: (ev) => { ev.stopPropagation(); close(); editor.insertTable(r, c); },
          });
          cells.push(cell);
          grid.appendChild(cell);
        }
      }
      // Highlight the top-left R×C rectangle — just toggle classes, no re-render.
      const hover = (c, r) => {
        for (const cell of cells) cell.classList.toggle('is-on', +cell.dataset.c <= c && +cell.dataset.r <= r);
        label.textContent = `${c} × ${r}`;
      };
      return el('div', {
        class: 'app-menu doc-tablegrid', role: 'menu',
        onMousedown: (e) => e.preventDefault(), // keep the editor selection
      }, [grid, label]);
    }
    return btn;
  }

  // The Download control is a compact two-tier menu: a primary "Quick Export"
  // (the existing, unchanged PDF/Word/HTML formats) and "Advanced Export", which
  // opens the professional panel of document tools. The advanced options are
  // never dumped into this dropdown — it stays small.
  function mkExportMenu() {
    let menu = null;
    const close = () => { if (menu) { menu.remove(); menu = null; document.removeEventListener('click', close); } };
    const btn = el('button', {
      class: 'doc-btn doc-btn--wide doc-btn--export-glow', type: 'button', 'data-tip': 'Export',
      onClick: (e) => {
        e.stopPropagation();
        if (menu) return close();
        menu = el('div', {
          class: 'app-menu doc-export-menu doc-export-menu--rich', role: 'menu',
          // Swallow in-menu clicks so navigating between views doesn't reach the
          // document listener that closes the popover; only outside clicks close.
          onClick: (e) => e.stopPropagation(),
        });
        render();
        btn.parentElement.appendChild(menu);
        setTimeout(() => document.addEventListener('click', close), 0);
      },
    }, [
      el('span', { class: 'doc-btn__ico', html: renderIcon('export') }),
      el('span', { class: 'doc-btn__txt' }, 'Export'),
    ]);

    // A single popover with two choices: Quick Export (one-click Word download) and
    // Advanced Export (the full format/tools panel).
    function render() {
      if (!menu) return;
      menu.replaceChildren(...mainView());
      menu.querySelector('button')?.focus();
    }

    function mainView() {
      return [
        el('div', { class: 'doc-xmenu__title' }, 'Export'),
        // Quick Export = one click → download Word (.docx). No second step; other
        // formats live under Advanced Export.
        richRow('word', 'Quick Export', 'Download Word (.docx)', () => { close(); doExport('docx'); }),
        richRow('sparkle', 'Advanced Export', 'More formats and document tools', () => { close(); openAdvancedExport(); }, 'doc-xmenu__row--glow'),
      ];
    }

    function richRow(icon, label, desc, onPick, extraClass) {
      return el('button', {
        class: `doc-xmenu__row${extraClass ? ' ' + extraClass : ''}`, type: 'button', role: 'menuitem', onClick: onPick,
      }, [
        el('span', { class: 'doc-xmenu__row-ico', html: renderIcon(icon), 'aria-hidden': 'true' }),
        el('span', { class: 'doc-xmenu__row-txt' }, [
          el('span', { class: 'doc-xmenu__row-lbl' }, label),
          el('span', { class: 'doc-xmenu__row-desc' }, desc),
        ]),
        el('span', { class: 'doc-xmenu__row-chev', html: renderIcon('chevron'), 'aria-hidden': 'true' }),
      ]);
    }

    return btn;
  }

  // Quick Export — unchanged: hand the chosen format to the shared export manager.
  function doExport(format) {
    const base = (store.getState().docName || 'document').replace(/\.[^.]+$/, '');
    const ext = format === 'docx' ? 'docx' : format;
    services.exportManager.run({ format, filename: `${base}.${ext}` });
  }

  function openAdvancedExport() {
    if (!editor || !hasDoc) { bus.emit('toast', 'Create or open a document first.'); return; }
    if (!advExportPanel) {
      advExportPanel = createDocExportPanel({
        getModel: () => editor.getModel(),
        getDocName: () => store.getState().docName || 'document',
        downloadBlob: triggerDownload,
        toast: (m) => bus.emit('toast', m),
      });
    }
    advExportPanel.open();
  }

  function pickImage() {
    const inp = el('input', { type: 'file', accept: 'image/*' });
    inp.addEventListener('change', () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => editor.insertImage(reader.result);
      reader.readAsDataURL(file);
    });
    inp.click();
  }

  // Insert → Shape: open the full Office-style shape library and drop the chosen
  // shape as an SVG image (so it round-trips + exports via the image pipeline).
  function insertShape() {
    if (!editor) return;
    openShapePicker({
      onPick: ({ id, fill, stroke }) => {
        // Insert as a recolourable shape (right-click → Fill/Border/Line colour).
        editor.insertShape({ id, fill, stroke, width: 180 });
      },
    });
  }

  // Insert → Stamp: open the shared stamp library and drop the chosen stamp as an
  // SVG image (so it round-trips + exports via the image pipeline, exactly like a
  // shape). Same stamp designs as the PDF editor.
  function insertStamp() {
    if (!editor || !hasDoc) { bus.emit('toast', 'Create or open a document first.'); return; }
    openStampPicker({
      onPick: (def) => {
        const src = `data:image/svg+xml,${encodeURIComponent(stampSvgMarkup(def))}`;
        editor.insertImage(src, def.w);
      },
    });
  }

  // Insert → Professional Library: a SEPARATE tool from Shapes. Opens the chart &
  // graph library; picking a type inserts a real editable chart object.
  function openProLibrary() {
    if (!editor || !hasDoc) { bus.emit('toast', 'Create or open a document first.'); return; }
    openChartPicker({ onPick: (typeId) => editor.insertChart(defaultChart(typeId)) });
  }
  function openSymbols() {
    if (!editor || !hasDoc) { bus.emit('toast', 'Create or open a document first.'); return; }
    openSymbolLibrary({
      insert: (ch) => editor.insertText(ch),
      restore: () => editor.restoreCaret(),
    });
  }

  /* ------------------------ selection reflection ------------------------ */
  function reflectSelection(fmt) {
    if (!fmt) return;
    toggle(ui.bold, fmt.bold);
    toggle(ui.italic, fmt.italic);
    toggle(ui.underline, fmt.underline);
    toggle(ui.strike, fmt.strike);
    toggle(ui.superscript, fmt.superscript);
    toggle(ui.subscript, fmt.subscript);
    if (ui.lineSpacing) {
      const opts = ['1', '1.15', '1.5', '2'];
      const lh = fmt.lineHeight != null ? String(fmt.lineHeight) : '';
      ui.lineSpacing.value = opts.includes(lh) ? lh : '';
    }
    toggle(ui.alignLeft, fmt.align === 'left');
    toggle(ui.alignCenter, fmt.align === 'center');
    toggle(ui.alignRight, fmt.align === 'right');
    toggle(ui.alignJustify, fmt.align === 'justify');
    toggle(ui.bullet, fmt.unordered);
    toggle(ui.number, fmt.ordered);
    highlightOn = !!fmt.highlight;
    toggle(ui.highlight, highlightOn);
    if (ui.style) ui.style.value = /^(h1|h2|h3)$/.test(fmt.blockTag) ? fmt.blockTag : 'p';
    if (ui.size && fmt.fontSize) ui.size.value = String(fmt.fontSize);
    if (ui.font && fmt.fontFamily) matchFontOption(ui.font, fmt.fontFamily);
    if (ui.color && fmt.color) ui.color.value = normHex(fmt.color);
    // Keep the shared properties panel showing typography for the caret.
    bus.emit('selection:change', textSelection(fmt));
  }

  const toggle = (btn, on) => btn && btn.classList.toggle('is-active', !!on);
  const textSelection = (fmt) => selection(SelectionKind.TEXT, { label: 'Text', values: fmt || {} });

  function matchFontOption(select, family) {
    const first = family.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
    const opt = Array.from(select.options).find((o) => o.value.toLowerCase().includes(first));
    if (opt) select.value = opt.value;
  }
  function normHex(c) {
    if (/^#[0-9a-f]{6}$/i.test(c)) return c;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(c || '');
    if (!m) return '#111111';
    const h = (n) => Number(n).toString(16).padStart(2, '0');
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
  }

  /* ------------------------------ open files ---------------------------- */
  async function openFile(file) {
    const name = file.name || 'Document';
    if (/\.docx$/i.test(name)) {
      const buf = await file.arrayBuffer();
      loadDoc(await docxToBlockModel(buf, name.replace(/\.docx$/i, '')), name);
    } else if (/\.(txt|md|markdown)$/i.test(name) || (file.type || '').startsWith('text/')) {
      loadDoc(textToDoc(await file.text(), name), name);
    } else if (/\.doc$/i.test(name)) {
      bus.emit('toast', 'Legacy .doc isn’t supported — save it as .docx and try again.');
    } else {
      bus.emit('toast', 'Open a Word (.docx), text or Markdown file in the Document editor.');
    }
  }

  function textToDoc(text, name) {
    const paras = String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/);
    const blocks = paras.map((p) => createParagraph({ runs: [createRun(p.replace(/\n/g, ' '))] }));
    return createDocument({ title: name.replace(/\.[^.]+$/, ''), source: 'blank', blocks: blocks.length ? blocks : undefined });
  }

  /* --------------------- shared properties-panel bridge ----------------- */
  // A few advanced controls in the right panel drive the live editor. We only
  // react while this workspace owns the document, and only for text controls.
  bus.on('property:change', ({ kind, key, value }) => {
    if (!editor || !hasDoc || kind !== SelectionKind.TEXT) return;
    if (key === 'lineHeight') editor.setBlockStyle('lineHeight', value);
    else if (key === 'letterSpacing') editor.setInlineStyle('letterSpacing', `${value}px`);
    else if (key === 'highlight') editor.setInlineStyle('backgroundColor', value);
    else if (key === 'textCase') editor.setInlineStyle('textTransform', value === 'none' ? 'none' : value);
  });

  /* ------------------------------ contract ------------------------------ */
  return {
    id: 'document',
    label: 'Document',
    icon: 'document',
    accepts: (f) => f && /\.(docx?|txt|md|markdown)$/i.test(f.name || '') || /^text\//.test((f && f.type) || ''),

    mount,
    activate() {
      // Word-processor takeover only while a document is open; the empty screen
      // keeps the normal shell so the nav stays reachable.
      store.setState({ homeMode: false, blankMode: false, docMode: hasDoc });
      if (editor && hasDoc) editor.setEditable(true);
      bus.emit('selection:change', hasDoc ? textSelection() : emptySelection());
    },
    deactivate() {
      closeMenu();
      closeHighlightPalette();
      closePageSetup();
      closeHfSettings();
      if (editor) editor.setEditable(false);
      // Restore the shared chrome for whatever workspace comes next.
      setDocMode(false);
    },
    onActivate(payload) {
      if (payload?.intent === 'new' && !hasDoc) newBlank();
    },

    getToolbar: () => ({ groups: [] }), // the workspace renders its own formatting bar
    getTools: () => [],

    handleAction(action) {
      switch (action) {
        case 'undo': editor?.undo(); return true;
        case 'redo': editor?.redo(); return true;
        case 'zoom-in': return applyDocZoom(editor?.zoomIn());
        case 'zoom-out': return applyDocZoom(editor?.zoomOut());
        case 'zoom-fit': return applyDocZoom(editor?.setZoom(1));
        case 'save-project': return saveProject();
        case 'open-project': return openProject();
        default: return false;
      }
    },

    async open(file) { await openFile(file); },

    // Open an already-built Document model in place (no file, no import). Used by the
    // PDF editor's "Transfer to Doc" to hand over a positioned exact-layout document
    // it built from the PDF's own coordinates. Reuses the normal load path, so the
    // editor enters word-processor mode with the document ready to edit.
    openModel(model, name) { loadDoc(model, name || (model && model.title) || 'Document'); },

    // Called by the export manager. Returns a Blob (downloaded) or nothing.
    async export(options = {}) {
      if (!editor || !hasDoc) { bus.emit('toast', 'Create or open a document first.'); return; }
      const model = editor.getModel();
      const fmt = options.format || 'pdf';
      if (fmt === 'docx' || fmt === 'word') return blockModelToDocx(model);
      if (fmt === 'html') return htmlBlob(model);
      return blockModelToPdf(model);
    },

    getSelection: () => (hasDoc ? textSelection() : emptySelection()),
    destroy() { closeMenu(); closeHighlightPalette(); closePageSetup(); closeHfSettings(); advExportPanel?.destroy(); editor?.destroy(); },
  };

  /* ------------------- local project persistence (.dmdoc) --------------- */
  function saveProject() {
    if (!editor || !hasDoc) { bus.emit('toast', 'Nothing to save yet.'); return true; }
    const json = JSON.stringify({ v: 1, kind: 'document', model: editor.getModel() });
    const blob = new Blob([json], { type: 'application/json' });
    const base = (store.getState().docName || 'document').replace(/\.[^.]+$/, '');
    triggerDownload(blob, `${base}.dmdoc`);
    bus.emit('toast', 'Saved a local document project (.dmdoc).');
    return true;
  }

  function openProject() {
    const inp = el('input', { type: 'file', accept: '.dmdoc,application/json' });
    inp.addEventListener('change', async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data.kind !== 'document' || !data.model) throw new Error('bad');
        loadDoc(data.model, file.name.replace(/\.dmdoc$/i, ''));
      } catch {
        bus.emit('toast', 'That isn’t an Advance Office Doc document project.');
      }
    });
    inp.click();
    return true;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
