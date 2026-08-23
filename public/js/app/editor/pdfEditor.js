/**
 * PDF Edit Mode — in-place, layout-preserving editing (Acrobat / PDFgear style).
 *
 * The page is rendered EXACTLY as the original PDF (raster of all graphics,
 * images, tables, vectors). On top of it we place one **independent,
 * absolutely-positioned, contentEditable box per PDF text object**, at the same
 * coordinates, with the same font size. Because every text box is absolutely
 * positioned, editing one never moves the others — nothing reflows. The boxes
 * are transparent (the crisp raster text shows through) until you focus one,
 * then they reveal an opaque, editable copy in place. Images/tables stay fixed.
 *
 * This is deliberately NOT the flowing Document editor — it preserves the exact
 * page layout, x/y of every block, and spacing.
 */
import pdfjsLib, { getDocument, PDF_DOCUMENT_DEFAULTS, CSS_UNITS } from '../../workspace/pdf/pdfjs.js';
import { el } from '../../workspace/utils/dom.js';
import { keyboard } from '../core/keyboard.js';
import { createLayoutEngine, LAYOUT_MODES } from './layoutEngine.js';

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;

export function createPdfEditor({ container, onSelection, onChange, onWarn }) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  container.classList.add('pdfedit');
  const stage = el('div', { class: 'pdfedit__stage' });
  const scroll = el('div', { class: 'pdfedit__scroll', tabindex: '0' }, stage);
  container.appendChild(scroll);

  let pdfDoc = null;
  let pages = []; // [{ num, unit:{w,h}, items:[item], wrap, canvas, layer, viewport, boxEls }]
  let zoom = 1;
  let focused = null; // the currently-edited run element (null once it blurs)
  // The last run that held the caret. Toolbar/panel controls (Bold, colour, …)
  // steal focus from the contentEditable box on mousedown, so `focused` is null
  // by the time their click handler runs. We fall back to this so formatting
  // still targets the run the user was just editing (like every rich editor).
  let lastFocused = null;
  let editableState = true; // false = read-only "view" of the edited model
  let endEditing = null; // keyboard editing-session closer (suspends workspace keys)
  const undoStack = [];
  const redoStack = [];

  // The layout engine measures every run and resolves overflow so edited text
  // never overlaps its neighbours. 'preserve' keeps the page identical (condense
  // + warn); 'reflow' wraps and pushes objects down to make room.
  const engine = createLayoutEngine({ mode: LAYOUT_MODES.PRESERVE });
  let layoutMode = LAYOUT_MODES.PRESERVE;
  let lastWarnKey = null; // de-dupes the "longer than available space" warning

  /* -------------------------------- load -------------------------------- */
  async function load(file) {
    const data = new Uint8Array(await file.arrayBuffer());
    pdfDoc = await getDocument({ data, ...PDF_DOCUMENT_DEFAULTS }).promise;
    pages = [];
    focused = null;
    lastFocused = null;
    for (let n = 1; n <= pdfDoc.numPages; n += 1) {
      const page = await pdfDoc.getPage(n);
      const unitVp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const styles = content.styles || {};
      const items = content.items
        .filter((it) => it.str && it.str.length)
        .map((it, i) => ({
          id: `p${n}i${i}`,
          str: it.str,
          orig: it.str,
          transform: it.transform, // text-space matrix (scale-independent)
          width: it.width || 0,    // original advance width, PDF units (for the layout engine)
          fontFamily: (styles[it.fontName] && styles[it.fontName].fontFamily) || it.fontName || '',
          edited: false,
          style: {}, // user overrides (color/bold/…)
        }));
      pages.push({ num: n, pageRef: page, unit: { w: unitVp.width, h: unitVp.height }, items, wrap: null, canvas: null, layer: null });
    }
    // Fit width on first render.
    zoom = fitZoom();
    await renderAll();
    onChange?.({ canUndo: false, canRedo: false });
    return { numPages: pdfDoc.numPages };
  }

  function fitZoom() {
    const first = pages[0];
    if (!first) return 1;
    const avail = (scroll.clientWidth || 900) - 80;
    return clampZoom(avail / (first.unit.w * CSS_UNITS));
  }
  const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

  /* ------------------------------- render ------------------------------- */
  async function renderAll() {
    stage.replaceChildren();
    for (const p of pages) await renderPage(p);
  }

  async function renderPage(p) {
    const scale = CSS_UNITS * zoom;
    const viewport = p.pageRef.getViewport({ scale });

    const wrap = el('div', { class: 'pdfedit__page' });
    wrap.style.width = `${Math.floor(viewport.width)}px`;
    wrap.style.height = `${Math.floor(viewport.height)}px`;

    const canvas = el('canvas', { class: 'pdfedit__canvas' });
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const layer = el('div', { class: 'pdfedit__layer' });

    wrap.append(canvas, layer);
    stage.appendChild(wrap);
    p.wrap = wrap;
    p.canvas = canvas;
    p.layer = layer;
    p.viewport = viewport;

    await p.pageRef.render({ canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    maskEditedRuns(p); // erase the original glyphs of any edited object from the raster
    layoutRuns(p);
  }

  /**
   * Build one editable box per text object (static font/text/style), then hand
   * geometry — position, condensing, wrapping, push-down — to the layout engine
   * via `applyLayout` so nothing ever overlaps.
   */
  function layoutRuns(p) {
    if (!p.viewport) return;
    p.layer.replaceChildren();
    p.boxEls = new Map();
    for (const item of p.items) {
      const t = pdfjsLib.Util.transform(p.viewport.transform, item.transform);
      const fontSize = Math.hypot(t[2], t[3]); // device px
      if (fontSize < 4) continue;
      // A masked object is editor-owned: its original raster glyphs are gone, so
      // it must always render its (possibly empty) model text opaquely.
      const box = el('div', {
        class: `pdfrun${item.edited ? ' is-edited' : ''}${item.masked ? ' is-masked' : ''}`,
        contentEditable: editableState ? 'true' : 'false',
        spellcheck: false,
        dataset: { id: item.id },
      });
      box.textContent = item.str;
      box.style.fontSize = `${fontSize}px`;
      box.style.fontFamily = mapFamily(item.fontFamily);
      applyItemStyle(box, item);
      wireRun(box, item, p);
      p.layer.appendChild(box);
      p.boxEls.set(item.id, box);
    }
    applyLayout(p);
  }

  /* --------------------------- the layout engine --------------------------- */

  /** Scale-independent engine objects (PDF unit space) for one page's runs. */
  function pageObjects(p) {
    return p.items.map((item) => {
      const tr = item.transform;
      const fs = Math.hypot(tr[2], tr[3]) || 1;
      return {
        id: item.id,
        kind: 'text',
        x: tr[4],
        baseline: tr[5],
        fontSize: fs,
        width: item.width || 0,
        text: item.str,
        cssFont: cssFontFor(item, fs),
        editable: true,
      };
    });
  }

  function cssFontFor(item, fontSizeUnit) {
    const s = item.style || {};
    const weight = s.bold ? '700' : '400';
    const style = s.italic ? 'italic' : 'normal';
    return `${style} ${weight} ${fontSizeUnit}px ${mapFamily(item.fontFamily)}`;
  }

  /**
   * Recompute the whole page's layout from current text and apply it to the
   * existing boxes (no DOM rebuild → caret/focus survive). Returns the plan.
   */
  function applyLayout(p) {
    if (!p.viewport || !p.boxEls) return null;
    const scale = CSS_UNITS * zoom; // device px per PDF unit
    const page = { width: p.unit.w, height: p.unit.h, marginRight: 0 };
    const result = engine.plan(pageObjects(p), page);
    for (const item of p.items) {
      const box = p.boxEls.get(item.id);
      if (!box) continue;
      styleBox(box, item, result.boxes.get(item.id), scale, p.viewport);
    }
    return result;
  }

  /** Translate one engine box into concrete device-px styles on its element. */
  function styleBox(box, item, pb, scale, viewport) {
    const t = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontSize = Math.hypot(t[2], t[3]);
    const angle = Math.atan2(t[1], t[0]);
    const pushY = pb ? pb.pushY * scale : 0;

    box.style.left = `${t[4]}px`;
    box.style.top = `${t[5] - fontSize + pushY}px`;

    const sx = pb ? pb.scaleX : 1;
    const parts = [];
    if (angle) parts.push(`rotate(${angle}rad)`);
    if (sx !== 1) parts.push(`scaleX(${sx})`);
    box.style.transform = parts.join(' ');

    // Reset overflow treatments before re-applying the current strategy.
    box.classList.remove('is-wrapped', 'is-overflow', 'is-collided');
    box.style.width = '';
    box.style.whiteSpace = '';

    if (!pb) return;
    // Reflow wraps overflowing text into its column; Preserve condenses via the
    // scaleX above (full text stays visible). Neither ever truncates.
    if (pb.strategy === 'wrap') {
      box.classList.add('is-wrapped');
      box.style.whiteSpace = 'normal';
      box.style.width = `${pb.wrapWidth * scale}px`;
    }
    if (pb.overflow) box.classList.add('is-overflow');
    if (pb.collided) box.classList.add('is-collided');
  }

  /** Re-layout the page a run lives on and surface any overflow warning once. */
  function relayoutAfterEdit(p, item) {
    const result = applyLayout(p);
    if (!result) return;
    const pb = result.boxes.get(item.id);
    // Text is auto-condensed to fit (still fully visible); only flag it once when
    // it becomes heavily cramped, so the notice is informative rather than nagging.
    const cramped = layoutMode === LAYOUT_MODES.PRESERVE && pb && pb.overflow && pb.scaleX < 0.6;
    if (cramped) {
      const key = `${item.id}`;
      if (key !== lastWarnKey) {
        lastWarnKey = key;
        onWarn?.('The edited text is long — it’s been condensed to fit the available space.');
      }
    } else if (lastWarnKey === `${item.id}`) {
      lastWarnKey = null;
    }
  }

  function applyItemStyle(box, item) {
    const s = item.style || {};
    // Text stays TRANSPARENT (raster shows through) until the box is focused or
    // edited; CSS reveals `--run-color` then. Keeps the page pixel-identical.
    box.style.setProperty('--run-color', s.color || '#111111');
    box.style.fontWeight = s.bold ? '700' : '400';
    box.style.fontStyle = s.italic ? 'italic' : 'normal';
    box.style.textDecoration = s.underline ? 'underline' : 'none';
  }

  function wireRun(box, item, p) {
    box.addEventListener('focus', () => {
      focused = box;
      lastFocused = box;
      box._pushed = false;
      box.classList.add('is-editing');
      box.style.background = sampleBg(p.canvas, box);
      onSelection?.(runFormat(item));
    });
    box.addEventListener('blur', () => {
      box.classList.remove('is-editing');
      if (!item.edited) box.style.background = ''; // revert to transparent (raster shows)
      if (focused === box) focused = null;
    });
    box.addEventListener('input', () => {
      if (!box._pushed) { pushUndo(); box._pushed = true; }
      item.str = box.textContent;
      const wasEdited = item.edited;
      item.edited = item.str !== item.orig || hasStyle(item);
      box.classList.toggle('is-edited', item.edited);
      if (item.edited && !wasEdited) box.style.background = sampleBg(p.canvas, box);
      // The moment an object is touched, erase its original raster glyphs so that
      // deleting/shortening the text can never re-expose the original PDF
      // characters. Once masked it stays editor-owned (shows the model text).
      if (item.edited || item.masked) maskOriginal(p, item);
      // Recalculate the page layout after every edit so longer text is condensed,
      // wrapped, or pushes neighbours down — but never overlaps them.
      relayoutAfterEdit(p, item);
      onChange?.({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
    });
    box.addEventListener('keydown', (e) => {
      // In-place editing must not reflow: Enter does not add lines here.
      if (e.key === 'Enter') { e.preventDefault(); box.blur(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    });
  }

  /* --------------------------- format helpers --------------------------- */
  function runFormat(item) {
    const s = item.style || {};
    return { bold: !!s.bold, italic: !!s.italic, underline: !!s.underline, color: s.color || '#111111', fontFamily: 'Inter', fontSize: 14, align: 'left', lineHeight: 1.2 };
  }
  const hasStyle = (item) => item.style && Object.keys(item.style).length > 0;

  function applyToFocused(fn) {
    // Fall back to the last-focused run: toolbar/panel buttons blur the box.
    const box = focused || lastFocused;
    if (!box || !box.isConnected) return;
    const id = box.dataset.id;
    const p = pages.find((pg) => pg.items.some((i) => i.id === id));
    const item = p?.items.find((i) => i.id === id);
    if (!item) return;
    pushUndo();
    fn(item);
    item.edited = item.str !== item.orig || hasStyle(item);
    applyItemStyle(box, item);
    box.classList.toggle('is-edited', item.edited);
    if (item.edited) box.style.background = sampleBg(p.canvas, box);
    if (item.edited || item.masked) maskOriginal(p, item);
    // Weight/style changes alter measured width → re-run overflow handling.
    relayoutAfterEdit(p, item);
    onChange?.({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
  }

  function toggleMark(name) {
    applyToFocused((item) => { item.style[name] = !item.style[name]; });
  }
  function setStyle(prop, value) {
    applyToFocused((item) => { item.style[prop] = value; });
  }

  /* -------------------------------- undo -------------------------------- */
  function snapshot() {
    return pages.map((p) => p.items.map((i) => ({ id: i.id, str: i.str, edited: i.edited, style: { ...i.style } })));
  }
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > 80) undoStack.shift();
    redoStack.length = 0;
  }
  function restore(snap) {
    snap.forEach((pageSnap, pi) => {
      pageSnap.forEach((s, ii) => {
        const item = pages[pi].items[ii];
        if (!item) return;
        item.str = s.str; item.edited = s.edited; item.style = { ...s.style };
      });
    });
    // Repaint each raster from scratch so objects that are no longer edited get
    // their ORIGINAL glyphs back, then re-mask only the still-edited ones. This
    // keeps the canvas an exact mirror of the model after undo/redo.
    for (const p of pages) repaintPage(p);
    onChange?.({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
  }

  /** Re-render one page's raster in place (preserves scroll) and re-mask edits. */
  async function repaintPage(p) {
    if (!p.canvas || !p.pageRef) return;
    p.viewport = p.pageRef.getViewport({ scale: CSS_UNITS * zoom });
    const ctx = p.canvas.getContext('2d', { alpha: false });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, p.canvas.width, p.canvas.height);
    await p.pageRef.render({ canvasContext: ctx, viewport: p.viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    maskEditedRuns(p);
    layoutRuns(p);
  }
  function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
  function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }

  /* -------------------------------- zoom -------------------------------- */
  async function setZoom(z) { zoom = clampZoom(z); await renderAll(); return zoom; }
  const zoomIn = () => setZoom(zoom * 1.2);
  const zoomOut = () => setZoom(zoom / 1.2);
  const fit = () => setZoom(fitZoom());

  /* ------------------------------- helpers ------------------------------ */
  function sampleBg(canvas, box) {
    try {
      const left = parseFloat(box.style.left) || 0;
      const top = parseFloat(box.style.top) || 0;
      const x = Math.max(0, Math.round((left + 1) * dpr));
      const y = Math.max(0, Math.round((top - 2) * dpr));
      const d = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
      return `rgb(${d[0]},${d[1]},${d[2]})`;
    } catch {
      return '#ffffff';
    }
  }

  /* ----------------------------- masking -------------------------------- */
  /**
   * Permanently erase an object's ORIGINAL glyphs from the raster canvas by
   * painting the page background over its original bounding box. After this the
   * only text visible in that region is the editable box's model text — so a
   * shortened or emptied string can never re-expose the original PDF characters.
   * Idempotent and re-applied on every render (the raster is repainted on zoom).
   */
  function maskOriginal(p, item) {
    if (!p.viewport || !p.canvas) return;
    const t = pdfjsLib.Util.transform(p.viewport.transform, item.transform);
    const fontSize = Math.hypot(t[2], t[3]);
    if (fontSize < 2) return;
    const scale = CSS_UNITS * zoom;
    const fsUnit = Math.hypot(item.transform[2], item.transform[3]) || 1;
    // Cover the full ORIGINAL advance width (not the current, possibly shorter one).
    let w = (item.width || 0) * scale;
    if (w < 1) w = engine.measureWidth(item.orig || '', cssFontFor(item, fsUnit)) * scale;
    if (w < 1) return;
    const left = t[4];
    const top = t[5] - fontSize;
    const ctx = p.canvas.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = pageBgColor(ctx, left, top, fontSize);
    ctx.fillRect(
      Math.floor((left - 1) * dpr),
      Math.floor(top * dpr),
      Math.ceil((w + 2) * dpr),
      Math.ceil(fontSize * 1.25 * dpr)
    );
    ctx.restore();
    item.masked = true;
    p.boxEls?.get(item.id)?.classList.add('is-masked');
  }

  /** Re-mask every edited object on a page (after the raster is (re)painted). */
  function maskEditedRuns(p) {
    for (const item of p.items) {
      item.masked = item.edited; // masked state tracks the model
      if (item.edited) maskOriginal(p, item);
    }
  }

  /** Sample the page background near a run (brightest of a few probes ≈ paper). */
  function pageBgColor(ctx, left, top, fontSize) {
    const probes = [[left + 1, top - 3], [left - 3, top + fontSize * 0.5], [left + 1, top + fontSize + 3]];
    let best = '#ffffff';
    let bestLum = -1;
    for (const [px, py] of probes) {
      const c = sampleColorAt(ctx, px, py);
      if (!c) continue;
      const lum = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
      if (lum > bestLum) { bestLum = lum; best = `rgb(${c[0]},${c[1]},${c[2]})`; }
    }
    return best;
  }
  function sampleColorAt(ctx, cssX, cssY) {
    try {
      const x = Math.max(0, Math.round(cssX * dpr));
      const y = Math.max(0, Math.round(cssY * dpr));
      const d = ctx.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    } catch {
      return null;
    }
  }

  function getText() {
    return pages.map((p) => p.items.map((i) => i.str).join(' ')).join('\n\n');
  }

  function destroy() {
    if (endEditing) { endEditing(); endEditing = null; }
    try { pdfDoc?.destroy(); } catch { /* already gone */ }
    container.replaceChildren();
    container.classList.remove('pdfedit');
  }

  /** Toggle between editing and a read-only "view" of the edited model. */
  function setEditable(on) {
    editableState = on;
    const pe = container.querySelector('.pdfedit');
    pe?.classList.toggle('is-readonly', !on);
    for (const p of pages) {
      p.layer?.querySelectorAll('.pdfrun').forEach((box) => { box.contentEditable = on ? 'true' : 'false'; });
    }
    // Leaving edit mode: forget the last-focused run so a later formatting call
    // can't target a stale box.
    if (!on) { focused = null; lastFocused = null; }
    // Open/close a keyboard editing session so workspace shortcuts (space-to-pan,
    // etc.) are suspended while this in-place editor is live, and restored on Done.
    if (on && !endEditing) endEditing = keyboard.beginEditing();
    else if (!on && endEditing) { endEditing(); endEditing = null; }
  }

  /**
   * The authoritative model: positioned text objects with their (possibly
   * edited) text + style. This is what Save/Export consumes.
   */
  function getModel() {
    return {
      kind: 'pdf-layout',
      layoutMode,
      pages: pages.map((p) => ({
        page: p.num,
        size: { width: p.unit.w, height: p.unit.h },
        items: p.items.map((i) => ({ str: i.str, orig: i.orig, edited: i.edited, transform: i.transform, style: { ...i.style } })),
      })),
    };
  }

  /** Whether any text has been changed from the original. */
  const isDirty = () => pages.some((p) => p.items.some((i) => i.edited));

  /**
   * Switch overflow strategy. 'preserve' keeps the page identical and warns when
   * text won't fit; 'reflow' wraps overflowing runs and pushes objects down.
   * Re-lays out every page immediately so the change is visible at once.
   */
  function setLayoutMode(mode) {
    const next = mode === LAYOUT_MODES.REFLOW ? LAYOUT_MODES.REFLOW : LAYOUT_MODES.PRESERVE;
    if (next === layoutMode) return layoutMode;
    layoutMode = next;
    engine.setMode(next);
    lastWarnKey = null;
    for (const p of pages) applyLayout(p);
    return layoutMode;
  }
  const getLayoutMode = () => layoutMode;

  return {
    load,
    focus: () => scroll.focus(),
    setEditable,
    setLayoutMode,
    getLayoutMode,
    getModel,
    isDirty,
    toggleMark,
    setStyle,
    undo,
    redo,
    zoomIn,
    zoomOut,
    fit,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    getText,
    destroy,
  };
}

function mapFamily(fam) {
  const f = (fam || '').toLowerCase();
  if (/times|serif|georgia|roman|minion/.test(f) && !/sans/.test(f)) return 'Georgia, serif';
  if (/mono|courier|consol/.test(f)) return 'monospace';
  return 'Inter, Arial, sans-serif';
}
