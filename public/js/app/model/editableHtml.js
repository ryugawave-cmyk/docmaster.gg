/**
 * Document Model ⇄ editable DOM.
 *
 * The editor is a `contentEditable` surface so the browser gives us natural text
 * editing (typing, Enter → new paragraph, Backspace, copy/paste, native caret).
 * This module is the bridge:
 *   - `renderBlocks(doc)`   → block elements to drop into the editable page.
 *   - `readBlocks(rootEl)`  → reads the (possibly user-mutated) DOM back into the
 *                             model, so edits are captured structurally.
 *
 * Reading marks via `getComputedStyle` means we capture formatting no matter how
 * it was applied (our styled spans, execCommand's <b>/<i>/<u>, pasted markup),
 * which keeps the round-trip robust.
 */
import { DEFAULT_MARKS, createRun, normalizeRuns } from './documentModel.js';

const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'DIV', 'FIGURE', 'TABLE', 'UL', 'OL']);

// Per-cell erased grid lines are stored as letters (t/r/b/l) and map to the
// matching CSS border-<side>-style, set to `hidden` to drop that line.
const EDGE_STYLE_PROP = { t: 'borderTopStyle', r: 'borderRightStyle', b: 'borderBottomStyle', l: 'borderLeftStyle' };

/* ------------------------------- model → DOM ------------------------------ */
export function renderBlocks(doc) {
  return doc.blocks.map(blockToEl);
}

function blockToEl(block) {
  if (block.type === 'posbox') return posboxToEl(block); // positioned (exact-layout) text box
  const el = block.type === 'image' ? imageToEl(block)
    : block.type === 'table' ? tableToEl(block)
      : block.type === 'list' ? listToEl(block)
        : paragraphToEl(block);
  // A forced page break BEFORE this block (e.g. an imported PDF/Word page
  // boundary): the pagination engine pushes it to the top of the next page so
  // the document keeps the source's page count instead of reflowing freely.
  if (block.breakBefore) el.classList.add('doc-break-before');
  return el;
}

function paragraphToEl(block) {
  const el = document.createElement(block.tag || 'p');
  el.className = 'doc-block';
  el.dataset.blockId = block.id;
  applyBlockStyle(el, block.style);
  const runs = block.runs && block.runs.length ? block.runs : [createRun('')];
  let hasText = false;
  for (const run of runs) {
    if (!run.text && !run.field) continue;
    el.appendChild(runToNode(run));
    hasText = true;
  }
  if (!hasText) el.appendChild(document.createElement('br')); // keep empty paras selectable
  return el;
}

/**
 * A POSITIONED (exact-layout) text box: absolutely placed at the PDF's own
 * coordinates and independently editable, so imported PDF content keeps its exact
 * position/size/formatting instead of reflowing. `left/width/min-height` come from
 * the page-relative frame; the vertical page offset (`top`) is applied by the
 * editor's positioned layout pass, which knows the page geometry. See
 * services/convert/positionedImport.js and documentEditor.layoutPositioned().
 */
