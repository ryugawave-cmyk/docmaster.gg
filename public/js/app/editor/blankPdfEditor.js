/**
 * Blank PDF authoring editor — a from-scratch, object-based, multi-page editor.
 *
 * Starts from an empty page and lets the user compose a document from primitives
 * (text, shapes, images, ink, highlights, signatures, comments, links, stamps),
 * the way a design tool would. It owns:
 *
 *   • a scrollable, zoomable page (A4/Letter/Legal) with a soft drop shadow;
 *   • a multi-page document model (pages[] each with their own object list);
 *   • pointer-driven create / select / move / resize / delete, snapping + guides;
 *   • a plain-data model so undo/redo is a whole-document snapshot stack;
 *   • selection → a descriptor the properties panel understands + `applyProperty`.
 *
 * It knows nothing about the surrounding chrome: the host passes callbacks
 * (onSelect / onHistory / onToolChange / onZoom / onDirty / onPages / onDims) and
 * drives it through an imperative API. Model coordinates are page pixels (@96dpi);
 * the page element is CSS-scaled for zoom.
 */
import { el } from '../../workspace/utils/dom.js';
import { renderIcon } from '../../workspace/icons.js';
import { keyboard } from '../core/keyboard.js';
import { recognizeRegion, isOcrAvailable, OcrUnavailableError } from '../core/ai/ocr.js';
import { createDocument } from '../core/document/document.js';
import { syncEditorToModel, pagesToEditorSnapshot, exportModelFromDoc } from './documentSync.js';
import { stampSvgMarkup } from './stampLibrary.js';

// Page presets @96 CSS DPI → [width px, height px, "W × H cm" label].
const SIZES = {
  A4: [794, 1123, '21 × 29.7 cm'],
  Letter: [816, 1056, '21.6 × 27.9 cm'],
  Legal: [816, 1344, '21.6 × 35.6 cm'],
};
const MIN_SIZE = 8;

let UID = 0;
const uid = (p) => `${p}${++UID}`;

/** Escape a raw string for safe use as a text object's innerHTML content. */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Map an object type to the selection kind the properties panel resolves. */
const KIND_BY_TYPE = { text: 'text', comment: 'text', image: 'image', shape: 'shape', draw: 'shape', link: 'shape', stamp: 'stamp' };