function posboxToEl(block) {
  const box = document.createElement('div');
  // Dormant by default: hidden so the original page image shows through pixel-exact;
  // the editor reveals it on focus and keeps it revealed once edited (documentEditor).
  box.className = 'doc-posbox doc-posbox--dormant';
  box.dataset.blockId = block.id;
  const f = block.frame || {};
  box.dataset.page = String(block.page || 0);
  box.dataset.x = String(Math.round(f.x || 0));
  box.dataset.y = String(Math.round(f.y || 0));
  box.dataset.w = String(Math.round(f.w || 0));
  box.dataset.h = String(Math.round(f.h || 0));
  // Heading level (inferred from the PDF's font size) so the left outline can list
  // it and the box reads as a heading. Purely a tag — position/size are unchanged.
  if (block.heading) { box.dataset.heading = String(block.heading); box.classList.add(`doc-posbox--h${block.heading}`); }
  box.setAttribute('contenteditable', 'true');
  box.style.position = 'absolute';
  box.style.left = `${Math.round(f.x || 0)}px`;
  box.style.width = `${Math.round(f.w || 0)}px`;
  box.style.minHeight = `${Math.round(f.h || 0)}px`;
  // One-line box (a table-cell label/value): don't let a slightly-wider substitute
  // font wrap it onto the baked line beneath. See positionedImport (nowrap).
  if (block.nowrap) { box.style.whiteSpace = 'nowrap'; box.dataset.nowrap = '1'; }
  // Mask fill sampled from the page background, so the box hides any baked glyphs
  // underneath (edits then visibly replace the text). Empty → transparent. `opacity`
  // (0..1, box BACKGROUND only) lets the user fade the box to reveal the page image
  // while the text stays fully solid — applied as an rgba background, NOT CSS opacity
  // (which would fade the text too).
  if (block.fill) {
    const hex = String(block.fill).replace(/^#/, '');
    box.dataset.fill = block.fill;
    const a = block.opacity == null ? 1 : Math.max(0, Math.min(1, block.opacity));
    box.style.background = a >= 1 ? `#${hex}` : rgbaFromHex(hex, a);
    if (block.opacity != null) box.dataset.opacity = String(a);
  }
  if (block.style && block.style.align) box.style.textAlign = block.style.align;
  const runs = block.runs && block.runs.length ? block.runs : [createRun('')];
  let hasText = false;
  for (const run of runs) {
    if (!run.text && !run.field) continue;
    box.appendChild(runToNode(run));
    hasText = true;
  }
  if (!hasText) box.appendChild(document.createElement('br'));
  return box;
}

function runToNode(run) {
  const m = { ...DEFAULT_MARKS, ...run.marks };
  const span = document.createElement('span');
  // Auto-updating field (page number / total): rendered as an inert, non-editable
  // chip. The real number is substituted per page by the header/footer renderer;
  // the placeholder keeps it visible/measurable in editors and offscreen measures.
  if (run.field) {
    span.className = 'doc-field';
    span.dataset.field = run.field;
    span.contentEditable = 'false';
    span.textContent = '1';
  } else {
    // Strip tofu-box placeholder/control chars on the way to the DOM too, so an
    // imported doc (whose model is built without going through readRuns) never
    // shows the box in the editor either.
    span.textContent = String(run.text).replace(JUNK_CHARS, '');
  }
  span.style.fontFamily = m.fontFamily;
  span.style.fontSize = `${m.fontSize}px`;
  span.style.color = m.color;
  if (m.bold) span.style.fontWeight = '700';
  if (m.italic) span.style.fontStyle = 'italic';
  // Underline and strikethrough share the text-decoration property, so combine.
  const deco = [m.underline && 'underline', m.strike && 'line-through'].filter(Boolean).join(' ');
  if (deco) span.style.textDecoration = deco;
  return span;
}

function listToEl(block) {
  const list = document.createElement(block.ordered ? 'ol' : 'ul');
  list.className = 'doc-block doc-list';
  list.dataset.blockId = block.id;
  const items = block.items && block.items.length ? block.items : [{ runs: [createRun('')] }];
  for (const item of items) {
    const li = document.createElement('li');
    let hasText = false;
    for (const run of normalizeRuns(item.runs || [createRun('')])) {
      if (!run.text && !run.field) continue;
      li.appendChild(runToNode(run));
      hasText = true;
    }
    if (!hasText) li.appendChild(document.createElement('br'));
    list.appendChild(li);
  }
  return list;
}

function imageToEl(block) {
  const fig = document.createElement('figure');
  fig.className = 'doc-block doc-image';
  fig.dataset.blockId = block.id;
  fig.contentEditable = 'false';
  fig.style.textAlign = block.align || 'left';
  const img = document.createElement('img');
  img.src = block.src;
  if (block.width) img.style.width = `${block.width}px`;
  img.draggable = false;
  fig.appendChild(img);
  // Freely-positioned (dragged) image: restore its absolute spot on the page.
  if (block.left != null && block.top != null) {
    fig.classList.add('is-floating');
    fig.style.left = `${block.left}px`;
    fig.style.top = `${block.top}px`;
  }
  if (block.z != null) fig.style.zIndex = String(block.z);
  // Text-wrap mode (Word/Docs). Persists for every figure — image, shape, chart.
  if (block.wrap && block.wrap !== 'inline') {
    fig.dataset.wrap = block.wrap;
    if (block.wrap === 'left') fig.classList.add('is-wrap-left');
    else if (block.wrap === 'right') fig.classList.add('is-wrap-right');
    else if (block.wrap === 'behind') fig.classList.add('is-behind');
  }
  // Inserted vector shape: keep its parameters as data-* so it stays recolourable
  // (the editor regenerates the baked SVG from these). block.src is the baked SVG
  // so it still renders/exports without regeneration.
  if (block.shape) {
    fig.classList.add('doc-shape');
    const sh = block.shape;
    fig.dataset.shapeId = sh.id;
    if (sh.fill != null) fig.dataset.fill = sh.fill;
    if (sh.stroke != null) fig.dataset.stroke = sh.stroke;
    if (sh.strokeWidth != null) fig.dataset.strokeWidth = String(sh.strokeWidth);
    if (sh.opacity != null) fig.dataset.opacity = String(sh.opacity);
  }
  // A Professional Library chart carries its full editable spec on data-chart, so
  // it stays a real editable object after save/reload (block.src is the rendered
  // SVG for display/export). Entirely separate from shapes.
  if (block.chart) {
    fig.classList.add('doc-chart');
    fig.dataset.chart = typeof block.chart === 'string' ? block.chart : JSON.stringify(block.chart);
  }
  return fig;
}

function tableToEl(block) {
  const table = document.createElement('table');
  table.className = 'doc-block doc-table';
  // Manual border weight: 'thin' (default), 'thick' or 'none'.
  if (block.border && block.border !== 'thin') {
    table.classList.add(`doc-table--${block.border}`);
    table.dataset.border = block.border;
  }
  table.dataset.blockId = block.id;
  // Column widths (fractions of the table width) drive a <colgroup> so dragged
  // column sizes survive a reload; absent → table-layout:fixed shares evenly.
  if (Array.isArray(block.cols) && block.cols.length) {
    const cg = document.createElement('colgroup');
    for (const frac of block.cols) {
      const col = document.createElement('col');
      col.style.width = `${(frac * 100).toFixed(3)}%`;
      cg.appendChild(col);
    }
    table.appendChild(cg);
  }
  const tbody = document.createElement('tbody');
  block.rows.forEach((row, ri) => {
    const tr = document.createElement('tr');
    // Dragged row height (px) survives a reload.
    const h = block.rowH && block.rowH[ri];
    if (h) tr.style.height = `${h}px`;
    for (const cell of row) {
      const td = document.createElement('td');
      if (h) td.style.height = `${h}px`;
      // Merged cells span columns/rows (covered positions are simply omitted,
      // exactly like HTML), so text flows across removed internal lines.
      if (cell.colSpan && cell.colSpan > 1) td.colSpan = cell.colSpan;
      if (cell.rowSpan && cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
      // Per-cell erased grid lines (letters t/r/b/l) → hidden border edges.
      if (cell.hide) {
        for (const ch of cell.hide) {
          const prop = EDGE_STYLE_PROP[ch];
          if (prop) td.style[prop] = 'hidden';
        }
        td.classList.add('is-lineerased'); // lets Lines mode tint it for restore
      }
      // Mirror the paragraph/list-item pattern: only emit runs that have text,
      // and give an empty cell a <br> so it keeps a real line box. Without this,
      // an empty cell held only an empty <span> (no line box) and collapsed to
      // zero content height, so its grid lines rendered inconsistently when a
      // sibling cell's multiline text made the row tall.
      let hasText = false;
      for (const run of normalizeRuns(cell.runs || [createRun('')])) {
        if (!run.text && !run.field) continue;
        td.appendChild(runToNode(run));
        hasText = true;
      }
      if (!hasText) td.appendChild(document.createElement('br'));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

function applyBlockStyle(el, style = {}) {
  if (style.align) el.style.textAlign = style.align;
  if (style.lineHeight) el.style.lineHeight = String(style.lineHeight);
  if (style.spaceBefore != null) el.style.marginTop = `${style.spaceBefore}px`;
  if (style.spaceAfter != null) el.style.marginBottom = `${style.spaceAfter}px`;
}

/* ------------------------------- DOM → model ------------------------------ */
export function readBlocks(rootEl) {
  const blocks = [];
  for (const el of Array.from(rootEl.children)) {
    if (el.classList.contains('doc-pagebreak')) continue; // pagination spacer — not content
    if (el.classList.contains('doc-posbox')) { blocks.push(readPosbox(el)); continue; } // positioned box
    if (!BLOCK_TAGS.has(el.tagName)) continue;
    let blk;
    if (el.tagName === 'FIGURE') blk = readImage(el);
    else if (el.tagName === 'TABLE') blk = readTable(el);
    else if (el.tagName === 'UL' || el.tagName === 'OL') blk = readList(el);
    else blk = readParagraph(el);
    // Preserve a forced page break so it survives edits, save/reload and export.
    if (el.classList.contains('doc-break-before')) blk.breakBefore = true;
    blocks.push(blk);
  }
  return blocks.length ? blocks : [{ type: 'paragraph', tag: 'p', style: {}, runs: [createRun('')] }];
}

function readParagraph(el) {
  const tag = /^H[123]$/.test(el.tagName) ? el.tagName.toLowerCase() : 'p';
  return {
    id: el.dataset.blockId,
    type: 'paragraph',
    tag,
    style: readBlockStyle(el),
    runs: readRuns(el),
  };
}

/** Read a positioned (exact-layout) text box back into the model. Keeps its
 *  page-relative frame; height tracks the live box so edits that add lines persist.
 *  The absolute `top` is derived from page geometry at render time, never stored. */
function readPosbox(el) {
  const num = (v) => Math.round(parseFloat(v) || 0);
  const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { height: 0 };
  const block = {
    id: el.dataset.blockId,
    type: 'posbox',
    page: parseInt(el.dataset.page || '0', 10) || 0,
    frame: {
      x: num(el.style.left) || num(el.dataset.x),
      y: num(el.dataset.y),
      w: num(el.style.width) || num(el.dataset.w),
      h: Math.round(rect.height) || num(el.dataset.h),
    },
    style: { align: el.style.textAlign || 'left' },
    runs: readRuns(el),
  };
  if (el.dataset.heading) block.heading = parseInt(el.dataset.heading, 10) || undefined;
  if (el.dataset.fill) block.fill = el.dataset.fill;
  if (el.dataset.opacity != null && el.dataset.opacity !== '') block.opacity = Math.max(0, Math.min(1, parseFloat(el.dataset.opacity)));
  if (el.dataset.nowrap === '1') block.nowrap = true;
  return block;
}

/** `#rrggbb` (or `rrggbb`) + alpha 0..1 → a CSS rgba() string. */
function rgbaFromHex(hex, a) {
  const h = String(hex).replace(/^#/, '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function readBlockStyle(el) {
  const cs = getComputedStyle(el);
  return {
    align: el.style.textAlign || (cs.textAlign === 'start' ? 'left' : cs.textAlign) || 'left',
    lineHeight: parseFloat(el.style.lineHeight) || round2(parseFloat(cs.lineHeight) / parseFloat(cs.fontSize)) || 1.4,
    spaceBefore: parseFloat(el.style.marginTop) || 0,
    spaceAfter: parseFloat(el.style.marginBottom) || 10,
  };
}

// Non-printable / placeholder characters that carry no meaning in body text but
// render as a hollow "tofu" box (a leftover U+FFFC object-replacement char from an
// import, a stray BOM, C0/C1 controls, the replacement char, …). Stripped on read
// so they never enter the model — and so never appear in the editor or any export.
// Preserves tab/newline/CR and the zero-width joiners (U+200C/U+200D) that complex
// scripts depend on.
const JUNK_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\uFEFF\uFFF9-\uFFFD]/g;

/** Walk text nodes in order, deriving each run's marks from computed style. */
function readRuns(blockEl) {
  const runs = [];
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  let node;
  const seenFields = new Set();
  while ((node = walker.nextNode())) {
    const text = node.nodeValue;
    if (!text) continue;
    // A page-number / count field is stored as a field run, not its rendered
    // number — so it keeps auto-updating. Count each field element once.
    const fieldEl = node.parentElement && node.parentElement.closest('[data-field]');
    if (fieldEl) {
      if (seenFields.has(fieldEl)) continue;
      seenFields.add(fieldEl);
      runs.push({ field: fieldEl.dataset.field, marks: marksFromEl(fieldEl) });
      continue;
    }
    // Drop tofu-box placeholder/control chars (e.g. a stray U+FFFC from an import)
    // so they never reach the model, the editor render, or any export.
    const clean = text.replace(JUNK_CHARS, '');
    if (!clean) continue;
    runs.push({ text: clean, marks: marksFromEl(node.parentElement) });
  }
  return normalizeRuns(runs);
}

function readList(listEl) {
  const items = Array.from(listEl.children)
    .filter((li) => li.tagName === 'LI')
    .map((li) => ({ runs: readRuns(li) }));
  return {
    id: listEl.dataset.blockId,
    type: 'list',
    ordered: listEl.tagName === 'OL',
    items: items.length ? items : [{ runs: [createRun('')] }],
  };
}

function readImage(fig) {
  const img = fig.querySelector('img');
  const floating = fig.classList.contains('is-floating');
  const block = {
    id: fig.dataset.blockId,
    type: 'image',
    src: img?.src || '',
    width: img ? Math.round(img.getBoundingClientRect().width) : null,
    height: img ? Math.round(img.getBoundingClientRect().height) : null,
    align: fig.style.textAlign || 'left',
    // Absolute position on the page, only when the user has dragged it free.
    left: floating ? Math.round(parseFloat(fig.style.left) || 0) : undefined,
    top: floating ? Math.round(parseFloat(fig.style.top) || 0) : undefined,
  };
  if (fig.style.zIndex) block.z = parseInt(fig.style.zIndex, 10);
  // Text-wrap mode (any figure). 'inline' is the default, so it's left implicit.
  const wrap = fig.dataset.wrap;
  if (wrap && wrap !== 'inline') block.wrap = wrap;
  // Recolourable vector shape parameters (see imageToEl).
  if (fig.dataset.shapeId) {
    block.shape = {
      id: fig.dataset.shapeId,
      fill: fig.dataset.fill,
      stroke: fig.dataset.stroke,
      strokeWidth: fig.dataset.strokeWidth != null ? parseFloat(fig.dataset.strokeWidth) : undefined,
      opacity: fig.dataset.opacity != null ? parseFloat(fig.dataset.opacity) : undefined,
    };
  }
  // Professional Library chart spec (keeps the chart editable after save/reload).
  if (fig.dataset.chart) {
    try { block.chart = JSON.parse(fig.dataset.chart); } catch { /* keep as image */ }
  }
  return block;
}

function readTable(table) {
  // Pagination injects spacer + repeated-header rows to keep rows off page seams;
  // they are visual-only, so exclude them from the model round-trip.
  const bodyRows = Array.from(table.rows).filter((tr) =>
    !tr.classList.contains('doc-pagebreak-row') && !tr.classList.contains('doc-pagebreak-header'));
  const rows = bodyRows.map((tr) =>
    Array.from(tr.cells).map((td) => {
      const cell = { runs: readRuns(td) };
      let hide = '';
      for (const [ch, prop] of Object.entries(EDGE_STYLE_PROP)) {
        if (td.style[prop] === 'hidden') hide += ch;
      }
      if (hide) cell.hide = hide;
      if (td.colSpan > 1) cell.colSpan = td.colSpan; // merged cells persist their span
      if (td.rowSpan > 1) cell.rowSpan = td.rowSpan;
      return cell;
    })
  );
  const border = table.dataset.border || 'thin';
  // Read dragged column widths back as fractions (normalised to sum 1).
  let cols;
  const cg = table.querySelector('colgroup');
  if (cg && cg.children.length) {
    const ws = Array.from(cg.children).map((c) => parseFloat(c.style.width) || 0);
    const sum = ws.reduce((a, b) => a + b, 0);
    if (sum > 0) cols = ws.map((w) => w / sum);
  }
  // Read dragged row heights (px); undefined per row when never resized.
  const heights = bodyRows.map((tr) => Math.round(parseFloat(tr.style.height)) || null);
  const rowH = heights.some((h) => h) ? heights : undefined;
  return { id: table.dataset.blockId, type: 'table', rows, border, cols, rowH };
}

/* --------------------------------- marks ---------------------------------- */
export function marksFromEl(el) {
  if (!el) return { ...DEFAULT_MARKS };
  const cs = getComputedStyle(el);
  const deco = cs.textDecorationLine || cs.textDecoration || '';
  // <sup>/<sub> shrink font-size via UA styles; read the size from the nearest
  // real ancestor so superscript/subscript text keeps its true size in the model.
  const sizeEl = /^(SUP|SUB)$/.test(el.tagName) && el.parentElement ? el.parentElement : el;
  return {
    bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
    italic: cs.fontStyle === 'italic',
    underline: deco.includes('underline'),
    strike: deco.includes('line-through'),
    fontFamily: cleanFamily(cs.fontFamily),
    fontSize: Math.round(parseFloat(getComputedStyle(sizeEl).fontSize)) || DEFAULT_MARKS.fontSize,
    color: rgbToHex(cs.color) || DEFAULT_MARKS.color,
  };
}

function cleanFamily(family) {
  return (family || '').split(',')[0].replace(/['"]/g, '').trim() || DEFAULT_MARKS.fontFamily;
}

function rgbToHex(rgb) {
  if (!rgb) return null;
  if (rgb.startsWith('#')) return rgb;
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!m) return null;
  const h = (n) => Number(n).toString(16).padStart(2, '0');
  return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