export function createBlankPdfEditor({
  container,
  onSelect = () => {},
  onHistory = () => {},
  onToolChange = () => {},
  onZoom = () => {},
  onDirty = () => {},
  onWarn = () => {},
  onPages = () => {},
  onDims = () => {},
  onContext = () => {},
}) {
  /* ------------------------------- state -------------------------------- */
  let pageName = 'A4';
  let PW = SIZES.A4[0];
  let PH = SIZES.A4[1];
  let pages = [makePage()];
  let pageIndex = 0;
  let objects = pages[0].objects; // live reference to the current page's objects
  let selectedId = null;
  let tool = 'select';
  let pendingShape = 'rect'; // which shape the Shape tool draws next (set by the toolbar picker)
  let zoom = 1;
  let active = false;
  // Canonical document/history model — the single source of truth for undo/redo
  // and page operations. The editor's whole-document snapshots are recorded as
  // Commands on `doc.history` (see the history section below), replacing the old
  // local past/future arrays. Exposed via getDocumentModel().
  const doc = createDocument();
  let endEditingText = null;
  let clipboard = null; // plain-data copy of an object for paste (in-editor clipboard)
  let lastPointer = { x: PW / 2, y: PH / 2 }; // last page-space cursor (paste / context target)
  let lastDown = { id: null, t: 0 }; // last pointerdown on an object (for manual double-click detection)
  // Import provenance: an imported PDF is a flattened page image, so its ORIGINAL
  // text isn't an editable object. These let the Edit tool explain that (and flag
  // scanned/OCR-needed docs) instead of silently doing nothing on a text click.
  let imported = false;      // current document came from an imported PDF
  let importScanned = false; // imported PDF had no extractable text layer (needs OCR)
  let editHintShown = false; // one-shot: don't nag on every background click

  function makePage() { return { id: uid('pg'), objects: [] }; }

  /* --------------------------------- DOM -------------------------------- */
  const pageBg = el('div', { class: 'bpe-pagebg' }); // imported PDF page image (behind objects)
  const layer = el('div', { class: 'bpe-layer' });
  const ink = el('div', { class: 'bpe-ink' });
  const guides = el('div', { class: 'bpe-guides' });
  const page = el('div', { class: 'bpe-page' }, [pageBg, layer, ink, guides]);
  const box = el('div', { class: 'bpe-pagebox' }, page);
  const viewport = el('div', { class: 'bpe-viewport', tabindex: '0' }, box);
  const rootEl = el('div', { class: 'bpe', dataset: { tool: 'select' } }, viewport);
  container.appendChild(rootEl);
  applyPageSize();
  applyZoom();

  /* ------------------------- pointer interactions ----------------------- */
  page.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointerdown', (e) => {
    if (e.target !== viewport && e.target !== box) return;
    if (endEditingText) layer.querySelector('.bpe-obj.is-editing')?.querySelector('.bpe-text')?.blur();
    if (tool === 'select') select(null);
  });

  // Right-click → context menu. Select whatever is under the cursor first, then
  // hand a context descriptor to the host so it can render the menu at the mouse.
  viewport.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    lastPointer = pagePoint(e);
    // Inside an active text edit, keep the native caret menu (copy/paste text).
    const editing = layer.querySelector('.bpe-obj.is-editing');
    if (editing && editing.contains(e.target)) return;
    // Right-clicking elsewhere commits any in-progress edit first.
    if (editing) editing.querySelector('.bpe-text')?.blur();
    const node = e.target.closest('.bpe-obj');
    if (node) select(node.dataset.id);
    else select(null);
    const obj = node ? find(node.dataset.id) : null;
    onContext({
      clientX: e.clientX, clientY: e.clientY,
      target: obj ? contextCategory(obj.type) : 'empty',
      locked: !!obj?.locked,
      hasClipboard: clipboard != null,
      canUndo: doc.canUndo(), canRedo: doc.canRedo(),
    });
  });

  // Drag-and-drop a stamp from the library panel onto the page. The panel item
  // carries its definition as JSON on the drag, so this handler is self-contained.
  viewport.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('application/x-dm-stamp')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  });
  viewport.addEventListener('drop', (e) => {
    const raw = e.dataTransfer?.getData('application/x-dm-stamp');
    if (!raw) return;
    e.preventDefault();
    try { insertStamp(JSON.parse(raw), clientToPage(e.clientX, e.clientY)); } catch { /* bad payload */ }
  });

  function contextCategory(type) {
    if (type === 'text' || type === 'comment') return 'text';
    if (type === 'image') return 'image';
    return 'shape';
  }

  function pagePoint(e) {
    const r = page.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    lastPointer = pagePoint(e);
    if (e.target.closest('.bpe-rotate')) return startRotate(e);
    const handle = e.target.closest('.bpe-handle');
    if (handle) return startResize(e, handle);

    const node = e.target.closest('.bpe-obj');
    if (node && node.classList.contains('is-editing')) return;
    if (endEditingText) {
      const editing = layer.querySelector('.bpe-obj.is-editing');
      if (editing && !editing.contains(e.target)) editing.querySelector('.bpe-text')?.blur();
    }

    if (tool === 'select') {
      if (node) {
        const id = node.dataset.id;
        const obj = find(id);
        const isEditableText = obj && (obj.type === 'text' || obj.type === 'comment') && !obj.locked;
        // Double-click-to-edit, detected manually: the first click's startMove
        // takes pointer capture on `page`, which makes the browser SUPPRESS the
        // native dblclick entirely — so a real double-click never fires an event
        // we could listen for. We instead spot the second quick press on the same
        // object here. This is the reliable, repeatable way to (re-)enter editing,
        // especially for an emptied imported run that has no glyph left to aim two
        // separate deliberate clicks at.
        const isDbl = lastDown.id === id && (e.timeStamp - lastDown.t) < 400;
        const isDblClick = isEditableText && isDbl;
        lastDown = { id, t: e.timeStamp };
        if (isDbl && obj && obj.type === 'image' && !obj.locked) {
          // Second quick press on an image: DRAG if the pointer travels, else open
          // the crop editor. Without this a select-then-drag inside the dbl-click
          // window is mistaken for a double-click and swallowed as a crop, so the
          // image feels un-draggable. Mirrors startMoveOrEdit for text.
          select(id);
          startMoveOrCrop(e, obj);
        } else if (isDblClick) {
          select(id);
          editText(obj, { x: e.clientX, y: e.clientY });
        } else if (selectedId === id && isEditableText) {
          // Already-selected text: a plain click enters editing (type immediately),
          // a drag moves it. This is what makes re-editing the same run reliable.
          startMoveOrEdit(e, obj);
        } else {
          select(id);
          // Locked objects can be selected (to unlock) but never dragged.
          if (!obj?.locked) startMove(e);
        }
      } else {
        lastDown = { id: null, t: 0 };
        select(null);
        maybeExplainFlattened();
      }
      return;
    }
    const p = pagePoint(e);
    if (tool === 'text') return createTextAt(p);
    if (tool === 'comment') return createCommentAt(p);
    if (tool === 'stamp') return createStampAt(p);
    if (tool === 'shape') return startRubberband(e, p, 'shape');
    if (tool === 'highlight') return startRubberband(e, p, 'highlight');
    if (tool === 'link') return startRubberband(e, p, 'link');
    if (tool === 'draw') return startDraw(e, p);
    if (tool === 'ocr') return startOcrRegion(e, p);
  }

  // A scanned PDF has no text layer, so its "text" is pixels with nothing to
  // click. Rather than a silent no-op, tell the user OCR is needed. (Real-text
  // PDFs get editable text boxes on import, so no hint is needed for them.)
  function maybeExplainFlattened() {
    if (!imported || editHintShown || !importScanned || !pages[pageIndex]?.bg) return;
    editHintShown = true;
    onWarn('This looks like a scanned PDF — its text is an image, so it can’t be edited as text.');
  }

  /* ----- move (with smart snapping + guides) ----- */
  // While dragging we move the node with a `transform: translate` (composited by
  // the GPU, no per-frame layout/paint) instead of writing left/top; on drop we
  // commit the final position with place(). This is what keeps dragging smooth,
  // especially over a large imported page raster.
  function dragTransform(obj, ox, oy) {
    const rot = obj.rotation ? ` rotate(${obj.rotation}deg)` : '';
    return `translate(${obj.x - ox}px, ${obj.y - oy}px)${rot}`;
  }
  function startMove(e) {
    const obj = find(selectedId);
    if (!obj) return;
    const start = pagePoint(e);
    const ox = obj.x, oy = obj.y;
    const node = nodeOf(obj.id);
    const targets = snapTargets(obj.id);
    let dirty = false;
    node?.classList.add('is-dragging');
    drag(e, (cur) => {
      if (!dirty) { dirty = true; pushUndo(); }
      const rawX = clamp(ox + (cur.x - start.x), -obj.w + 20, PW - 20);
      const rawY = clamp(oy + (cur.y - start.y), -obj.h + 20, PH - 20);
      const snapped = e.altKey ? { x: rawX, y: rawY, guides: [] } : computeSnap(obj, rawX, rawY, targets);
      obj.x = snapped.x; obj.y = snapped.y;
      renderGuides(snapped.guides);
      if (node) node.style.transform = dragTransform(obj, ox, oy);
    }, () => { node?.classList.remove('is-dragging'); place(obj); clearGuides(); if (dirty) onDirty(); });
  }

  // A click on an already-selected text box either MOVES it (if the pointer
  // travels past a small threshold) or, on a plain click with no drag, enters
  // text editing. Done here (not via a dblclick listener) so pointer capture
  // from the drag can't swallow the edit gesture.
  function startMoveOrEdit(e, obj) {
    const start = pagePoint(e);
    const ox = obj.x, oy = obj.y;
    const node = nodeOf(obj.id);
    const targets = snapTargets(obj.id);
    let moved = false;
    drag(e, (cur) => {
      if (!moved && Math.hypot(cur.x - start.x, cur.y - start.y) < 3) return; // ignore jitter
      if (!moved) { moved = true; pushUndo(); node?.classList.add('is-dragging'); }
      const rawX = clamp(ox + (cur.x - start.x), -obj.w + 20, PW - 20);
      const rawY = clamp(oy + (cur.y - start.y), -obj.h + 20, PH - 20);
      const snapped = e.altKey ? { x: rawX, y: rawY, guides: [] } : computeSnap(obj, rawX, rawY, targets);
      obj.x = snapped.x; obj.y = snapped.y;
      renderGuides(snapped.guides);
      if (node) node.style.transform = dragTransform(obj, ox, oy);
    }, () => {
      clearGuides();
      if (moved) { node?.classList.remove('is-dragging'); place(obj); onDirty(); }
      else editText(obj, { x: e.clientX, y: e.clientY }); // plain click → edit
    });
  }

  // A quick second press on an already-selected image either MOVES it (if the
  // pointer travels past the jitter threshold) or, on a stationary double-click,
  // opens the crop editor. Same shape as startMoveOrEdit so dragging always wins
  // over the double-click-to-crop shortcut.
  function startMoveOrCrop(e, obj) {
    const start = pagePoint(e);
    const ox = obj.x, oy = obj.y;
    const node = nodeOf(obj.id);
    const targets = snapTargets(obj.id);
    let moved = false;
    drag(e, (cur) => {
      if (!moved && Math.hypot(cur.x - start.x, cur.y - start.y) < 3) return; // ignore jitter
      if (!moved) { moved = true; pushUndo(); node?.classList.add('is-dragging'); }
      const rawX = clamp(ox + (cur.x - start.x), -obj.w + 20, PW - 20);
      const rawY = clamp(oy + (cur.y - start.y), -obj.h + 20, PH - 20);
      const snapped = e.altKey ? { x: rawX, y: rawY, guides: [] } : computeSnap(obj, rawX, rawY, targets);
      obj.x = snapped.x; obj.y = snapped.y;
      renderGuides(snapped.guides);
      if (node) node.style.transform = dragTransform(obj, ox, oy);
    }, () => {
      clearGuides();
      if (moved) { node?.classList.remove('is-dragging'); place(obj); onDirty(); }
      else cropImage(); // stationary double-click → crop
    });
  }

  // Build the snap target lines ONCE at the start of a drag. They don't change
  // while dragging (only the moving object moves, and it's excluded), so doing
  // this per pointer-move was O(objects) every frame — the main cause of laggy,
  // sticky dragging on a dense imported page. Imported runs are excluded: the
  // page's baked-in text would make every drag feel magnetic and slow.
  function snapTargets(exceptId) {
    const xt = [0, PW / 2, PW];
    const yt = [0, PH / 2, PH];
    for (const o of objects) {
      if (o.id === exceptId || o.imported) continue;
      xt.push(o.x, o.x + o.w / 2, o.x + o.w);
      yt.push(o.y, o.y + o.h / 2, o.y + o.h);
    }
    return { xt, yt };
  }

  function computeSnap(obj, rawX, rawY, targets) {
    const t = 6 / zoom;
    const { xt, yt } = targets || snapTargets(obj.id);
    let x = rawX, y = rawY;
    const g = [];
    let bx = null;
    for (const [edge, off] of [[rawX, 0], [rawX + obj.w / 2, obj.w / 2], [rawX + obj.w, obj.w]]) {
      for (const tx of xt) { const d = Math.abs(edge - tx); if (d <= t && (!bx || d < bx.d)) bx = { d, x: tx - off, pos: tx }; }
    }
    if (bx) { x = bx.x; g.push({ axis: 'v', pos: bx.pos }); }
    let by = null;
    for (const [edge, off] of [[rawY, 0], [rawY + obj.h / 2, obj.h / 2], [rawY + obj.h, obj.h]]) {
      for (const ty of yt) { const d = Math.abs(edge - ty); if (d <= t && (!by || d < by.d)) by = { d, y: ty - off, pos: ty }; }
    }
    if (by) { y = by.y; g.push({ axis: 'h', pos: by.pos }); }
    return { x, y, guides: g };
  }
  function renderGuides(list) {
    guides.replaceChildren(...list.map((g) => el('div', {
      class: `bpe-guide bpe-guide--${g.axis}`,
      style: g.axis === 'v' ? `left:${g.pos}px` : `top:${g.pos}px`,
    })));
  }
  function clearGuides() { if (guides.firstChild) guides.replaceChildren(); }

  /* ----- resize ----- */
  function startResize(e, handle) {
    e.stopPropagation();
    const obj = find(selectedId);
    if (!obj || obj.locked) return;
    const dir = handle.dataset.dir;
    const start = pagePoint(e);
    const o = { x: obj.x, y: obj.y, w: obj.w, h: obj.h };
    let dirty = false;
    drag(e, (cur) => {
      if (!dirty) { dirty = true; pushUndo(); }
      const dx = cur.x - start.x, dy = cur.y - start.y;
      let { x, y, w, h } = o;
      if (dir.includes('e')) w = o.w + dx;
      if (dir.includes('s')) h = o.h + dy;
      if (dir.includes('w')) { w = o.w - dx; x = o.x + dx; }
      if (dir.includes('n')) { h = o.h - dy; y = o.y + dy; }
      if (w < MIN_SIZE) { w = MIN_SIZE; if (dir.includes('w')) x = o.x + o.w - MIN_SIZE; }
      if (h < MIN_SIZE) { h = MIN_SIZE; if (dir.includes('n')) y = o.y + o.h - MIN_SIZE; }
      // Stamps keep their design's aspect ratio so the vector art never distorts.
      if (obj.type === 'stamp' && o.w > 0 && o.h > 0) {
        const ratio = o.w / o.h;
        if (dir.length === 1) { // edge handle: scale from the dragged edge
          if (dir === 'e' || dir === 'w') h = w / ratio; else w = h * ratio;
        } else { // corner: follow the larger delta
          if (Math.abs(w - o.w) >= Math.abs(h - o.h)) h = w / ratio; else w = h * ratio;
        }
        if (dir.includes('w')) x = o.x + o.w - w;
        if (dir.includes('n')) y = o.y + o.h - h;
      }
      Object.assign(obj, { x, y, w, h });
      place(obj);
    }, () => { if (dirty) onDirty(); });
  }

  /* ----- rotate (stamps / images / shapes / drawings) ----- */
  // Free rotation about the box centre, driven by the top-centre grip. The grip
  // sits on the object's "up" axis, so grabbing it never jaws the angle — the
  // pointer→centre bearing equals the current rotation, and it tracks from there.
  function startRotate(e) {
    const obj = find(selectedId);
    if (!obj || !canRotate(obj) || obj.locked) return;
    const node = nodeOf(obj.id);
    const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
    let dirty = false;
    let shift = e.shiftKey;
    let last = null;
    // Live angle badge in the (unrotated) page-space guides layer.
    const readout = el('div', { class: 'bpe-rotate-readout' });
    readout.textContent = `${Math.round(obj.rotation || 0)}°`;
    Object.assign(readout.style, { left: `${cx}px`, top: `${obj.y - 6}px` });
    guides.appendChild(readout);
    node?.classList.add('is-dragging');
    const apply = (cur) => {
      last = cur;
      if (!dirty) { dirty = true; pushUndo(); }
      // +90° so the top-centre grip corresponds to 0°; normalise to 0–360.
      let deg = Math.atan2(cur.y - cy, cur.x - cx) * 180 / Math.PI + 90;
      if (shift) deg = Math.round(deg / 15) * 15; // Shift → snap to 15°
      deg = ((deg % 360) + 360) % 360;
      obj.rotation = Math.round(deg * 10) / 10;
      if (node) node.style.transform = `rotate(${obj.rotation}deg)`;
      readout.textContent = `${Math.round(obj.rotation)}°`;
      Object.assign(readout.style, { left: `${cx}px`, top: `${obj.y - 6}px` });
    };
    // Track Shift live so snapping toggles mid-drag even without pointer motion.
    const onShift = (ev) => { if (ev.key === 'Shift') { shift = ev.type === 'keydown'; if (last) apply(last); } };
    window.addEventListener('keydown', onShift, true);
    window.addEventListener('keyup', onShift, true);
    drag(e, apply, () => {
      window.removeEventListener('keydown', onShift, true);
      window.removeEventListener('keyup', onShift, true);
      readout.remove();
      node?.classList.remove('is-dragging');
      place(obj);
      if (dirty) { onDirty(); onSelect(descriptorFor(obj)); }
    });
  }

  /* ----- rubber-band create (shape / highlight / link) ----- */
  function startRubberband(e, origin, kind) {
    const presets = {
      highlight: { type: 'shape', shape: 'rect', fill: '#ffe64d', stroke: 'transparent', strokeWidth: 0, radius: 2, opacity: 0.4 },
      shape: { type: 'shape', shape: pendingShape, fill: '#e0e7ff', stroke: '#4f46e5', strokeWidth: 1.5, radius: pendingShape === 'roundRect' ? 16 : 4, opacity: 1 },
      link: { type: 'link', href: '' },
    };
    const preset = presets[kind];
    const preview = el('div', { class: `bpe-preview${kind === 'highlight' ? ' bpe-preview--hl' : ''}` });
    ink.appendChild(preview);
    let rect = { x: origin.x, y: origin.y, w: 0, h: 0 };
    const draw = () => Object.assign(preview.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
    draw();
    drag(e, (cur) => {
      rect = { x: Math.min(origin.x, cur.x), y: Math.min(origin.y, cur.y), w: Math.abs(cur.x - origin.x), h: Math.abs(cur.y - origin.y) };
      draw();
    }, () => {
      ink.replaceChildren();
      if (rect.w < MIN_SIZE && rect.h < MIN_SIZE) { rect.w = kind === 'link' ? 180 : 160; rect.h = kind === 'link' ? 44 : 90; }
      if (kind === 'link') {
        const href = window.prompt('Link URL', 'https://') || '';
        addObject({ ...preset, x: rect.x, y: rect.y, w: rect.w, h: rect.h, href });
      } else {
        addObject({ ...preset, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
      }
    });
  }

  /* ----- freehand draw ----- */
  function startDraw(e, origin) {
    const pts = [origin];
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const svg = el('svg', { class: 'bpe-ink__svg' });
    svg.setAttribute('viewBox', `0 0 ${PW} ${PH}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#1f2937');
    path.setAttribute('stroke-width', '2.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    ink.appendChild(svg);
    const redraw = () => path.setAttribute('d', toPath(pts));
    redraw();
    drag(e, (cur) => { pts.push(cur); redraw(); }, () => {
      ink.replaceChildren();
      if (pts.length < 2) return;
      const b = bbox(pts, 6);
      const rel = pts.map((p) => ({ x: p.x - b.x, y: p.y - b.y }));
      addObject({ type: 'draw', x: b.x, y: b.y, w: b.w, h: b.h, points: rel, stroke: '#1f2937', strokeWidth: 2.5, opacity: 1 });
    });
  }

  /* ----- AI "make editable": marquee a baked region → OCR → editable text ----- */
  // The user drags a box over baked content — e.g. a complex-script block (Hindi,
  // Arabic, …) that Exact mode left in the raster because the PDF's own text is
  // scrambled. On release we crop that region, recognise it on-device, and drop a
  // masked, editable text run in its place. Mirrors startRubberband's marquee.
  function startOcrRegion(e, origin) {
    const preview = el('div', { class: 'bpe-preview bpe-preview--ocr' });
    ink.appendChild(preview);
    let rect = { x: origin.x, y: origin.y, w: 0, h: 0 };
    const draw = () => Object.assign(preview.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
    draw();
    drag(e, (cur) => {
      rect = { x: Math.min(origin.x, cur.x), y: Math.min(origin.y, cur.y), w: Math.abs(cur.x - origin.x), h: Math.abs(cur.y - origin.y) };
      draw();
    }, () => {
      ink.replaceChildren();
      setTool('select');
      if (rect.w < 6 || rect.h < 6) return; // ignore a stray click, not a drag
      makeRegionEditable(rect);
    });
  }

  /** Crop a page-space rectangle out of the current page's raster background at
   *  its native resolution → a PNG data URL the recogniser reads. Returns null
   *  when there's no page image, the rect is empty, or the raster is unreadable. */
  function cropPageRaster(rect) {
    return new Promise((resolve) => {
      const bg = pages[pageIndex]?.bg;
      if (!bg) { resolve(null); return; }
      const img = new Image();
      img.onload = () => {
        try {
          const rf = img.naturalWidth / (pages[pageIndex]?.w || PW); // raster px per css px
          const sx = Math.max(0, Math.round(rect.x * rf));
          const sy = Math.max(0, Math.round(rect.y * rf));
          const sw = Math.min(img.naturalWidth - sx, Math.round(rect.w * rf));
          const sh = Math.min(img.naturalHeight - sy, Math.round(rect.h * rf));
          if (sw < 2 || sh < 2) { resolve(null); return; }
          const cvs = document.createElement('canvas');
          cvs.width = sw; cvs.height = sh;
          cvs.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
          resolve({ dataURL: cvs.toDataURL('image/png'), w: sw, h: sh });
        } catch { resolve(null); } // tainted/unreadable raster
      };
      img.onerror = () => resolve(null);
      img.src = bg;
    });
  }

  // True when a region rectangle covers an object's box (its centre lies inside),
  // used to clear the baked overlays the recognised text replaces.
  function rectCoversObject(rect, o) {
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
  }

  /**
   * AI "make editable": turn a baked region of an imported page into an editable
   * text box. Crops the region, runs on-device OCR (see core/ai/ocr.js), samples a
   * paper-colour mask, then adds a REVEALED imported-style run — its `boxBg` hides
   * the baked glyphs underneath while the recognised text stays fully editable,
   * exactly like a normally-lifted imported run. Any dormant imported runs the
   * region covers are removed first so the recognised text is the single source.
   * The whole thing is one undo step. No-ops with a friendly toast when OCR isn't
   * installed or the region can't be read.
   * @param {{x:number,y:number,w:number,h:number}} rect  page-space px (@96dpi)
   * @returns {Promise<object|null>} the created text object, or null
   */
  async function makeRegionEditable(rect) {
    if (!pages[pageIndex]?.bg) { onWarn('Open an imported PDF page first.'); return null; }
    if (!isOcrAvailable()) {
      onWarn('On-device text recognition isn’t installed yet — it turns baked text (e.g. Hindi) back into editable text.');
      return null;
    }
    const crop = await cropPageRaster(rect);
    if (!crop) { onWarn('Couldn’t read that region.'); return null; }

    let result;
    try {
      const lang = ocrLangHint(rect);
      result = await recognizeRegion({ dataURL: crop.dataURL, width: crop.w, height: crop.h, lang });
    } catch (err) {
      onWarn(err instanceof OcrUnavailableError ? err.message : 'Text recognition failed on that region.');
      return null;
    }

    const lines = (result.lines && result.lines.length)
      ? result.lines.map((l) => l.text)
      : String(result.text || '').split('\n');
    const clean = lines.map((s) => s.replace(/\s+$/, ''));
    while (clean.length && !clean[clean.length - 1].trim()) clean.pop();
    if (!clean.join('').trim()) { onWarn('No text found in that region.'); return null; }

    const bg = await samplePaperColor(rect.x, rect.y, rect.w, rect.h);
    pushUndo();
    // Clear dormant imported runs under the region so the recognised text is the
    // one source and its mask isn't fighting older (garbled) overlays.
    for (const o of objects.slice()) {
      if (o.imported && o.type === 'text' && !o.edited && rectCoversObject(rect, o)) removeObject(o.id);
    }
    const fontSize = clamp(Math.round((rect.h / clean.length) * 0.72), 8, 96);
    const obj = {
      id: uid('o'), type: 'text', imported: true, revealed: true, edited: true,
      x: rect.x, y: rect.y, w: Math.max(rect.w, 8), h: Math.max(rect.h, 10), h0: Math.max(rect.h, 10),
      rotation: 0, text: clean.map(escapeHtml).join('<br>'),
      fontFamily: 'Arial, Helvetica, sans-serif', fontSize,
      color: '#111827', align: 'left', lineHeight: 1.15, letterSpacing: 0,
      bold: false, italic: false, underline: false, strike: false,
      highlight: 'transparent', boxBg: bg || 'transparent', textCase: 'none', opacity: 1, locked: false,
    };
    objects.push(obj);
    layer.appendChild(buildNode(obj));
    place(obj);
    onDirty();
    select(obj.id);
    return obj;
  }

  /** Script hint for the recogniser, derived from any baked imported run whose
   *  box the region covers (their `text` still carries the PDF's own Unicode, so
   *  even a scrambled Devanagari run reliably identifies the SCRIPT). Falls back to
   *  undefined so the engine auto-detects. */
  function ocrLangHint(rect) {
    for (const o of objects) {
      if (o.imported && o.type === 'text' && rectCoversObject(rect, o)) {
        const s = htmlToText(o.text || '');
        if (/[ऀ-ॿ]/.test(s)) return 'hin';
        if (/[؀-ۿ]/.test(s)) return 'ara';
        if (/[฀-๿]/.test(s)) return 'tha';
        if (/[ঀ-৿]/.test(s)) return 'ben';
        if (/[஀-௿]/.test(s)) return 'tam';
      }
    }
    return undefined;
  }

  function drag(e, onMove, onUp) {
    page.setPointerCapture?.(e.pointerId);
    // Cache the page's screen rect for the drag's lifetime. It doesn't move while
    // dragging, so re-reading getBoundingClientRect on every pointermove is waste
    // — and worse, each move also writes styles via place(), so reading layout
    // mid-drag forces a synchronous reflow of the whole page tree every event.
    // On a dense imported page that reflow makes the drag stutter and feel stuck.
    // Measure once here (refresh only if the viewport scrolls) so the move handler
    // does zero layout reads and the browser batches the writes to one paint/frame.
    let rect = page.getBoundingClientRect();
    const refresh = () => { rect = page.getBoundingClientRect(); };
    const pt = (ev) => ({ x: (ev.clientX - rect.left) / zoom, y: (ev.clientY - rect.top) / zoom });
    // Frame-throttle: pointermove can fire several times per frame; coalesce to
    // the latest point and run onMove once per animation frame. This keeps the
    // work in sync with the display and stops move events from piling up faster
    // than we can paint (the "stuck / laggy" feel).
    let pending = null;
    let rafId = 0;
    const flush = () => { rafId = 0; if (pending) { const p = pending; pending = null; onMove(p); } };
    const move = (ev) => { pending = pt(ev); if (!rafId) rafId = requestAnimationFrame(flush); };
    const up = (ev) => {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      if (pending) { onMove(pending); pending = null; } // apply the final position
      viewport.removeEventListener('scroll', refresh);
      page.removeEventListener('pointermove', move);
      page.removeEventListener('pointerup', up);
      page.removeEventListener('pointercancel', up);
      onUp?.(pt(ev));
    };
    viewport.addEventListener('scroll', refresh);
    page.addEventListener('pointermove', move);
    page.addEventListener('pointerup', up);
    page.addEventListener('pointercancel', up);
  }

  /* ------------------------------ objects ------------------------------- */
  function addObject(data) {
    pushUndo();
    const obj = { id: uid('o'), rotation: 0, ...data };
    objects.push(obj);
    layer.appendChild(buildNode(obj));
    place(obj);
    onDirty();
    select(obj.id);
    setTool('select');
    return obj;
  }

  function createTextAt(p) {
    pushUndo();
    const obj = {
      id: uid('o'), type: 'text', x: clamp(p.x, 0, PW - 220), y: clamp(p.y, 0, PH - 40),
      w: 220, h: 40, rotation: 0, text: '', fontFamily: 'Inter', fontSize: 16, color: '#111827',
      align: 'left', lineHeight: 1.4, letterSpacing: 0, bold: false, italic: false, underline: false, strike: false,
      highlight: 'transparent', textCase: 'none', opacity: 1, locked: false,
    };
    objects.push(obj);
    layer.appendChild(buildNode(obj));
    place(obj);
    onDirty();
    select(obj.id);
    setTool('select');
    requestAnimationFrame(() => editText(obj));
  }

  function createCommentAt(p) {
    pushUndo();
    const obj = {
      id: uid('o'), type: 'comment', x: clamp(p.x, 0, PW - 200), y: clamp(p.y, 0, PH - 80),
      w: 200, h: 78, rotation: 0, text: '', fontFamily: 'Inter', fontSize: 13, color: '#78350f',
      align: 'left', lineHeight: 1.4, letterSpacing: 0, bold: false, italic: false, underline: false, strike: false,
      highlight: 'transparent', textCase: 'none', opacity: 1, locked: false,
    };
    objects.push(obj);
    layer.appendChild(buildNode(obj));
    place(obj);
    onDirty();
    select(obj.id);
    setTool('select');
    requestAnimationFrame(() => editText(obj));
  }

  function createStampAt(p) {
    insertStamp({ text: 'APPROVED', style: 'double', color: '#dc2626', w: 182, h: 70 }, p);
  }

  /** Insert a stamp from the library. `at` is an optional page-space point (its
   *  centre); without one the stamp lands at the last cursor position / view. */
  function insertStamp(def, at) {
    const w = def.w || 182, h = def.h || 70;
    const p = at || lastPointer;
    return addObject({
      type: 'stamp', text: def.text || 'STAMP', style: def.style || 'double',
      color: def.color || '#dc2626', opacity: 1,
      x: clamp(p.x - w / 2, 0, Math.max(0, PW - w)),
      y: clamp(p.y - h / 2, 0, Math.max(0, PH - h)),
      w, h, rotation: def.rotation ?? -8,
    });
  }

  /** Convert client (screen) coordinates to page-space — used by stamp drop. */
  function clientToPage(clientX, clientY) {
    const r = page.getBoundingClientRect();
    return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom };
  }

  function buildNode(obj) {
    const cls = `bpe-obj bpe-obj--${obj.type}${obj.imported ? ' bpe-obj--imported' : ''}${obj.locked ? ' is-locked' : ''}`;
    const node = el('div', { class: cls, dataset: { id: obj.id } });
    node.appendChild(content(obj));
    return node;
  }

  function content(obj) {
    if (obj.type === 'text' || obj.type === 'comment') {
      const wrap = obj.type === 'comment' ? el('div', { class: 'bpe-comment' }) : null;
      const t = el('div', { class: 'bpe-text', contenteditable: 'false' });
      t.innerHTML = obj.text || '';
      applyTextStyle(obj, t);
      // NOTE: double-click-to-edit is handled at the page level (see the `page`
      // dblclick listener), not here — startMove sets pointer capture on `page`,
      // which retargets click/dblclick away from this element.
      t.addEventListener('input', () => { obj.text = t.innerHTML; sizeTextToContent(obj, t); });
      // Ignore blur when focus moves into the floating toolbar so its buttons
      // don't tear down the edit session mid-click.
      t.addEventListener('blur', (e) => { if (inlineBar && inlineBar.contains(e.relatedTarget)) return; stopEditText(obj, t); });
      if (wrap) { wrap.appendChild(el('span', { class: 'bpe-comment__tip', html: renderIcon('comments') })); wrap.appendChild(t); return wrap; }
      return t;
    }
    if (obj.type === 'image') {
      return el('img', { class: 'bpe-img', src: obj.src, alt: '', draggable: 'false', style: imageStyle(obj) });
    }
    if (obj.type === 'shape') {
      return el('div', { class: 'bpe-shape', style: `opacity:${obj.opacity}`, html: shapeSvgMarkup(obj) });
    }
    if (obj.type === 'link') {
      return el('div', { class: 'bpe-link', title: obj.href || '' }, [
        el('span', { class: 'bpe-link__ico', html: renderIcon('open') }),
        el('span', { class: 'bpe-link__url' }, obj.href || 'Link'),
      ]);
    }
    if (obj.type === 'stamp') {
      return el('div', { class: 'bpe-stamp', style: `opacity:${obj.opacity ?? 1}`, html: stampSvgMarkup(obj) });
    }
    if (obj.type === 'draw') {
      return el('div', { class: 'bpe-draw', html: drawSvg(obj) });
    }
    return el('div');
  }

  /* --------------------------- style helpers ---------------------------- */
  function applyTextStyle(obj, t) {
    // Imported PDF text is a transparent, click-to-edit overlay UNTIL the user
    // actually edits it: at rest we hide our re-rendered glyphs + mask so the
    // crisp original raster shows through (no doubled/garbled text, correct for
    // any script/font). Editing a run flips `revealed`, which drops the mask in
    // and paints the editable text over the original.
    const dormant = obj.imported && !obj.revealed;
    Object.assign(t.style, {
      fontFamily: obj.fontFamily,
      fontSize: `${obj.fontSize}px`,
      color: dormant ? 'transparent' : obj.color,
      textAlign: obj.align,
      lineHeight: String(obj.lineHeight),
      letterSpacing: `${obj.letterSpacing}px`,
      fontWeight: obj.bold ? '700' : '400',
      fontStyle: obj.italic ? 'italic' : 'normal',
      textDecoration: [obj.underline && 'underline', obj.strike && 'line-through'].filter(Boolean).join(' ') || 'none',
      // Highlight paints behind the glyphs; a box-level default that inline
      // <mark>/execCommand spans can still override per selection. A revealed
      // imported run falls back to its `boxBg` mask (sampled page colour) so the
      // original glyphs baked into the page image stay hidden beneath the edit.
      background: dormant
        ? 'transparent'
        : (obj.highlight && obj.highlight !== 'transparent'
          ? obj.highlight
          : (obj.boxBg && obj.boxBg !== 'transparent' ? obj.boxBg : 'transparent')),
      textTransform: obj.textCase && obj.textCase !== 'none' ? obj.textCase : 'none',
    });
    const node = nodeOf(obj.id);
    if (node) node.style.opacity = obj.opacity ?? 1;
  }
  function imageStyle(obj) {
    // Signatures carry a `boxBg` (paper colour sampled from the page beneath), so
    // the transparent ink sits on matching paper and hides whatever was under it.
    const bg = obj.boxBg && obj.boxBg !== 'transparent' ? `background:${obj.boxBg};` : '';
    return `${bg}border-radius:${obj.radius || 0}px;opacity:${obj.opacity ?? 1};object-fit:${obj.fit || 'contain'}`;
  }
  function drawSvg(obj) {
    const d = toPath(obj.points);
    return `<svg viewBox="0 0 ${Math.max(obj.w, 1)} ${Math.max(obj.h, 1)}" preserveAspectRatio="none" style="opacity:${obj.opacity ?? 1}">`
      + `<path d="${d}" fill="none" stroke="${obj.stroke}" stroke-width="${obj.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function place(obj) {
    const node = nodeOf(obj.id);
    if (!node) return;
    Object.assign(node.style, {
      left: `${obj.x}px`, top: `${obj.y}px`, width: `${obj.w}px`, height: `${obj.h}px`,
      transform: obj.rotation ? `rotate(${obj.rotation}deg)` : '',
    });
    if (obj.type === 'draw') node.firstChild.innerHTML = drawSvg(obj);
  }

  /* ------------------------------ editing ------------------------------- */
  function editText(obj, caretAt) {
    if (obj.locked) { onWarn('This text box is locked.'); return; }
    const node = nodeOf(obj.id);
    const t = node?.querySelector('.bpe-text');
    if (!t) return;
    // First edit of an imported run: reveal it (mask the baked original + paint
    // the now-editable text) so the user can replace it with their own text. We
    // stash the pre-edit HTML so an untouched run can revert to the crisp
    // original on exit (see stopEditText) rather than linger as substitute text.
    if (obj.imported) {
      obj._pre = obj.text;
      if (!obj.revealed) { obj.revealed = true; applyTextStyle(obj, t); }
    }
    node.classList.add('is-editing');
    showInlineToolbar(obj, t);
    t.setAttribute('contenteditable', 'true');
    if (!endEditingText) endEditingText = keyboard.beginEditing();
    t.focus();
    placeCaret(t, caretAt);
    // Reflect the run under the caret so the user sees what's active and never
    // has to re-enable formatting that the existing text already carries.
    syncInlineToolbar();
  }

  /**
   * Drop the caret so newly typed text inherits the *existing* run's formatting.
   * Click-to-edit places it exactly where the user clicked; otherwise it lands at
   * the end of the deepest trailing node (inside a trailing <b>/<span>…) so typing
   * continues that inline style rather than falling back to the box default.
   */
  function placeCaret(t, caretAt) {
    const sel = window.getSelection();
    if (caretAt && typeof document.caretRangeFromPoint === 'function') {
      const r = document.caretRangeFromPoint(caretAt.x, caretAt.y);
      if (r && t.contains(r.startContainer)) { sel.removeAllRanges(); sel.addRange(r); return; }
    }
    const range = document.createRange();
    let deepest = t;
    while (deepest.lastChild) deepest = deepest.lastChild;
    if (deepest.nodeType === Node.TEXT_NODE) {
      range.setStart(deepest, deepest.textContent.length);
      range.collapse(true);
    } else {
      range.selectNodeContents(deepest);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }
  /** Flush the currently-editing text box back into the model. Blurring it fires
   *  the blur handler → stopEditText synchronously, so callers that need a fresh
   *  model (export/save) see the latest content instead of the pre-edit text. */
  function commitActiveEdit() {
    if (!endEditingText) return;
    layer.querySelector('.bpe-obj.is-editing')?.querySelector('.bpe-text')?.blur();
  }
  function stopEditText(obj, t) {
    obj.text = t.innerHTML;
    t.setAttribute('contenteditable', 'false');
    nodeOf(obj.id)?.classList.remove('is-editing');
    hideInlineToolbar();
    if (endEditingText) { endEditingText(); endEditingText = null; }
    // Once a run's content actually diverges from its pre-edit text, mark it
    // permanently edited. `_pre` is re-captured on every edit-session entry, so
    // without this sticky flag, re-opening an already-edited run and leaving it
    // unchanged would make `text === _pre` again and wrongly revert it below.
    if (obj.imported && obj.text !== obj._pre) obj.edited = true;
    // Imported run left untouched (never edited AND never restyled) → hide it
    // again so the crisp original raster shows instead of our substitute-font
    // rendering. A colour/style change (`styled`) counts as an edit, so a
    // run whose only change is its colour stays revealed and exports correctly.
    if (obj.imported && obj.revealed && !obj.edited && !obj.styled && obj.text === obj._pre) {
      obj.revealed = false;
      applyTextStyle(obj, t);
    }
    // An emptied NEW text box is discarded. An emptied IMPORTED run is KEPT (its
    // mask stays), so deleting the original text leaves a clean blank — the baked
    // glyphs never reappear.
    if (!t.textContent.trim() && !t.querySelector('img') && !obj.imported) removeObject(obj.id);
    else { onDirty(); if (selectedId === obj.id) onSelect(descriptorFor(obj)); }
  }
  function sizeTextToContent(obj, t) {
    const node = nodeOf(obj.id);
    const extra = obj.type === 'comment' ? 26 : 0; // comment chrome (icon strip)
    // Imported runs never shrink below their original height, so the mask keeps
    // fully covering the baked-in glyphs even after the text is deleted.
    const minH = obj.imported ? (obj.h0 || MIN_SIZE) : MIN_SIZE;
    obj.h = Math.max(t.scrollHeight + extra, minH);
    if (node) node.style.height = `${obj.h}px`;
  }

  /* --------------------- inline rich-text formatting -------------------- */
  /** Apply an execCommand to the current selection inside the editing box, so
   *  Bold/Italic/lists/etc. affect just the highlighted run (Word/Canva-style).
   *  Inline styles are preferred (styleWithCSS) so the markup survives export. */
  function formatInline(cmd, value) {
    const editing = layer.querySelector('.bpe-obj.is-editing');
    const t = editing?.querySelector('.bpe-text');
    if (!t) return;
    t.focus();
    try { document.execCommand('styleWithCSS', false, true); } catch { /* not supported */ }
    document.execCommand(cmd, false, value);
    const obj = find(editing.dataset.id);
    if (obj) { obj.text = t.innerHTML; sizeTextToContent(obj, t); onDirty(); }
    syncInlineToolbar();
  }

  // Floating formatting toolbar shown above the box while editing text.
  const FMT = [
    { cmd: 'bold', label: () => el('b', {}, 'B'), title: 'Bold (Ctrl+B)' },
    { cmd: 'italic', label: () => el('i', {}, 'I'), title: 'Italic (Ctrl+I)' },
    { cmd: 'underline', label: () => el('u', {}, 'U'), title: 'Underline (Ctrl+U)' },
    { cmd: 'strikeThrough', label: () => el('s', {}, 'S'), title: 'Strikethrough' },
    { sep: true },
    { cmd: 'insertUnorderedList', label: () => '•', title: 'Bulleted list' },
    { cmd: 'insertOrderedList', label: () => '1.', title: 'Numbered list' },
    { sep: true },
    { cmd: 'superscript', label: () => el('span', { html: 'x<sup>2</sup>' }), title: 'Superscript' },
    { cmd: 'subscript', label: () => el('span', { html: 'x<sub>2</sub>' }), title: 'Subscript' },
    { sep: true },
    { cmd: 'removeFormat', label: () => '⌫', title: 'Clear formatting' },
  ];
  // Swatches for the inline text-colour picker. Applied to the SELECTED characters
  // only (execCommand foreColor → inline span), so partial runs keep mixed colours.
  const INLINE_COLORS = ['#111827', '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#2563eb', '#6d28d9', '#ec4899', '#ffffff'];
  let inlineBar = null;
  let inlineBarObjId = null;
  let inlinePalette = null;
  // The last non-collapsed text selection made inside an editing box. It lets the
  // BOX-LEVEL colour controls (top toolbar / Properties panel) recolour just the
  // highlighted characters when a range is active — matching the inline palette.
  // Cleared whenever the object selection changes (a fresh object select means a
  // whole-object change is intended), so it can't leak into a later edit.
  let savedTextRange = null;
  let savedTextObjId = null;
  function showInlineToolbar(obj, _t) {
    hideInlineToolbar();
    inlineBarObjId = obj.id;
    const btn = (label, title, cmd) => el('button', {
      class: 'bpe-fmt__btn', type: 'button', title, dataset: cmd ? { cmd } : {},
      // mousedown + preventDefault keeps the text selection intact for execCommand.
      onMouseDown: (e) => { e.preventDefault(); formatInline(cmd); },
    }, label);
    const children = FMT.map((f) => f.sep
      ? el('span', { class: 'bpe-fmt__sep' })
      : btn(f.label(), f.title, f.cmd));
    // Text colour lives HERE (not only the box-level Properties panel) so it can
    // colour just the selected characters. Every control uses mousedown-preventDefault,
    // so the range selection is never lost the way a native <input type=color> would.
    children.push(el('span', { class: 'bpe-fmt__sep' }));
    children.push(buildInlineColor());
    inlineBar = el('div', { class: `bpe-fmt${rootEl.classList.contains('is-dark') ? ' is-dark' : ''}`, role: 'toolbar' }, children);
    document.body.appendChild(inlineBar);
    positionInlineToolbar();
    syncInlineToolbar();
    viewport.addEventListener('scroll', positionInlineToolbar, true);
    window.addEventListener('resize', positionInlineToolbar);
    // Keep the button states in sync as the caret moves through mixed formatting,
    // and remember the current text selection for the box-level colour controls.
    document.addEventListener('selectionchange', syncInlineToolbar);
    document.addEventListener('selectionchange', captureTextRange);
  }
  // Remember the current non-collapsed selection if it lies inside a text box, so
  // a box-level colour applied afterwards (even via a native colour input that
  // steals focus) can be scoped to exactly those characters.
  function captureTextRange() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const r = sel.getRangeAt(0);
    const startEl = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    const objEl = startEl?.closest('.bpe-obj');
    const textEl = objEl?.querySelector('.bpe-text');
    if (objEl && textEl && textEl.contains(r.startContainer) && textEl.contains(r.endContainer)) {
      savedTextRange = r.cloneRange();
      savedTextObjId = objEl.dataset.id;
    }
  }
  /** Light up the toolbar buttons whose formatting is active at the caret, so
   *  existing formatting is visible and never needs to be manually re-enabled. */
  function syncInlineToolbar() {
    if (!inlineBar) return;
    inlineBar.querySelectorAll('.bpe-fmt__btn[data-cmd]').forEach((b) => {
      let on = false;
      try { on = document.queryCommandState(b.dataset.cmd); } catch { /* unsupported cmd */ }
      b.classList.toggle('is-active', on);
    });
  }
  function positionInlineToolbar() {
    if (!inlineBar || !inlineBarObjId) return;
    const node = nodeOf(inlineBarObjId);
    if (!node) return;
    const r = node.getBoundingClientRect();
    const bw = inlineBar.offsetWidth || 340;
    const bh = inlineBar.offsetHeight || 40;
    const left = clamp(r.left + r.width / 2 - bw / 2, 8, window.innerWidth - bw - 8);
    let top = r.top - bh - 10;
    if (top < 8) top = r.bottom + 10;
    inlineBar.style.left = `${Math.round(left)}px`;
    inlineBar.style.top = `${Math.round(top)}px`;
  }
  function hideInlineToolbar() {
    if (!inlineBar) return;
    closeInlinePalette();
    inlineBar.remove();
    inlineBar = null;
    inlineBarObjId = null;
    viewport.removeEventListener('scroll', positionInlineToolbar, true);
    window.removeEventListener('resize', positionInlineToolbar);
    document.removeEventListener('selectionchange', syncInlineToolbar);
    document.removeEventListener('selectionchange', captureTextRange);
  }
  /** Colour just the saved text selection (box-level colour controls delegate
   *  here). Wraps the selected characters in a coloured <span> via direct DOM
   *  editing — works even after a native colour input stole focus/ended editing.
   *  Returns false when there is no usable range, so the caller falls back to a
   *  whole-object colour change. */
  function applyColorToSelection(obj, color) {
    const t = nodeOf(obj.id)?.querySelector('.bpe-text');
    const r = savedTextRange;
    if (!t || !r || r.collapsed || savedTextObjId !== obj.id) return false;
    if (!t.contains(r.startContainer) || !t.contains(r.endContainer)) return false;
    try {
      const span = document.createElement('span');
      span.style.color = color;
      span.appendChild(r.extractContents());
      r.insertNode(span);
      t.normalize();
    } catch { return false; }
    if (obj.imported) { obj.revealed = true; obj.styled = true; }
    obj.text = t.innerHTML;
    applyTextStyle(obj, t);
    onDirty();
    if (selectedId === obj.id) onSelect(descriptorFor(obj));
    savedTextRange = null; savedTextObjId = null; // consumed
    return true;
  }
  // The floating text-colour control: an "A" trigger + a swatch popover. Picking a
  // swatch runs foreColor on the current selection (inline span), leaving unselected
  // characters untouched. Reusing formatInline keeps obj.text/onDirty in sync.
  function buildInlineColor() {
    const wrap = el('div', { class: 'bpe-fmt__color' });
    const trigger = el('button', {
      class: 'bpe-fmt__btn bpe-fmt__cbtn', type: 'button', title: 'Text colour',
      onMouseDown: (e) => { e.preventDefault(); toggleInlinePalette(wrap); },
    }, [el('span', { class: 'bpe-fmt__ca' }, 'A')]);
    wrap.appendChild(trigger);
    return wrap;
  }
  function toggleInlinePalette(anchor) {
    if (inlinePalette) { closeInlinePalette(); return; }
    inlinePalette = el('div', { class: 'bpe-fmt__palette', role: 'menu', onMouseDown: (e) => e.preventDefault() },
      INLINE_COLORS.map((c) => el('button', {
        class: 'bpe-fmt__pswatch', type: 'button', title: c, 'aria-label': `Colour ${c}`,
        style: `background:${c}`,
        onMouseDown: (e) => { e.preventDefault(); formatInline('foreColor', c); closeInlinePalette(); },
      })));
    anchor.appendChild(inlinePalette);
  }
  function closeInlinePalette() { if (inlinePalette) { inlinePalette.remove(); inlinePalette = null; } }

  /* ---------------------------- selection ------------------------------- */
  function select(id) {
    // A fresh object selection cancels any pending per-character colour intent —
    // colouring now targets the whole object until a new text range is made.
    savedTextRange = null; savedTextObjId = null;
    if (selectedId && selectedId !== id) {
      nodeOf(selectedId)?.classList.remove('is-selected');
      nodeOf(selectedId)?.querySelector('.bpe-handles')?.remove();
    }
    selectedId = id;
    if (!id) { onSelect(null); return; }
    const node = nodeOf(id);
    const obj = find(id);
    if (!node || !obj) { onSelect(null); return; }
    node.classList.add('is-selected');
    if (!node.querySelector('.bpe-handles')) node.appendChild(handles(obj));
    onSelect(descriptorFor(obj));
    // Selecting a signature image auto-blends its box into the page paper (once).
    maybeMatchSignature(obj);
  }

  // Vector/raster objects can be freely rotated (the model already stores
  // `obj.rotation` and place()/export honour it); text-like objects keep their
  // upright box. Rotatable selections get an extra rotate handle above the box.
  function canRotate(obj) { return ['stamp', 'image', 'shape', 'draw'].includes(obj.type); }
  function handles(obj) {
    const items = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((dir) =>
      el('span', { class: `bpe-handle bpe-handle--${dir}`, dataset: { dir } }));
    if (obj && canRotate(obj)) {
      // Circular grip at top-centre with a short stem down to the box edge.
      items.push(el('span', { class: 'bpe-rotate', dataset: { rotate: '1' }, 'aria-label': 'Rotate' }));
    }
    return el('div', { class: 'bpe-handles' }, items);
  }

  function descriptorFor(obj) {
    const kind = KIND_BY_TYPE[obj.type] || 'shape';
    if (obj.type === 'text' || obj.type === 'comment') {
      return { kind, label: obj.type === 'comment' ? 'Comment' : 'Text', target: obj.id, locked: !!obj.locked, values: {
        fontFamily: obj.fontFamily, fontSize: obj.fontSize, color: obj.color, align: obj.align,
        lineHeight: obj.lineHeight, letterSpacing: obj.letterSpacing,
        highlight: obj.highlight && obj.highlight !== 'transparent' ? obj.highlight : '#ffe64d',
        textCase: obj.textCase || 'none', opacity: Math.round((obj.opacity ?? 1) * 100),
        style: [obj.bold && 'bold', obj.italic && 'italic', obj.underline && 'underline', obj.strike && 'strike'].filter(Boolean),
      } };
    }
    if (obj.type === 'image') {
      return { kind, label: 'Image', target: obj.id, values: { width: Math.round(obj.w), height: Math.round(obj.h), radius: obj.radius || 0, opacity: Math.round((obj.opacity ?? 1) * 100), fit: obj.fit || 'contain' } };
    }
    if (obj.type === 'draw') {
      return { kind: 'shape', label: 'Drawing', target: obj.id, values: { stroke: obj.stroke, strokeWidth: obj.strokeWidth, opacity: Math.round((obj.opacity ?? 1) * 100) } };
    }
    if (obj.type === 'stamp') return { kind: 'stamp', label: 'Stamp', target: obj.id, values: {
      color: obj.color, opacity: Math.round((obj.opacity ?? 1) * 100), rotation: Math.round(obj.rotation || 0),
    } };
    if (obj.type === 'link') return { kind: 'shape', label: 'Link', target: obj.id, values: { opacity: 100 } };
    return { kind: 'shape', label: 'Shape', target: obj.id, values: {
      shapeType: obj.shape, fill: obj.fill, stroke: obj.stroke, strokeWidth: obj.strokeWidth,
      radius: obj.radius, opacity: Math.round((obj.opacity ?? 1) * 100),
    } };
  }

  function applyProperty(kind, key, value) {
    const obj = find(selectedId);
    if (!obj) return;
    pushUndo();
    if (obj.type === 'text' || obj.type === 'comment') {
      // Colour with an active text range → recolour ONLY those characters (a
      // per-run span), never the whole object. No range → whole-object colour.
      if (key === 'color' && applyColorToSelection(obj, value)) return;
      if (key === 'fontFamily') obj.fontFamily = value;
      else if (key === 'fontSize') obj.fontSize = Number(value) || obj.fontSize;
      else if (key === 'color') obj.color = value;
      else if (key === 'align') obj.align = value;
      else if (key === 'lineHeight') obj.lineHeight = Number(value) || obj.lineHeight;
      else if (key === 'letterSpacing') obj.letterSpacing = Number(value) || 0;
      else if (key === 'highlight') obj.highlight = value;
      else if (key === 'textCase') obj.textCase = value;
      else if (key === 'opacity') obj.opacity = clamp(Number(value) / 100, 0, 1);
      else if (key === 'rotation') { obj.rotation = Number(value) || 0; place(obj); }
      else if (key === 'style') {
        const set = new Set(Array.isArray(value) ? value : [value]);
        obj.bold = set.has('bold'); obj.italic = set.has('italic');
        obj.underline = set.has('underline'); obj.strike = set.has('strike');
      }
      // Restyling an imported run (colour, weight, font, highlight, …) is a real
      // edit even when the TEXT is untouched: reveal the overlay (its boxBg mask
      // hides the baked original) and mark it `styled` so stopEditText never
      // re-hides it. Without this, a colour-only change is discarded on blur and
      // the export falls back to the original baked-in text colour.
      if (obj.imported) { obj.revealed = true; obj.styled = true; }
      const t = nodeOf(obj.id)?.querySelector('.bpe-text');
      if (t) applyTextStyle(obj, t);
    } else if (obj.type === 'image') {
      if (key === 'width') obj.w = Number(value) || obj.w;
      else if (key === 'height') obj.h = Number(value) || obj.h;
      else if (key === 'radius') obj.radius = Number(value) || 0;
      else if (key === 'opacity') obj.opacity = clamp(Number(value) / 100, 0, 1);
      else if (key === 'rotation') obj.rotation = Number(value) || 0;
      else if (key === 'fit') obj.fit = value;
      const img = nodeOf(obj.id)?.querySelector('.bpe-img');
      if (img) img.setAttribute('style', imageStyle(obj));
      place(obj);
    } else if (obj.type === 'shape') {
      if (key === 'shapeType') {
        obj.shape = value;
        // Give "Rounded Rectangle" a clearly rounded default when arriving from a
        // square corner, without overriding a radius the user already dialled in.
        if (value === 'roundRect' && (obj.radius ?? 0) < 8) obj.radius = 16;
      }
      else if (key === 'fill') obj.fill = value;
      else if (key === 'stroke') obj.stroke = value;
      else if (key === 'strokeWidth') obj.strokeWidth = Number(value) || 0;
      else if (key === 'radius') obj.radius = Number(value) || 0;
      else if (key === 'opacity') obj.opacity = clamp(Number(value) / 100, 0, 1);
      const s = nodeOf(obj.id)?.querySelector('.bpe-shape');
      if (s) { s.style.opacity = obj.opacity; s.innerHTML = shapeSvgMarkup(obj); }
    } else if (obj.type === 'draw') {
      if (key === 'stroke') obj.stroke = value;
      else if (key === 'strokeWidth') obj.strokeWidth = Number(value) || obj.strokeWidth;
      else if (key === 'opacity') obj.opacity = clamp(Number(value) / 100, 0, 1);
      place(obj);
    } else if (obj.type === 'stamp') {
      if (key === 'color') obj.color = value;
      else if (key === 'opacity') obj.opacity = clamp(Number(value) / 100, 0, 1);
      else if (key === 'rotation') { obj.rotation = Number(value) || 0; place(obj); }
      const s = nodeOf(obj.id)?.querySelector('.bpe-stamp');
      if (s) { s.style.opacity = obj.opacity ?? 1; s.innerHTML = stampSvgMarkup(obj); }
    }
    onDirty();
  }

  /* ------------------------------ images -------------------------------- */
  // Downscale a possibly-huge source to a sane resolution BEFORE it enters the
  // model. A 20–30 MB photo otherwise gets decoded full-res on every render (into
  // a small box, the crop editor, thumbnails) and cloned into every undo snapshot
  // — the cause of the "editor lags, can't click anything" freeze. Transparency
  // (PNG) is preserved; photos re-encode to compact JPEG. Already-small images are
  // passed through untouched so we never needlessly recompress.
  function downscaleImage(dataURL, maxDim, quality, cb) {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
      const sc = Math.min(maxDim / Math.max(w, h), 1);
      if (sc >= 1) { cb(dataURL, w, h); return; }
      const dw = Math.max(1, Math.round(w * sc)), dh = Math.max(1, Math.round(h * sc));
      const c = document.createElement('canvas'); c.width = dw; c.height = dh;
      c.getContext('2d').drawImage(img, 0, 0, dw, dh);
      const mime = /^data:image\/png/i.test(dataURL) ? 'image/png' : 'image/jpeg';
      cb(c.toDataURL(mime, quality), dw, dh);
    };
    img.onerror = () => cb(dataURL);
    img.src = dataURL;
  }
  function addImageFromFile(file) {
    if (!file || !/^image\//.test(file.type)) { onWarn('Choose an image file (PNG, JPG, …).'); return; }
    const reader = new FileReader();
    // Uploading an image opens the full-screen crop editor first; Save drops the
    // (optionally cropped) result into the page. Cancel aborts the insert. The
    // source is downscaled first so a 30 MB photo doesn't freeze the editor.
    reader.onload = () => downscaleImage(reader.result, 1800, 0.85, (src) => openImageCropper(src, (out) => insertImage(out)));
    reader.readAsDataURL(file);
  }
  function insertImage(src, opts = {}) {
    const probe = new Image();
    probe.onload = () => {
      const max = 360;
      let w = probe.width, h = probe.height;
      const scale = Math.min(max / w, max / h, 1);
      w = Math.round(w * scale); h = Math.round(h * scale);
      const obj = addObject({
        type: 'image', src, signature: !!opts.paper,
        x: opts.x ?? Math.round((PW - w) / 2), y: opts.y ?? Math.round((PH - h) / 3),
        w, h, radius: 0, opacity: 1, fit: 'contain',
      });
      // Signatures blend onto the page: sample the paper colour under the box and
      // fill the box with it, so the transparent ink appears on matching paper.
      if (opts.paper) {
        samplePaperColor(obj.x, obj.y, obj.w, obj.h).then((bg) => {
          if (!bg || !find(obj.id)) return;
          obj.boxBg = bg;
          nodeOf(obj.id)?.querySelector('.bpe-img')?.setAttribute('style', imageStyle(obj));
          onDirty();
        });
      }
    };
    probe.src = src;
  }

  /**
   * Dominant paper colour of the current page around a box (page px @96dpi).
   * Reads pixels JUST OUTSIDE the box perimeter — the surrounding paper — so ink/
   * QR/photos inside the box never skew it. Only the small region around the box
   * is drawn/read (NOT the whole page raster), so this stays cheap even on dense
   * pages. Returns a hex string, or null when there's no page image or on error.
   */
  function samplePaperColor(x, y, w, h) {
    return new Promise((resolve) => {
      const bg = pages[pageIndex]?.bg;
      if (!bg) { resolve(null); return; }
      const img = new Image();
      img.onload = () => {
        try {
          const rf = img.naturalWidth / (pages[pageIndex]?.w || PW); // canvas px per css px
          const m = 6; // css px sampled outside the perimeter
          // Sub-region = the box expanded by the margin, clamped to the raster.
          const sx = Math.max(0, Math.floor((x - m) * rf));
          const sy = Math.max(0, Math.floor((y - m) * rf));
          const sw = Math.min(img.naturalWidth - sx, Math.ceil((w + 2 * m) * rf));
          const sh = Math.min(img.naturalHeight - sy, Math.ceil((h + 2 * m) * rf));
          if (sw < 2 || sh < 2) { resolve(null); return; }
          const cvs = document.createElement('canvas');
          cvs.width = sw; cvs.height = sh;
          const c = cvs.getContext('2d', { willReadFrequently: true });
          c.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh); // only the region we need
          const px = c.getImageData(0, 0, sw, sh).data;
          const cols = [];
          const at = (cssX, cssY) => {
            const ix = Math.round(cssX * rf) - sx, iy = Math.round(cssY * rf) - sy;
            if (ix < 0 || iy < 0 || ix >= sw || iy >= sh) return;
            const i = (iy * sw + ix) * 4;
            cols.push([px[i], px[i + 1], px[i + 2]]);
          };
          for (const t of [0, 0.25, 0.5, 0.75, 1]) {
            at(x + w * t, y - m); at(x + w * t, y + h + m);
            at(x - m, y + h * t); at(x + w + m, y + h * t);
          }
          resolve(cols.length ? dominantHex(cols) : null);
        } catch { resolve(null); } // tainted/unreadable — skip the fill
      };
      img.onerror = () => resolve(null);
      img.src = bg;
    });
  }

  /**
   * Compute a "signature matte": knock the image's OWN rectangular background out
   * to transparent (graded at the ink edges) and pick the page paper colour to
   * show behind it — so the signature blends into the document with no visible
   * box. Returns `{ src, boxBg }` or null. Only accepts sparse, dark line-art (a
   * signature); a photographic subject is too large/varied and is rejected, so
   * this never damages the applicant photo. Position/size/rotation are untouched.
   */
  async function computeSignatureMatte(obj) {
    const paperHex = await samplePaperColor(obj.x, obj.y, obj.w, obj.h);
    if (!paperHex) return null; // no page paper to match (blank editor)
    const img = await new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = obj.src; });
    if (!img || !img.naturalWidth) return null;
    const w = img.naturalWidth, h = img.naturalHeight;
    const cvs = document.createElement('canvas'); cvs.width = w; cvs.height = h;
    const c = cvs.getContext('2d', { willReadFrequently: true });
    c.drawImage(img, 0, 0);
    let idata;
    try { idata = c.getImageData(0, 0, w, h); } catch { return null; } // tainted → skip
    const px = idata.data;
    const srcBg = imageBorderColor(px, w, h);
    if (!srcBg) return null; // already transparent-bordered (e.g. drawn signature)

    // Distance band to the image's own background: ≤T0 = background, ≥T1 = solid
    // ink, between = anti-aliased edge (graded alpha).
    const T0 = 42, T1 = 96;
    const dist = (i) => px[i + 3] < 8 ? 0 : Math.abs(px[i] - srcBg[0]) + Math.abs(px[i + 1] - srcBg[1]) + Math.abs(px[i + 2] - srcBg[2]);
    let bg = 0, ink = 0, inkLuma = 0;
    for (let i = 0; i < px.length; i += 4) {
      const d = dist(i);
      if (d <= T0) bg += 1;
      else { ink += 1; inkLuma += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; }
    }
    const total = bg + ink;
    // Signature = mostly background + a little DARK ink. These gates reject a
    // photo (subject covers far more than a signature's strokes and isn't dark).
    if (!total || bg / total < 0.7 || ink / total > 0.2 || (ink && inkLuma / ink > 120)) return null;

    for (let i = 0; i < px.length; i += 4) {
      const d = dist(i);
      if (d <= T0) px[i + 3] = 0;                                   // background → transparent
      else if (d < T1) px[i + 3] = Math.round(255 * (d - T0) / (T1 - T0)); // edge → graded
      // else keep the opaque ink pixel as-is
    }
    c.putImageData(idata, 0, 0);
    return { src: cvs.toDataURL('image/png'), boxBg: paperHex };
  }

  /** On first selection of an image, auto-blend it if it's a signature. Runs at
   *  most once per object; a photo is detected and left untouched. The pixel work
   *  is deferred to idle time so it never blocks the click/drag that selected it
   *  (selecting fires on pointerdown, i.e. at the very start of a move). */
  function maybeMatchSignature(obj) {
    if (!obj || obj.type !== 'image' || obj.locked || obj._bgChecked) return;
    // A signature drawn in the pad is ALREADY a transparent-ink PNG blended onto
    // the sampled paper colour (see insertImage) — it must never be re-matted.
    // computeSignatureMatte's border sampler is only reliable on a fully
    // transparent crop edge; anti-aliased ink that happens to reach the trim
    // padding fools it into a solid `srcBg`, and the knockout then erases the
    // signature's own strokes — which is exactly the "sometimes it works,
    // sometimes it's blank" behaviour. Auto-matte is only for opaque-background
    // images that *look* like a signature (e.g. a photographed one), so skip
    // anything already flagged as a signature.
    if (obj.signature) { obj._bgChecked = true; return; }
    obj._bgChecked = true; // guard re-entry on rapid re-clicks
    const run = () => {
      if (!find(obj.id)) return; // deleted before idle fired
      computeSignatureMatte(obj).then((res) => {
        if (!res || !find(obj.id)) return;
        pushUndo(); // reversible: undo restores the original image + box
        obj.src = res.src; obj.boxBg = res.boxBg; obj.signature = true;
        const im = nodeOf(obj.id)?.querySelector('.bpe-img');
        if (im) { im.setAttribute('src', obj.src); im.setAttribute('style', imageStyle(obj)); }
        onDirty();
        if (selectedId === obj.id) onSelect(descriptorFor(obj));
      });
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1500 });
    else setTimeout(run, 250);
  }

  /* ------------------------------ history ------------------------------- */
  const cloneObj = (o) => ({ ...o, points: o.points ? o.points.map((p) => ({ ...p })) : undefined });
  // `bg` is an immutable page background (data URL) — snapshots copy the string
  // reference only, never the pixels, so undo stays cheap even for imported PDFs.
  const snapshot = () => ({ pageIndex, size: pageName, PW, PH, pages: pages.map((pg) => ({ id: pg.id, bg: pg.bg, w: pg.w, h: pg.h, objects: pg.objects.map(cloneObj) })) });
  function pushUndo() { doc.recordSnapshot(); notifyHistory(); }
  function restore(s) {
    pageName = s.size;
    PW = s.PW; PH = s.PH;
    applyPageSize();
    pages = s.pages.map((pg) => ({ id: pg.id, bg: pg.bg, w: pg.w, h: pg.h, objects: pg.objects.map(cloneObj) }));
    pageIndex = clamp(s.pageIndex, 0, pages.length - 1);
    objects = pages[pageIndex].objects;
    if (pages[pageIndex].w) { PW = pages[pageIndex].w; PH = pages[pageIndex].h; applyPageSize(); }
    applyZoom();
    renderLayer();
    selectedId = null;
    onSelect(null);
    emitPages();
  }
  function undo() { if (!doc.canUndo()) return; doc.undo(); notifyHistory(); onDirty(); }
  function redo() { if (!doc.canRedo()) return; doc.redo(); notifyHistory(); onDirty(); }
  function notifyHistory() { onHistory({ canUndo: doc.canUndo(), canRedo: doc.canRedo() }); }
  // Delegate whole-document undo/redo to the DocumentModel: it serializes via
  // snapshot() and restores via restore(), storing each checkpoint on doc.history.
  doc.useSnapshotSource({ getState: snapshot, setState: restore });

  function renderLayer() {
    applyBg();
    layer.replaceChildren();
    for (const obj of objects) { layer.appendChild(buildNode(obj)); place(obj); }
  }
  function applyBg() {
    const bg = pages[pageIndex]?.bg;
    pageBg.style.backgroundImage = bg ? `url("${bg}")` : 'none';
  }

  /** Build editable text objects from a page's imported text descriptors. Each
   *  run gets an opaque `boxBg` mask so it hides the same glyphs baked into the
   *  page background image, letting the user edit the original text in place. */
  function buildImportedObjects(texts) {
    if (!texts || !texts.length) return [];
    return texts.map((t) => ({
      id: uid('o'), type: 'text', imported: true,
      x: t.x, y: t.y, w: Math.max(t.w, 4), h: Math.max(t.h, 8), h0: Math.max(t.h, 8), rotation: 0,
      text: escapeHtml(t.text),
      fontFamily: t.fontFamily || 'Arial, Helvetica, sans-serif',
      fontSize: Math.max(5, t.fontSize || 16),
      color: t.color || '#111827',
      align: 'left', lineHeight: 1, letterSpacing: 0,
      bold: false, italic: false, underline: false, strike: false,
      highlight: 'transparent', boxBg: t.boxBg || 'transparent',
      textCase: 'none', opacity: 1, locked: false,
    }));
  }

  /** Commit any in-progress edit, then sync the live editor structure (incl. each
   *  page's embedded images) into the canonical DocumentModel and return it. The
   *  single place the editor → model mirror happens; both getDocumentModel and
   *  getExportModel go through here so the model truly drives reads and exports. */
  function syncDoc() {
    commitActiveEdit();
    syncEditorToModel(doc, {
      pages: pages.map((p) => ({ id: p.id, bg: p.bg, w: p.w || PW, h: p.h || PH, objects: p.objects, images: p.images || [] })),
    });
    return doc;
  }

  /** Rebuild the whole editor FROM a DocumentModel (the inverse of the mirror in
   *  getDocumentModel) — the load half of round-trip save/load. Reuses the same
   *  restore() path as undo, then reattaches each page's embedded images (which
   *  aren't part of the undo snapshot shape) and clears history. */
  function loadFromModel(model) {
    const snap = pagesToEditorSnapshot(model);
    if (!snap.pages.length) return;
    restore(snap);
    pages.forEach((p, i) => { p.images = (snap.pages[i] && snap.pages[i].images) || []; });
    doc.resetHistory(); notifyHistory();
    onDirty();
  }

  /** Replace the whole document with imported PDF pages: each page is a raster
   *  background plus editable text boxes lifted from the PDF's text layer. */
  function loadDocument({ pageW, pageH, pages: imgs, scanned = false }) {
    if (!imgs || !imgs.length) return;
    pageName = 'Custom';
    PW = pageW; PH = pageH;
    pages = imgs.map((p) => ({
      id: uid('pg'), objects: buildImportedObjects(p.texts), bg: p.bg, w: p.w, h: p.h, textChars: p.textChars || 0,
      // Real embedded images recovered from the PDF (logos/signatures/seals/photos),
      // kept off the editable object layer (they're already in the raster bg, so
      // rendering them would double); converters pull them via getExportModel.
      images: p.images || [],
    }));
    imported = true; importScanned = scanned; editHintShown = false;
    pageIndex = 0;
    objects = pages[0].objects;
    doc.resetHistory(); notifyHistory();
    if (pages[0].w) { PW = pages[0].w; PH = pages[0].h; }
    applyPageSize();
    applyZoom();
    renderLayer();
    selectedId = null; onSelect(null);
    emitPages();
    requestAnimationFrame(fit);
  }

  /** Reset to a single blank A4 page (the "New PDF" state). */
  function newDocument() {
    pageName = 'A4';
    [PW, PH] = SIZES.A4;
    pages = [makePage()];
    imported = false; importScanned = false; editHintShown = false;
    pageIndex = 0;
    objects = pages[0].objects;
    doc.resetHistory(); notifyHistory();
    applyPageSize();
    applyZoom();
    renderLayer();
    selectedId = null; onSelect(null);
    emitPages();
    requestAnimationFrame(fit);
  }

  function removeObject(id) {
    const i = objects.findIndex((o) => o.id === id);
    if (i < 0) return;
    objects.splice(i, 1);
    nodeOf(id)?.remove();
    if (selectedId === id) { selectedId = null; onSelect(null); }
    onDirty();
  }
  function deleteSelected() {
    if (!selectedId) return;
    const obj = find(selectedId);
    pushUndo();
    // Deleting an imported run that is still covering the page's baked-in original
    // must NOT just remove the box — that would expose the original glyphs beneath
    // (the "second password" effect). Instead we blank it in place: keep a clean
    // paper-coloured mask over the original so the spot goes empty and the baked
    // text stays hidden. A second delete on the now-blank mask removes it fully and
    // brings the original back (so nothing is ever lost — plus Ctrl+Z always works).
    if (obj && isMaskingImportedRun(obj)) { blankImportedRun(obj); return; }
    removeObject(selectedId);
  }
  // True when an imported text run is still hiding baked-in original glyphs: it has
  // a real paper mask and is NOT already an emptied blank (revealed with no text).
  function isMaskingImportedRun(obj) {
    if (!obj.imported || obj.type !== 'text' || !obj.boxBg || obj.boxBg === 'transparent') return false;
    const blank = obj.revealed && !htmlToText(obj.text || '').trim();
    return !blank;
  }
  // Turn an imported run into a clean blank mask at the same spot: empty its text
  // and reveal it so its `boxBg` paints over the baked original.
  function blankImportedRun(obj) {
    obj.text = '';
    obj.revealed = true;
    obj.edited = true;
    const t = nodeOf(obj.id)?.querySelector('.bpe-text');
    if (t) { t.innerHTML = ''; applyTextStyle(obj, t); }
    onDirty();
    if (selectedId === obj.id) onSelect(descriptorFor(obj));
  }

  function duplicateSelected() {
    const obj = find(selectedId);
    if (!obj) return;
    pushUndo();
    const clone = { ...cloneObj(obj), id: uid('o'), x: obj.x + 18, y: obj.y + 18, locked: false };
    objects.push(clone);
    layer.appendChild(buildNode(clone));
    place(clone);
    onDirty();
    select(clone.id);
  }

  function reorder(dir) {
    const i = objects.findIndex((o) => o.id === selectedId);
    if (i < 0) return;
    pushUndo();
    const [obj] = objects.splice(i, 1);
    const node = nodeOf(obj.id);
    if (dir === 'front') { objects.push(obj); layer.appendChild(node); }
    else { objects.unshift(obj); layer.insertBefore(node, layer.firstChild); }
    onDirty();
  }

  /** Move the selection one step up (forward) or down (backward) in z-order. */
  function reorderStep(dir) {
    const i = objects.findIndex((o) => o.id === selectedId);
    if (i < 0) return;
    const j = dir === 'forward' ? i + 1 : i - 1;
    if (j < 0 || j >= objects.length) return;
    pushUndo();
    const [obj] = objects.splice(i, 1);
    objects.splice(j, 0, obj);
    const node = nodeOf(obj.id);
    const ref = objects[j + 1] ? nodeOf(objects[j + 1].id) : null;
    layer.insertBefore(node, ref);
    onDirty();
  }

  /* ---------------------------- lock / clipboard ------------------------ */
  function toggleLock(id = selectedId) {
    const obj = find(id);
    if (!obj) return;
    pushUndo();
    obj.locked = !obj.locked;
    nodeOf(obj.id)?.classList.toggle('is-locked', obj.locked);
    onDirty();
    if (selectedId === obj.id) onSelect(descriptorFor(obj));
  }
  function isLocked(id = selectedId) { return !!find(id)?.locked; }

  /** Toggle a box-level text style (bold/italic/underline/strike) on the selection. */
  function toggleTextStyle(which) {
    const obj = find(selectedId);
    if (!obj || (obj.type !== 'text' && obj.type !== 'comment') || obj.locked) return;
    pushUndo();
    obj[which] = !obj[which];
    const t = nodeOf(obj.id)?.querySelector('.bpe-text');
    if (t) applyTextStyle(obj, t);
    onDirty();
    onSelect(descriptorFor(obj));
  }

  function copySelected() {
    const obj = find(selectedId);
    if (!obj) return false;
    clipboard = cloneObj({ ...obj });
    return true;
  }
  function cutSelected() { if (copySelected()) deleteSelected(); }
  /** Paste the in-editor clipboard near the cursor (or offset from the original). */
  function pasteClipboard(at) {
    if (!clipboard) return;
    pushUndo();
    // Default target is the last cursor position (right-click / Ctrl+V location).
    const p = at || lastPointer || { x: clipboard.x + 18, y: clipboard.y + 18 };
    const clone = {
      ...cloneObj(clipboard), id: uid('o'), locked: false,
      x: clamp(p.x, 0, Math.max(0, PW - 20)), y: clamp(p.y, 0, Math.max(0, PH - 20)),
    };
    objects.push(clone);
    layer.appendChild(buildNode(clone));
    place(clone);
    onDirty();
    select(clone.id);
  }
  function hasClipboard() { return clipboard != null; }

  /** Rotate the selection by a delta (degrees); images/objects both support it. */
  function rotateSelected(delta = 90) {
    const obj = find(selectedId);
    if (!obj || obj.locked) return;
    pushUndo();
    obj.rotation = ((obj.rotation || 0) + delta) % 360;
    place(obj);
    onDirty();
    onSelect(descriptorFor(obj));
  }

  /** Swap an image object's source for a freshly picked file. */
  /** PowerPoint-style "Change Picture": pick a new file, crop it, then drop the
   *  result into the SELECTED image's exact slot — same x/y, same width/height,
   *  same rotation, same page. The user never resizes or realigns by hand. The
   *  crop frame is pre-locked to the slot's aspect ratio so the region they pick
   *  is exactly what fills the box (and `object-fit:cover` keeps it undistorted
   *  even if they switch the crop to a different ratio). */
  function replaceImage() {
    const obj = find(selectedId);
    if (!obj || obj.type !== 'image' || obj.locked) return;
    const input = el('input', { type: 'file', accept: 'image/*', style: 'position:fixed;left:-9999px' });
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        // Open the crop workspace on the NEW image, locked to the slot's aspect.
        openImageCropper(reader.result, (out) => {
          if (!find(obj.id)) return; // image was deleted while the dialog was open
          pushUndo();
          obj.src = out;
          // Fill the ORIGINAL box exactly: keep x/y/w/h/rotation, only swap pixels.
          // `cover` fills the fixed slot without stretching (any aspect mismatch is
          // centre-cropped, never distorted).
          obj.fit = 'cover';
          const im = nodeOf(obj.id)?.querySelector('.bpe-img');
          if (im) { im.setAttribute('src', out); im.setAttribute('style', imageStyle(obj)); }
          place(obj);
          onDirty();
          onSelect(descriptorFor(obj));
        }, obj.h > 0 ? obj.w / obj.h : 0);
      };
      reader.readAsDataURL(file);
    });
    input.click();
  }

  /** Crop an already-placed image: open the full-screen editor on its source, and
   *  on Save swap in the cropped result (keeping position; box height follows the
   *  crop's aspect ratio). */
  function cropImage() {
    const obj = find(selectedId);
    if (!obj || obj.type !== 'image' || obj.locked) return;
    openImageCropper(obj.src, (out, cw, ch) => {
      if (!find(obj.id)) return;
      pushUndo();
      obj.src = out;
      obj.h = Math.round(obj.w * (ch / cw));
      obj.fit = 'fill';
      const im = nodeOf(obj.id)?.querySelector('.bpe-img');
      if (im) { im.setAttribute('src', out); im.setAttribute('style', imageStyle(obj)); }
      place(obj);
      onDirty();
      onSelect(descriptorFor(obj));
    });
  }

  /**
   * Full-screen image crop editor (its own workspace/modal). Shows the image
   * large with a draggable/resizable crop frame (rest dimmed, rule-of-thirds),
   * plus aspect presets. Save → rasterise the framed region to a new image and
   * hand it to `onSave(dataURL, cropW, cropH)`. Cancel closes without changes.
   */
  let cropperOpen = false;
  function openImageCropper(src, onSave, lockAspect = 0) {
    if (cropperOpen) return;
    const img = new Image();
    img.onload = () => {
      cropperOpen = true;
      const natW = img.naturalWidth || 1, natH = img.naturalHeight || 1;
      // Leave room for the dialog chrome (header + ratio row + footer + paddings)
      // AND the crop handles, so the whole editor — including Save and the bottom
      // handles — always fits on screen without clipping.
      const maxW = Math.min(window.innerWidth * 0.9, 1120) - 48;
      const maxH = Math.max(180, window.innerHeight * 0.92 - 250);
      const s = Math.min(maxW / natW, maxH / natH, 1);
      const dispW = Math.max(1, Math.round(natW * s)), dispH = Math.max(1, Math.round(natH * s));

      // Replace-flow opens with the frame pre-locked to the target slot's aspect
      // (the largest such rect, centred) so the crop maps 1:1 into the box. Plain
      // crop opens free with the whole image framed.
      let aspect = lockAspect > 0 ? lockAspect : 0; // 0 = free; else width/height ratio to lock
      let rect = { x: 0, y: 0, w: dispW, h: dispH };
      if (aspect > 0) {
        let w = dispW, h = w / aspect;
        if (h > dispH) { h = dispH; w = h * aspect; }
        rect = { x: (dispW - w) / 2, y: (dispH - h) / 2, w, h };
      }

      const frame = el('div', { class: 'bpe-crop__rect' }, [
        el('div', { class: 'bpe-crop__grid' }),
        ...['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((dir) =>
          el('span', { class: `bpe-crop__h bpe-crop__h--${dir}`, dataset: { dir } })),
      ]);
      const stage = el('div', { class: 'bpe-cropper__stage', style: `width:${dispW}px;height:${dispH}px` }, [
        el('img', { class: 'bpe-cropper__img', src, alt: '', draggable: 'false' }),
        frame,
      ]);

      const draw = () => Object.assign(frame.style, {
        left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px`,
      });

      const clampToStage = (r) => {
        r.w = Math.max(24, Math.min(r.w, dispW));
        r.h = Math.max(24, Math.min(r.h, dispH));
        r.x = clamp(r.x, 0, dispW - r.w);
        r.y = clamp(r.y, 0, dispH - r.h);
        return r;
      };

      // Pointer drag helper local to the modal (works in stage-screen px).
      const withDrag = (e, onMove) => {
        e.preventDefault();
        const sr = stage.getBoundingClientRect();
        const pt = (ev) => ({ x: ev.clientX - sr.left, y: ev.clientY - sr.top });
        const start = pt(e); const o = { ...rect };
        const move = (ev) => onMove(pt(ev), start, o);
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      };

      frame.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('.bpe-crop__h')) return;
        withDrag(e, (cur, start, o) => {
          rect.x = o.x + (cur.x - start.x); rect.y = o.y + (cur.y - start.y);
          clampToStage(rect); draw();
        });
      });
      for (const h of frame.querySelectorAll('.bpe-crop__h')) {
        h.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const dir = h.dataset.dir;
          withDrag(e, (cur, start, o) => {
            const dx = cur.x - start.x, dy = cur.y - start.y;
            let x = o.x, y = o.y, w = o.w, ht = o.h;
            if (dir.includes('e')) w = o.w + dx;
            if (dir.includes('s')) ht = o.h + dy;
            if (dir.includes('w')) { w = o.w - dx; x = o.x + dx; }
            if (dir.includes('n')) { ht = o.h - dy; y = o.y + dy; }
            if (aspect > 0) { // keep locked ratio, driven by the wider delta
              if (dir === 'n' || dir === 's') w = ht * aspect; else ht = w / aspect;
              if (dir.includes('w')) x = o.x + o.w - w;
              if (dir.includes('n')) y = o.y + o.h - ht;
            }
            x = Math.max(0, x); y = Math.max(0, y);
            w = Math.max(24, Math.min(w, dispW - x)); ht = Math.max(24, Math.min(ht, dispH - y));
            rect = { x, y, w, h: ht }; draw();
          });
        });
      }

      const setAspect = (ratio, btn) => {
        aspect = ratio;
        stage.parentElement.querySelectorAll('.bpe-cropper__ar').forEach((b) => b.classList.toggle('is-on', b === btn));
        if (ratio > 0) {
          let w = rect.w, ht = w / ratio;
          if (ht > dispH) { ht = dispH; w = ht * ratio; }
          rect = clampToStage({ x: rect.x, y: rect.y, w, h: ht });
          draw();
        }
      };
      const arBtn = (label, ratio) => el('button', { class: 'bpe-cropper__ar', type: 'button', onClick: (e) => setAspect(ratio, e.currentTarget) }, label);
      const freeBtn = arBtn('Free', 0);
      if (aspect === 0) freeBtn.classList.add('is-on'); // locked-aspect replace starts on no preset

      const save = () => {
        const sN = natW / dispW; // source px per stage px
        const cw = Math.max(1, Math.round(rect.w * sN)), ch = Math.max(1, Math.round(rect.h * sN));
        const cvs = document.createElement('canvas');
        cvs.width = cw; cvs.height = ch;
        cvs.getContext('2d').drawImage(img, rect.x * sN, rect.y * sN, rect.w * sN, rect.h * sN, 0, 0, cw, ch);
        const out = cvs.toDataURL('image/png');
        close();
        onSave(out, cw, ch);
      };

      const onKey = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      };
      const overlay = el('div', { class: 'bpe-cropper' }, [
        el('div', { class: 'bpe-cropper__dialog' }, [
          el('div', { class: 'bpe-cropper__head' }, [
            el('span', { class: 'bpe-cropper__title' }, 'Crop image'),
            el('button', { class: 'bpe-cropper__x', type: 'button', 'aria-label': 'Close', html: renderIcon('close'), onClick: () => close() }),
          ]),
          el('div', { class: 'bpe-cropper__ratios' }, [
            freeBtn, arBtn('1:1', 1), arBtn('4:3', 4 / 3), arBtn('3:4', 3 / 4), arBtn('16:9', 16 / 9),
          ]),
          el('div', { class: 'bpe-cropper__canvas' }, stage),
          el('div', { class: 'bpe-cropper__foot' }, [
            el('button', { class: 'bpe-cropper__btn', type: 'button', onClick: () => close() }, 'Cancel'),
            el('button', { class: 'bpe-cropper__btn bpe-cropper__btn--save', type: 'button', onClick: () => save() }, 'Save'),
          ]),
        ]),
      ]);
      function close() {
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        cropperOpen = false;
      }
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      draw();
    };
    img.onerror = () => onWarn('Could not load that image.');
    img.src = src;
  }

  /** Single-select model: "Select All" focuses the top-most object. */
  function selectAll() {
    if (!objects.length) { onWarn('Nothing to select yet.'); return; }
    select(objects[objects.length - 1].id);
  }

  /* --------- create-at-point (empty-canvas context menu actions) -------- */
  function addTextAt(p) { setTool('select'); createTextAt(p || lastPointer); }
  function addImageAt() { pickImage(); }
  function addShapeAt(p, shape) {
    if (shape) pendingShape = shape;
    const at = p || lastPointer;
    addObject({
      type: 'shape', shape: pendingShape,
      x: clamp(at.x - 80, 0, PW - 160), y: clamp(at.y - 45, 0, PH - 90), w: 160, h: 90,
      fill: '#e0e7ff', stroke: '#4f46e5', strokeWidth: 1.5,
      radius: pendingShape === 'roundRect' ? 16 : 4, opacity: 1,
    });
  }

  /* ------------------------------- pages -------------------------------- */
  function emitPages() { onPages({ count: pages.length, index: pageIndex, pages: pages.map((p) => ({ bg: p.bg })) }); }
  function addPage() {
    pushUndo();
    pages.splice(pageIndex + 1, 0, makePage());
    goToPage(pageIndex + 1, true);
    onDirty();
  }
  function deletePage(i = pageIndex) {
    pushUndo();
    if (pages.length <= 1) {
      // Last page: don't leave a zero-page (unrenderable) document — clear it to a
      // fresh blank page so "delete all" ends on an empty page instead of failing.
      pages = [makePage()];
      imported = false; importScanned = false; editHintShown = false;
      goToPage(0, true);
      onDirty();
      return;
    }
    pages.splice(i, 1);
    goToPage(clamp(i, 0, pages.length - 1), true);
    onDirty();
  }
  function goToPage(i, force) {
    i = clamp(i, 0, pages.length - 1);
    if (!force && i === pageIndex) return;
    if (endEditingText) layer.querySelector('.bpe-obj.is-editing')?.querySelector('.bpe-text')?.blur();
    pageIndex = i;
    objects = pages[i].objects;
    selectedId = null;
    // Imported pages carry their own size; adopt it so geometry/snapping is exact.
    if (pages[i].w) { PW = pages[i].w; PH = pages[i].h; applyPageSize(); applyZoom(); }
    renderLayer();
    onSelect(null);
    emitPages();
  }

  /* ------------------- multi-page tools (merge / images / rotate / organize) ---- */
  /** Append imported PDF pages (raster bg + editable text) — powers Merge. */
  function appendImportedDoc(doc) {
    if (!doc?.pages?.length) return 0;
    pushUndo();
    for (const p of doc.pages) {
      pages.push({ id: uid('pg'), objects: buildImportedObjects(p.texts), bg: p.bg, w: p.w, h: p.h, textChars: p.textChars || 0, images: p.images || [] });
    }
    imported = true;
    goToPage(pages.length - 1, true);
    onDirty();
    return doc.pages.length;
  }
  /** Add one page per image (page sized to the image) — powers Image → PDF. */
  function appendImagePages(items) {
    const list = (items || []).filter(Boolean);
    if (!list.length) return 0;
    pushUndo();
    for (const it of list) pages.push({ id: uid('pg'), objects: [], bg: it.src, w: it.w, h: it.h });
    goToPage(pages.length - 1, true);
    onDirty();
    return list.length;
  }
  /** Replace a page with a single flattened raster (used by Rotate: the page is
   *  re-baked at the rotated size, its objects folded into the image). */
  function replacePageRaster(index, bg, w, h) {
    const pg = pages[index];
    if (!pg) return;
    pushUndo();
    pg.bg = bg; pg.w = w; pg.h = h; pg.objects = [];
    if (index === pageIndex) { objects = pg.objects; PW = w; PH = h; applyPageSize(); applyZoom(); renderLayer(); onSelect(null); }
    onDirty();
    emitPages();
  }
  /** Reorder pages — powers Organize Pages. */
  function movePage(from, to) {
    from = clamp(from, 0, pages.length - 1); to = clamp(to, 0, pages.length - 1);
    if (from === to) return;
    pushUndo();
    const cur = pages[pageIndex];
    const [pg] = pages.splice(from, 1);
    pages.splice(to, 0, pg);
    goToPage(pages.indexOf(cur), true);
    onDirty();
  }
  /** Lightweight page list for the Organize dialog. */
  function getPageThumbs() { return pages.map((p, i) => ({ index: i, bg: p.bg || null, w: p.w || PW, h: p.h || PH })); }

  /* ---------------------------- page size ------------------------------- */
  function applyPageSize() {
    page.style.width = `${PW}px`;
    page.style.height = `${PH}px`;
    // cm dimensions derived from CSS px (96dpi) so imported/custom sizes work too.
    const cm = (px) => (px / 96 * 2.54).toFixed(1);
    onDims(`${cm(PW)} × ${cm(PH)} cm`);
  }
  function setPageSize(name) {
    if (!SIZES[name] || name === pageName) return;
    pushUndo();
    pageName = name;
    [PW, PH] = SIZES[name];
    applyPageSize();
    applyZoom();
    onDirty();
  }

  /* ------------------------------- tools -------------------------------- */
  function setTool(next) {
    if (next === 'image') { pickImage(); return; }
    if (next === 'signature') { openSignaturePad(); return; }
    tool = next;
    rootEl.dataset.tool = next;
    onToolChange(next);
  }

  function pickImage() {
    const input = el('input', { type: 'file', accept: 'image/*', style: 'position:fixed;left:-9999px' });
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      if (input.files[0]) addImageFromFile(input.files[0]);
      input.remove();
      setTool('select');
    });
    input.click();
  }

  /* --------------------------- signature pad ---------------------------- */
  function openSignaturePad() {
    const cvs = el('canvas', { class: 'bpe-sig__canvas', width: 520, height: 200 });
    const ctx = cvs.getContext('2d');
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111827';
    let drawing = false, has = false;
    const pos = (e) => { const r = cvs.getBoundingClientRect(); return { x: (e.clientX - r.left) * (cvs.width / r.width), y: (e.clientY - r.top) * (cvs.height / r.height) }; };
    cvs.addEventListener('pointerdown', (e) => { drawing = true; has = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); cvs.setPointerCapture(e.pointerId); });
    cvs.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
    cvs.addEventListener('pointerup', () => { drawing = false; });

    const close = () => { overlay.remove(); setTool('select'); };
    const overlay = el('div', { class: 'bpe-sig', onPointerdown: (e) => { if (e.target === overlay) close(); } }, [
      el('div', { class: 'bpe-sig__dialog' }, [
        el('div', { class: 'bpe-sig__head' }, [
          el('h3', { class: 'bpe-sig__title' }, 'Draw your signature'),
          el('button', { class: 'ws-btn ws-btn--icon', type: 'button', html: renderIcon('close'), onClick: close }),
        ]),
        el('div', { class: 'bpe-sig__pad' }, cvs),
        el('div', { class: 'bpe-sig__foot' }, [
          el('button', { class: 'ws-btn', type: 'button', onClick: () => { ctx.clearRect(0, 0, cvs.width, cvs.height); has = false; } }, 'Clear'),
          el('span', { class: 'bpe-sig__spacer' }),
          el('button', { class: 'ws-btn', type: 'button', onClick: close }, 'Cancel'),
          el('button', {
            class: 'ws-btn ws-btn--accent', type: 'button',
            onClick: () => {
              // Guard against inserting a BLANK signature (an empty box): a bare
              // pointerdown sets `has` but may leave no actual ink (no stroke), and
              // trimCanvas would then hand back a fully-transparent PNG. Check the
              // pixels for real ink instead of trusting `has`.
              if (!has || !canvasHasInk(cvs)) { onWarn('Draw a signature first.'); return; }
              insertImage(trimCanvas(cvs), { y: Math.round(PH * 0.62), paper: true });
              overlay.remove(); setTool('select');
            },
          }, 'Insert'),
        ]),
      ]),
    ]);
    document.body.appendChild(overlay);
  }

  /* -------------------------------- zoom -------------------------------- */
  function applyZoom() {
    box.style.width = `${PW * zoom}px`;
    box.style.height = `${PH * zoom}px`;
    page.style.transform = `scale(${zoom})`;
    onZoom(zoom);
  }
  function setZoom(z) { zoom = clamp(z, 0.1, 5); applyZoom(); }
  const zoomIn = () => setZoom(Math.round((zoom + 0.1) * 100) / 100);
  const zoomOut = () => setZoom(Math.round((zoom - 0.1) * 100) / 100);
  const fit = () => {
    const availH = viewport.clientHeight - 64;
    const availW = viewport.clientWidth - 64;
    setZoom(clamp(Math.min(availH / PH, availW / PW), 0.1, 2));
  };

  /* ---------------------- global keys (this editor) --------------------- */
  const ARROWS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  let lastNudge = 0;
  const isMod = (e) => e.ctrlKey || e.metaKey;
  const unbindKeys = keyboard.register({
    // The keyboard manager suspends these while a text box is being edited, so
    // Ctrl+C/V/Z etc. flow natively to the caret; they only fire on objects here.
    match: (e) => active && (
      e.key === 'Delete' || e.key === 'Backspace' || e.key === 'Escape' || e.key in ARROWS ||
      (isMod(e) && ['c', 'x', 'v', 'd', 'z', 'y', 'a'].includes(e.key.toLowerCase()))
    ),
    onKeyDown: (e) => {
      if (isMod(e)) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return true; }
        if ((k === 'y') || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return true; }
        if (k === 'a') { e.preventDefault(); selectAll(); return true; }
        if (k === 'v') { e.preventDefault(); pasteClipboard(lastPointer); return true; }
        if (!selectedId) return false;
        if (k === 'c') { e.preventDefault(); copySelected(); return true; }
        if (k === 'x') { e.preventDefault(); cutSelected(); return true; }
        if (k === 'd') { e.preventDefault(); duplicateSelected(); return true; }
        return false;
      }
      if (e.key === 'Escape') { select(null); return true; }
      const obj = find(selectedId);
      if (!obj) return false;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (!obj.locked) deleteSelected(); return true; }
      if (obj.locked) return false;
      const [dx, dy] = ARROWS[e.key];
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const now = Date.now();
      if (now - lastNudge > 500) pushUndo();
      lastNudge = now;
      obj.x = clamp(obj.x + dx * step, -obj.w + 20, PW - 20);
      obj.y = clamp(obj.y + dy * step, -obj.h + 20, PH - 20);
      place(obj);
      onDirty();
      return true;
    },
  });

  /* ------------------------------- helpers ------------------------------ */
  function find(id) { return objects.find((o) => o.id === id) || null; }
  function nodeOf(id) { return layer.querySelector(`.bpe-obj[data-id="${id}"]`); }

  /* -------------------------------- api --------------------------------- */
  return {
    rootEl,
    setActive(on) { active = on; if (!on && selectedId) select(null); },
    focus() { viewport.focus(); },
    setTool,
    getTool: () => tool,
    setShape: (s) => { pendingShape = s || 'rect'; },
    getShape: () => pendingShape,
    insertStamp,
    insertStampAtClient: (def, cx, cy) => insertStamp(def, clientToPage(cx, cy)),
    applyProperty,
    formatInline,
    addImageFromFile,
    deleteSelected,
    duplicateSelected,
    bringToFront: () => reorder('front'),
    sendToBack: () => reorder('back'),
    bringForward: () => reorderStep('forward'),
    sendBackward: () => reorderStep('backward'),
    toggleLock, isLocked, toggleTextStyle,
    copySelected, cutSelected, pasteClipboard, hasClipboard,
    rotateSelected, replaceImage, cropImage, selectAll,
    addTextAt, addImageAt, addShapeAt,
    // AI layer on top of Exact: marquee a baked region (setTool('ocr')) or call
    // this with a page-space rect to recognise it on-device and drop an editable,
    // masked text box in its place. `ocrReady()` lets the UI enable/greys the
    // action without triggering a model download (see core/ai/ocr.js).
    makeRegionEditable,
    ocrReady: () => isOcrAvailable(),
    editSelected: () => { const o = find(selectedId); if (o && (o.type === 'text' || o.type === 'comment')) editText(o); },
    hasSelection: () => selectedId != null,
    undo, redo,
    canUndo: () => doc.canUndo(),
    canRedo: () => doc.canRedo(),
    // The canonical DocumentModel backing this editor (single source of truth
    // for history + page structure). Synced from the LIVE editor on read (commits
    // any in-progress text edit first, and includes each page's embedded images),
    // so `doc.pages` is always a complete, current mirror. Exposed for the
    // shell/exporters and for round-trip save/load (see loadFromModel).
    getDocumentModel: () => syncDoc(),
    loadFromModel,
    zoomIn, zoomOut, fit, setZoom, getZoom: () => zoom,
    // pages
    addPage, deletePage, goToPage,
    appendImportedDoc, appendImagePages, replacePageRaster, movePage, getPageThumbs,
    getPageCount: () => pages.length,
    getPageIndex: () => pageIndex,
    onPagesReady: emitPages,
    loadDocument, newDocument,
    // page size
    setPageSize, getPageSize: () => pageName, getPageDims: () => SIZES[pageName][2],
    isEmpty: () => pages.every((p) => p.objects.length === 0),
    // Flattened export model that the converters consume — now derived FROM the
    // canonical DocumentModel (syncDoc → exportModelFromDoc), so the model is the
    // single source of truth that drives every export. Proven byte-identical to
    // the previous direct build across all object types (see documentSync tests).
    // syncDoc() commits any in-progress text edit FIRST: a contenteditable box
    // only writes back on blur (stopEditText), but export can be triggered (File
    // menu, shortcut) without blurring it — without the commit an edited imported
    // run would export its stale pre-edit text over the mask.
    getExportModel: () => exportModelFromDoc(syncDoc()),
    stats() {
      const text = pages.flatMap((pg) => pg.objects).filter((o) => o.type === 'text' || o.type === 'comment')
        .map((o) => htmlToText(o.text || '')).join(' ');
      const trimmed = text.trim();
      const words = trimmed ? trimmed.split(/\s+/).length : 0;
      return { objects: pages.reduce((n, p) => n + p.objects.length, 0), words, chars: text.replace(/\s/g, '').length };
    },
    destroy() { unbindKeys(); hideInlineToolbar(); if (endEditingText) endEditingText(); rootEl.remove(); },
  };
}

/* ------------------------------ pure utils ------------------------------ */
/**
 * Render a shape as a stretch-to-fit SVG. A normalized 0..100 viewBox keeps
 * every geometry defined once and scaled to the object's box; a non-scaling
 * stroke keeps outlines an even thickness even when the box is not square.
 * Line/arrow shapes are stroke-driven (they track the border colour), while
 * area shapes use fill + border like the classic rectangle. Exported so the
 * toolbar shape picker can render live previews from the same source of truth.
 */
export function shapeSvgMarkup(obj) {
  const hasStroke = (obj.strokeWidth || 0) > 0 && obj.stroke && obj.stroke !== 'transparent';
  const stroke = hasStroke ? obj.stroke : 'none';
  const fill = obj.fill && obj.fill !== 'transparent' ? obj.fill : 'none';
  const line = obj.stroke && obj.stroke !== 'transparent' ? obj.stroke : (obj.fill || '#4f46e5');
  const sw = `stroke-width="${obj.strokeWidth || 0}" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"`;
  const area = `fill="${fill}" stroke="${stroke}" ${sw}`;
  const rx = clamp(obj.radius ?? 0, 0, 50);
  let inner;
  switch (obj.shape) {
    case 'roundRect':
      inner = `<rect x="0" y="0" width="100" height="100" rx="${Math.max(rx, 12)}" ${area}/>`; break;
    case 'circle':
    case 'ellipse':
      inner = `<ellipse cx="50" cy="50" rx="50" ry="50" ${area}/>`; break;
    case 'triangle':
      inner = `<polygon points="50,2 98,98 2,98" ${area}/>`; break;
    case 'diamond':
      inner = `<polygon points="50,2 98,50 50,98 2,50" ${area}/>`; break;
    case 'line':
      inner = `<line x1="2" y1="50" x2="98" y2="50" stroke="${line}" ${sw}/>`; break;
    case 'arrow':
      inner = `<line x1="2" y1="50" x2="80" y2="50" stroke="${line}" ${sw}/><polygon points="76,32 100,50 76,68" fill="${line}"/>`; break;
    case 'doubleArrow':
      inner = `<line x1="20" y1="50" x2="80" y2="50" stroke="${line}" ${sw}/><polygon points="76,32 100,50 76,68" fill="${line}"/><polygon points="24,32 0,50 24,68" fill="${line}"/>`; break;
    case 'speech':
      inner = `<path d="M14,4 H86 A12,12 0 0 1 98,16 V56 A12,12 0 0 1 86,68 H40 L20,96 V68 H14 A12,12 0 0 1 2,56 V16 A12,12 0 0 1 14,4 Z" ${area}/>`; break;
    case 'star':
      inner = `<polygon points="50,0 61.8,33.8 97.6,34.5 69,56.2 79.4,90.5 50,70 20.6,90.5 31,56.2 2.4,34.5 38.2,33.8" ${area}/>`; break;
    case 'heart':
      inner = `<path d="M50,88 C22,66 4,49 4,30 C4,16 15,6 28,6 C38,6 46,12 50,20 C54,12 62,6 72,6 C85,6 96,16 96,30 C96,49 78,66 50,88 Z" ${area}/>`; break;
    case 'rect':
    default:
      inner = `<rect x="0" y="0" width="100" height="100" rx="${rx}" ${area}/>`;
  }
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none">${inner}</svg>`;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function htmlToText(html) { const d = document.createElement('div'); d.innerHTML = html; return d.textContent || ''; }

function toPath(pts) {
  if (!pts.length) return '';
  return pts.map((p, i) => `${i ? 'L' : 'M'}${round(p.x)} ${round(p.y)}`).join(' ');
}
function round(n) { return Math.round(n * 10) / 10; }

function bbox(pts, pad = 0) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
}

/** Dominant colour of an [r,g,b] sample set: average within the largest 16-level
 *  bucket, so a few stray ink pixels can't shift the paper. */
function dominantRgb(cols) {
  const buckets = new Map();
  for (const c of cols) {
    const key = `${c[0] >> 4},${c[1] >> 4},${c[2] >> 4}`;
    const b = buckets.get(key) || { n: 0, r: 0, g: 0, bl: 0 };
    b.n += 1; b.r += c[0]; b.g += c[1]; b.bl += c[2];
    buckets.set(key, b);
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.bl / best.n)];
}
function dominantHex(cols) {
  const [r, g, b] = dominantRgb(cols);
  const to2 = (v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}
/** Dominant colour of an image's border pixels (its own background). Ignores
 *  fully-transparent pixels; returns null when the border is all transparent. */
function imageBorderColor(px, w, h) {
  const cols = [];
  const sx = Math.max(1, Math.round(w / 60));
  const sy = Math.max(1, Math.round(h / 60));
  const at = (x, y) => { const i = (y * w + x) * 4; if (px[i + 3] >= 8) cols.push([px[i], px[i + 1], px[i + 2]]); };
  for (let x = 0; x < w; x += sx) { at(x, 0); at(x, h - 1); }
  for (let y = 0; y < h; y += sy) { at(0, y); at(w - 1, y); }
  return cols.length ? dominantRgb(cols) : null;
}

/** True if the canvas has any non-transparent pixels (real drawn ink). Used to
 *  stop a blank signature being inserted as an empty box. */
function canvasHasInk(cvs) {
  try {
    const { width: w, height: h } = cvs;
    const d = cvs.getContext('2d').getImageData(0, 0, w, h).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true;
    return false;
  } catch { return true; } // can't inspect → don't block insertion
}

function trimCanvas(cvs) {
  const ctx = cvs.getContext('2d');
  const { width: w, height: h } = cvs;
  const data = ctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = 0, maxY = 0, found = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) { found = true; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    }
  }
  if (!found) return cvs.toDataURL('image/png');
  const pad = 8;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w, maxX + pad); maxY = Math.min(h, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX; out.height = maxY - minY;
  out.getContext('2d').drawImage(cvs, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}
