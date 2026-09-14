/**
 * Document editor — the new editing engine (replaces annotation-on-PDF editing).
 *
 * A `contentEditable` document surface that renders the Unified Document Model
 * and edits it like Google Docs: click to place the caret, type, Enter makes a
 * new paragraph, Backspace/Delete removes, copy/paste works natively. Formatting
 * (bold/italic/underline, font, size, color, alignment, line-height) is applied
 * to the selection and read back into the model. History is snapshot-based so it
 * drives the shell's Undo/Redo.
 *
 * It is workspace-agnostic: give it a container and a model; it emits `onChange`
 * (edited) and `onSelection` (caret formatting, for the properties panel). Both
 * the PDF and the future DOCX flow mount THIS editor on the same model.
 */
import { el } from '../../workspace/utils/dom.js';
import { keyboard } from '../core/keyboard.js';
import { renderBlocks, readBlocks, marksFromEl } from '../model/editableHtml.js';
import { cloneDocument, createHeaderFooter } from '../model/documentModel.js';
import * as TG from '../model/tableGrid.js';
import { shapeSvg, shapeHasFill } from './shapeLibrary.js';
import { renderChartSvg, normalizeChart, sampleChart, TYPE_META, CHART_CATALOG, chartTypeLabel, PALETTES, PALETTE_IDS, PER_POINT_FAMILIES } from './chartRender.js';
import { openChartDataEditor } from './chartDataEditor.js';

/**
 * Insert a line break at the caret INSIDE a positioned text box (`.doc-posbox`),
 * preserving every existing character. Positioned (exact-layout) docs pin each box
 * to absolute page coordinates, so the normal paragraph split — which extracts the
 * post-caret content into a NEW sibling flow block — would tear that text out of the
 * positioned layer: the box empties and the line appears to vanish. Keeping the break
 * inside the one box is lossless; the box simply grows a line.
 *
 * Returns a collapsed Range sitting on the new line (the caller installs it as the
 * selection). Exported so it can be verified against a real DOM.
 *
 * @param {Range} range collapsed (or not) caret range inside `box`
 * @param {HTMLElement} box the `.doc-posbox` element
 * @returns {Range}
 */
export function breakInPosbox(range, box) {
  if (!range.collapsed) range.deleteContents();
  const br = document.createElement('br');
  range.insertNode(br);
  // A lone <br> at the very END of the box renders nothing after it in most engines,
  // so the caret can't sit on the new line. Add a trailing <br> only in that case;
  // when real content follows the break (a mid-line split) it's left untouched.
  let hasFollowing = false;
  for (let n = br.nextSibling; n; n = n.nextSibling) {
    const rendered = n.nodeName === 'BR' || (n.nodeType === 3 ? n.nodeValue.length : (n.textContent || '').length);
    if (rendered) { hasFollowing = true; break; }
  }
  if (!hasFollowing) br.after(document.createElement('br'));
  const r = document.createRange();
  r.setStartAfter(br);
  r.collapse(true);
  return r;
}

/**
 * Keep a positioned text box (`.doc-posbox`) wide enough to hold its line on ONE row.
 *
 * A posbox is ONE PDF line whose width came from the PDF's own (narrower) embedded-font
 * ink extent (services/convert/positionedImport). The editor draws the line in a
 * SUBSTITUTE font that is a touch wider, so a wrapping (paragraph) box re-wraps its last
 * word onto a 2nd row the instant it's revealed — the reported "paragraph width shrinks /
 * text reflows when I click it" bug. (The import-time width fit measures with a canvas
 * BEFORE the web font has loaded, so it under-measures; measuring the LIVE box here — the
 * real font already applied — is exact.)
 *
 * Measure the content's natural single-line width (temporarily `nowrap` + `auto`) and GROW
 * the box to it, capped at the page's right edge. GROW-ONLY: a box already wide enough is
 * left untouched, so it's idempotent and a late-loading font just converges on re-reveal.
 * Narrow `nowrap` boxes (table labels/values) are skipped — widening their opaque mask
 * fill would spill over the neighbouring cell. Exported so it can be verified in a DOM.
 *
 * @param {HTMLElement} box the `.doc-posbox`
 * @param {number} pageWidth the page width in px (0 = unknown → no right-edge cap)
 * @returns {number} the box's width (px) after fitting
 */
export function fitPosboxWidthEl(box, pageWidth) {
  if (!box || box.dataset.nowrap === '1') return box ? (parseFloat(box.style.width) || box.offsetWidth || 0) : 0;
  const cur = parseFloat(box.style.width) || box.offsetWidth || 0;
  const prevWS = box.style.whiteSpace;
  const prevW = box.style.width;
  box.style.whiteSpace = 'nowrap';
  box.style.width = 'auto';                          // shrink-to-fit → offsetWidth = 1-line width
  const natural = box.offsetWidth;
  box.style.whiteSpace = prevWS || '';
  box.style.width = prevW || '';
  if (!(natural > 0)) return cur;
  const x = parseFloat(box.style.left) || 0;
  const maxW = Math.max(cur, pageWidth ? pageWidth - x - 2 : cur); // never run off the sheet
  const target = Math.min(natural + 2, maxW);                       // +2 guards rounding/caret
  if (target > cur + 0.5) {
    const w = Math.round(target);
    box.style.width = `${w}px`;
    box.dataset.w = String(w);                       // keep dataset (readPosbox fallback) in sync
    return w;
  }
  return cur;
}

/** Pagination debug logging (page geometry, usable height, computed per-block
 *  font-size / line-height, image rendered dims, final page count). Off by default;
 *  enable with `localStorage.DOCX_DEBUG = '1'` or `globalThis.__DOCX_DEBUG = true`. */
function docDebugOn() {
  try { if (globalThis.__DOCX_DEBUG) return true; } catch { /* no global */ }
  try { return typeof localStorage !== 'undefined' && localStorage.getItem('DOCX_DEBUG') === '1'; } catch { return false; }
}

export function createDocumentEditor({ container, onChange, onSelection, onPaginate, onRequestHfSettings }) {
  container.classList.add('doc-editor');
  const scroll = el('div', { class: 'doc-editor-scroll' });
  // A page "stack": white sheets drawn behind (one per page, with gaps) and the
  // single contentEditable surface on top. Pagination inserts non-editable
  // spacers so content that overflows a page flows onto the next sheet.
  const stack = el('div', { class: 'doc-pagestack' });
  const sheets = el('div', { class: 'doc-sheets', 'aria-hidden': 'true' });
  // Optional margin guides (a dashed rectangle at each page's content box). Off by
  // default; toggled from Page setup → "Show page margins".
  const guides = el('div', { class: 'doc-guides', 'aria-hidden': 'true' });
  const vruler = el('div', { class: 'doc-vruler', 'aria-hidden': 'true' }); // vertical ruler, left of the page
  const page = el('div', { class: 'doc-page' });
  page.contentEditable = 'true';
  page.spellcheck = false;
  page.setAttribute('role', 'textbox');
  page.setAttribute('aria-multiline', 'true');
  // Header/Footer overlay: per-page running head/foot boxes drawn ABOVE the body
  // (which is transparent), sitting in the page margins. Normally inert display
  // clones; double-clicking one enters an editing session on that box. A hidden
  // measurement layer holds one box per kind so their heights are known even
  // before the visible boxes exist (pagination needs the heights up-front).
  const hfLayer = el('div', { class: 'doc-hf-layer', 'aria-hidden': 'true' });
  const hfMeasure = el('div', { class: 'doc-hf-measure', 'aria-hidden': 'true' });
  stack.appendChild(sheets);
  stack.appendChild(guides);
  stack.appendChild(vruler);
  stack.appendChild(page);
  stack.appendChild(hfLayer);
  stack.appendChild(hfMeasure);
  scroll.appendChild(stack);
  container.appendChild(scroll);

  // Floating table toolbar: appears above the table the caret is in, so rows and
  // columns can be added/removed inline (like Google Docs), not just via menus.
  const tableTools = el('div', { class: 'doc-tabletools', 'aria-label': 'Table tools' });
  tableTools.hidden = true;
  const mkTool = (label, tip, fn) => el('button', {
    type: 'button', class: 'doc-tabletools__btn', 'data-tip': tip, 'aria-label': tip,
    onMousedown: (e) => e.preventDefault(), // keep the caret inside the table cell
    onClick: (e) => { e.stopPropagation(); fn(); },
  }, label);
  // "Lines" toggle: enter a mode where clicking a grid line removes/restores it.
  const linesBtn = mkTool('▦ Lines', 'Edit grid lines: click a line to remove it (cells merge, text flows) · click where a line was to restore it (cells split back)', () =>
    linesBtn.classList.toggle('is-active', setBorderEdit(!borderEdit))
  );
  tableTools.append(
    mkTool('＋Row ↑', 'Insert row above', () => insertTableRow('above')),
    mkTool('＋Row ↓', 'Insert row below', () => insertTableRow('below')),
    el('span', { class: 'doc-tabletools__sep' }),
    mkTool('＋Col ←', 'Insert column left', () => insertTableColumn('left')),
    mkTool('＋Col →', 'Insert column right', () => insertTableColumn('right')),
    el('span', { class: 'doc-tabletools__sep' }),
    mkTool('－Row', 'Delete row', () => deleteTableRow()),
    mkTool('－Col', 'Delete column', () => deleteTableColumn()),
    el('span', { class: 'doc-tabletools__sep' }),
    linesBtn,
    mkTool('🗑', 'Delete table', () => deleteTable()),
  );
  container.appendChild(tableTools);

  // A thin highlight that snaps to the grid line under the cursor in Lines mode,
  // so you can see exactly which line you'll add or remove — even an erased one.
  const edgeHi = el('div', { class: 'doc-edgehi' });
  edgeHi.hidden = true;
  container.appendChild(edgeHi);
  function showLineHighlight(hit) {
    if (!hit) { edgeHi.hidden = true; return; }
    const box = hit.segRect;
    edgeHi.style.left = `${box.left}px`;
    edgeHi.style.top = `${box.top}px`;
    edgeHi.style.width = `${box.width}px`;
    edgeHi.style.height = `${box.height}px`;
    // A "restore/split" line reads differently from a "remove/merge" one.
    edgeHi.classList.toggle('is-split', hit.action === 'split');
    edgeHi.hidden = false;
  }

  /** Show the table toolbar above the caret's table, or hide it. */
  function updateTableTools() {
    const table = tableAtSelection();
    if (!table || page.classList.contains('is-readonly')) {
      tableTools.hidden = true;
      if (borderEdit) { setBorderEdit(false); linesBtn.classList.remove('is-active'); }
      return;
    }
    const rect = table.getBoundingClientRect();
    tableTools.hidden = false;
    const h = tableTools.offsetHeight || 34;
    // Sit just above the table; if that would collide with the toolbars, drop it
    // just inside the table's top instead.
    let top = rect.top - h - 6;
    if (top < 96) top = rect.top + 6;
    tableTools.style.top = `${Math.round(top)}px`;
    tableTools.style.left = `${Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - tableTools.offsetWidth - 8)))}px`;
  }
  const PAGE_GAP = 28; // vertical gap between page sheets (px)
  try {
    document.execCommand('defaultParagraphSeparator', false, 'p');
  } catch {
    /* non-fatal: some engines ignore this */
  }

  let base = null; // Document (page/meta/title); blocks come from the live DOM
  let lastHtml = '';
  const undoStack = [];
  const redoStack = [];
  let inputTimer = 0;
  let selTimer = 0;
  let composing = false; // an IME composition is in progress (pauses the splitter)
  let endEditing = null; // keyboard editing-session closer (suspends workspace keys)
  let imgSel = null; // currently selected image <figure> (shows resize handles)
  let lastCaretBlock = null; // last top-level block the caret sat in (for inserts)
  let savedRange = null; // last caret Range inside editRoot (for insert-at-cursor)

  // The element that currently owns text editing/formatting: the body `page`, or
  // (while editing a running head/foot) the active header/footer box. Block-level
  // ops and selection reads route through this so formatting works in both.
  let editRoot = page;
  // Live references to base.header / base.footer (created on load). `hfEditing`
  // holds { part:'header'|'footer', pageIndex, kind, box } while a box is open.
  let hf = null;
  let hfEditing = null;
  let lastSnap = null; // last committed { body, hf } snapshot (drives undo/redo)
  let measBoxes = {}; // `${part}:${kind}` → hidden box whose height feeds pagination
  const HF_GAP = 8; // px breathing room between a running head/foot and the body

  /* -------------------------------- load -------------------------------- */
  function load(doc) {
    base = cloneDocument(doc);
    imgSel = null; // any prior selection belongs to the old document
    boxSel = null; closeBoxMenu(); // drop any positioned-box selection from a prior doc
    lastCaretBlock = null;
    savedRange = null;
    hfEditing = null;
    editRoot = page;
    // Normalise header/footer (older/imported models may lack them) and keep live
    // references so edits write straight into `base` and round-trip through save.
    base.header = normalizeHf(base.header);
    base.footer = normalizeHf(base.footer);
    hf = { header: base.header, footer: base.footer };
    buildHfMeasure();
    // Positioned (exact-layout) documents: the container is inert and each box is
    // editable on its own, so set that up before the boxes are placed. Reset the
    // sheet-rebuild guard so a NEWLY transferred PDF always repaints its OWN page
    // rasters (two different PDFs can share page count/size but not backgrounds).
    positionedSig = null;
    page.classList.toggle('is-positioned', base.layout === 'positioned');
    if (base.layout === 'positioned') page.contentEditable = 'false';
    // Insert the real content FIRST, then apply geometry + paginate over it.
    // (Paginating before the blocks exist would measure an empty page and leave
    // the flow un-broken, so large documents spilled past the sheets.)
    page.replaceChildren(...renderBlocks(doc));
    applyPageStyle(base.page);
    lastHtml = page.innerHTML;
    lastSnap = snapshot();
    undoStack.length = 0;
    redoStack.length = 0;
    notify();
    // Web fonts and images change block heights only after they load; re-flow
    // once they settle so nothing ends up past its page.
    repaginateWhenSettled();
  }

  /** Fill in any missing header/footer fields (keeps older models valid). */
  function normalizeHf(cfg) {
    const base0 = createHeaderFooter();
    if (!cfg || typeof cfg !== 'object') return base0;
    return {
      distance: Number.isFinite(cfg.distance) ? cfg.distance : base0.distance,
      differentFirst: !!cfg.differentFirst,
      differentOddEven: !!cfg.differentOddEven,
      default: Array.isArray(cfg.default) ? cfg.default : [],
      first: Array.isArray(cfg.first) ? cfg.first : [],
      even: Array.isArray(cfg.even) ? cfg.even : [],
    };
  }

  /** Re-paginate after async layout inputs (web fonts, images) finish, since they
   *  change block heights after the first synchronous measure. */
  function repaginateWhenSettled() {
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(schedulePaginate).catch(() => {});
    }
    for (const img of page.querySelectorAll('img')) {
      if (img.complete) continue;
      img.addEventListener('load', schedulePaginate, { once: true });
      img.addEventListener('error', schedulePaginate, { once: true });
    }
  }

  /** Push the model's page geometry (size, per-side margins) onto the editable
   *  surface. The page colour is painted on the sheets behind it, not here, so
   *  the inter-page gaps stay the workspace background. Then re-paginate. */
  function applyPageStyle(p) {
    const m = p.margins || { top: p.margin, right: p.margin, bottom: p.margin, left: p.margin };
    page.style.width = `${p.width}px`;
    page.style.paddingTop = `${m.top}px`;
    page.style.paddingRight = `${m.right}px`;
    page.style.paddingBottom = `${m.bottom}px`;
    page.style.paddingLeft = `${m.left}px`;
    page.style.background = 'transparent';
    stack.style.width = `${p.width}px`;
    buildHfMeasure(); // header/footer content width tracks the page margins
    paginate();
  }

  /* ------------------------------ pagination ---------------------------- */
  // Flow the (single) editable column across fixed-height page sheets. For each
  // top-level block that would spill past the current page's content area, we
  // insert a non-editable spacer that bumps it to the top of the next page —
  // so pressing Enter at the bottom of a page starts a NEW page, rather than the
  // one sheet just growing taller. Spacers are excluded from the model (see
  // readBlocks) so they never reach save/export.
  let paginateTimer = 0;
  function schedulePaginate() {
    clearTimeout(paginateTimer);
    paginateTimer = setTimeout(() => requestAnimationFrame(paginate), 60);
  }
  function paginate() {
    if (!base) return;
    // Positioned (exact-layout) documents don't flow: each element keeps its PDF
    // coordinates on fixed sheets. Lay them out directly and skip the flow engine.
    if (base.layout === 'positioned') { layoutPositioned(); return; }
    // Hold off flow reflow (which normalises/splits text nodes) while an IME
    // composition is active — it would abort the composition. Re-runs on end.
    if (composing) return;
    const p = base.page;
    const PAGE_H = p.height;
    const PAGE_W = p.width;
    const m = p.margins || { top: p.margin, right: p.margin, bottom: p.margin, left: p.margin };
    const stride = PAGE_H + PAGE_GAP;
    const usable = PAGE_H - m.top - m.bottom; // content height available per page
    const ctx = { stride, m, PAGE_H, usable };

    // Remember the caret before any DOM surgery (paragraph splitting / normalise),
    // which would otherwise move it. Only used when line surgery actually happens.
    const savedCaret = composing ? null : saveCaret();

    // Clear previous breaks (block spacers + in-table row/header artifacts) before
    // measuring the natural flow, so measurements reflect real content only.
    const removedLineSpacers = clearPaginationArtifacts();

    // Push the first page's body down by its header reserve so a tall running head
    // never overlaps the opening block (pages 2+ get this via their break spacers).
    const lead0 = headerReserve(0);
    if (lead0 > 0 && page.firstChild) page.insertBefore(makeBlockSpacer(lead0), page.firstChild);

    let pageIndex = 0;
    // Floating (absolutely positioned) images are out of the text flow — they
    // don't push page breaks and mustn't be measured as flow blocks.
    const blocks = Array.from(page.children).filter((c) =>
      !c.classList.contains('doc-pagebreak') && !c.classList.contains('is-floating'));
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[i];
      // Forced page break before this block (imported PDF/Word page boundary):
      // unless it already starts the current page, push it to the next page top
      // by advancing the page and bridging the gap with a spacer. Done before the
      // page maths below so the block is measured against its NEW page.
      if (b.classList.contains('doc-break-before')) {
        const here = pageIndex * stride + m.top + headerReserve(pageIndex);
        if (b.offsetTop > here + 1) {
          pageIndex += 1;
          const nextTop = pageIndex * stride + m.top + headerReserve(pageIndex);
          b.before(makeBlockSpacer(Math.max(0, nextTop - b.offsetTop)));
        }
      }
      // The usable band shrinks by the running head/foot reserved on THIS page
      // (which can differ per page under Different first / odd & even), so body
      // content can never overlap a header or footer.
      const contentTop = pageIndex * stride + m.top + headerReserve(pageIndex);
      const contentBottom = pageIndex * stride + PAGE_H - m.bottom - footerReserve(pageIndex);

      // Tables paginate at the ROW level: a whole row is the atomic unit, never
      // split across a page boundary, with the header repeated on continuation.
      if (b.tagName === 'TABLE') {
        pageIndex = paginateTable(b, pageIndex, ctx);
        continue;
      }

      const top = b.offsetTop;
      let bottom = top + b.offsetHeight;

      // Fit test uses the block's own bottom, EXCEPT an image with an immediately
      // following caption/metadata paragraph: keep the pair together when the pair
      // fits within a single page (otherwise fall back to per-block flow).
      let fitBottom = bottom;
      if (b.classList.contains('doc-image')) {
        const cap = blocks[i + 1];
        if (cap && cap.tagName === 'P' && !cap.classList.contains('doc-image')) {
          const capBottom = cap.offsetTop + cap.offsetHeight;
          if (capBottom - top <= usable) fitBottom = capBottom;
        }
      }

      // A flowing text block (paragraph/heading) that overflows the page:
      //   • if it fits wholly on a fresh page, push the WHOLE block down (no mid-
      //     paragraph break — cleaner, and keeps a short paragraph together);
      //   • otherwise it is taller than a page (or already starts at the page top),
      //     so SPLIT it at the line boundary — it fills this page and continues on
      //     the next, instead of spilling past the bottom margin into the gap.
      const isText = /^(P|H1|H2|H3)$/.test(b.tagName);
      if (fitBottom > contentBottom && isText && !composing) {
        if (b.offsetHeight <= usable && top > contentTop + 1) {
          pageIndex += 1;
          const nextTop = pageIndex * stride + m.top + headerReserve(pageIndex);
          b.before(makeBlockSpacer(Math.max(0, nextTop - top)));
        }
        pageIndex = splitFlowBlock(b, pageIndex, ctx);
        continue;
      }

      // Overflows this page and isn't already the page's first block → push the
      // WHOLE block (image atomically; the grouped caption flows after it) down.
      if (fitBottom > contentBottom && top > contentTop + 1) {
        pageIndex += 1;
        const nextTop = pageIndex * stride + m.top + headerReserve(pageIndex);
        b.before(makeBlockSpacer(Math.max(0, nextTop - top)));
        bottom = b.offsetTop + b.offsetHeight; // reflects the inserted spacer
      }
      // Advance to the page the block's BOTTOM lands on. A block taller than the
      // remaining space (e.g. a large image now at a page top) spans onto later
      // pages; without this the next block's page math would be stale → clipping.
      pageIndex = Math.max(pageIndex, Math.floor((bottom - 1) / stride));
    }

    // Put the caret back if paragraph splitting (or clearing last pass's splits)
    // moved it. Skipped when no line surgery happened, so ordinary typing in a
    // short document never has its native selection touched.
    if (savedCaret && (removedLineSpacers || page.querySelector('.doc-linebreak'))) restoreCaret(savedCaret);

    // Guarantee the sheets extend under ALL content — even a single block taller
    // than the content area, or content that spilled into a page gap. We add
    // sheets to hold the content (extending the page surface), never clip it.
    let maxBottom = 0;
    for (const b of blocks) maxBottom = Math.max(maxBottom, b.offsetTop + b.offsetHeight);
    let lastByContent = Math.floor(maxBottom / stride);
    if (maxBottom - lastByContent * stride > PAGE_H) lastByContent += 1; // spilled into the gap
    const count = Math.max(pageIndex + 1, lastByContent + 1);
    const total = count * PAGE_H + (count - 1) * PAGE_GAP;
    renderSheets(count, PAGE_W, PAGE_H, p.background || '#fff');
    renderGuides(count, PAGE_W, PAGE_H, m);
    renderVRuler(count, total, m);
    page.style.minHeight = `${total}px`;
    stack.style.height = `${total}px`;
    // Publish the real page count so the shell (status bar, navigation) stays in
    // sync with the actual laid-out pages instead of a stale "1 / 1".
    pageCount = count;
    renderHfBoxes(count); // draw/refresh the running head/foot on every page
    reportPagination(true);
    if (docDebugOn()) logPaginationDebug({ blocks, PAGE_W, PAGE_H, m, usable, count });
  }

  /** One-shot diagnostic dump comparing the source's page geometry to what the editor
   *  actually laid out — the numbers that explain a page-count mismatch. */
  function logPaginationDebug({ blocks, PAGE_W, PAGE_H, m, usable, count }) {
    try {
      console.log('[doc-paginate] page (px):', { width: PAGE_W, height: PAGE_H },
        'margins:', m, 'usable height:', usable, '→ pages:', count);
      const overrides = blocks.filter((b) => b.dataset && b.dataset.pageOverride);
      if (overrides.length) {
        console.log(`[doc-paginate] ${overrides.length} section page-override(s) present (opened at section 1's size; per-section rendering is a follow-up):`,
          overrides.map((b) => { try { return JSON.parse(b.dataset.pageOverride); } catch { return b.dataset.pageOverride; } }));
      }
      let logged = 0;
      for (const b of blocks) {
        if (b.tagName === 'FIGURE' && b.classList.contains('doc-image')) {
          const img = b.querySelector('img');
          const r = img && img.getBoundingClientRect();
          console.log('[doc-paginate] image rendered (px):', img ? { width: Math.round(r.width / (zoom || 1)), height: Math.round(r.height / (zoom || 1)) } : '(none)');
          continue;
        }
        if (logged >= 12 || !/^(P|H1|H2|H3|LI)$/.test(b.tagName)) continue;
        logged += 1;
        const cs = getComputedStyle(b);
        const span = b.querySelector('span');
        const scs = span && getComputedStyle(span);
        console.log(`[doc-paginate] ${b.tagName} font-size:`, scs ? scs.fontSize : cs.fontSize,
          'line-height:', cs.lineHeight, 'marginTop/Bottom:', cs.marginTop, cs.marginBottom,
          'height(px):', b.offsetHeight);
      }
    } catch { /* diagnostics must never break layout */ }
  }

  /**
   * Exact-layout pass for positioned documents (see positionedImport.js). No flow:
   * the sheet count is the source page count, each sheet shows the PDF page raster
   * as its background (all non-text graphics pixel-exact), and every `.doc-posbox`
   * is placed at `page * stride + y` so it lands on its own sheet at the PDF's own
   * coordinates. Nothing is measured, reflowed, resized or vertically centred — the
   * one scale factor between PDF, model and screen is the viewport zoom alone.
   */
  let positionedSig = null; // guards the (expensive) raster sheet rebuild
  function layoutPositioned() {
    const p = base.page;
    const PAGE_H = p.height, PAGE_W = p.width;
    const stride = PAGE_H + PAGE_GAP;
    const bgs = Array.isArray(base.pages) ? base.pages.map((pg) => pg && pg.bg) : [];
    const count = Math.max(1, bgs.length || 1);
    for (const box of page.querySelectorAll(':scope > .doc-posbox')) {
      const pg = parseInt(box.dataset.page || '0', 10) || 0;
      const y = parseFloat(box.dataset.y || '0') || 0;
      box.style.top = `${pg * stride + y}px`;
    }
    const total = count * PAGE_H + (count - 1) * PAGE_GAP;
    // Positions are fixed, so only rebuild the page-raster sheets (and vruler) when
    // the geometry actually changes — never on every keystroke, which would reload
    // the backgrounds and flicker the page while typing.
    const sig = `${count}x${PAGE_W}x${PAGE_H}`;
    if (sig !== positionedSig) {
      renderSheets(count, PAGE_W, PAGE_H, p.background || '#fff', bgs);
      renderVRuler(count, total, p.margins || { top: 0, right: 0, bottom: 0, left: 0 });
      positionedSig = sig;
    }
    page.style.minHeight = `${total}px`;
    stack.style.height = `${total}px`;
    pageCount = count;
    reportPagination(true);
  }

  /* ---- page count / current-page tracking (drives the status bar) ---- */
  let pageCount = 1;
  let lastReportedPage = 0;
  /** The page (1-based) occupying the top of the viewport — what the reader is
   *  looking at. Measured from live bounding rects (which are already in screen
   *  pixels, i.e. post-`zoom`), so the maths hold at any zoom level and regardless
   *  of which ancestor actually scrolls. `container` is the scroll viewport. */
  function currentPageFromScroll() {
    const p = base?.page;
    if (!p) return 1;
    const strideScreen = (p.height + PAGE_GAP) * zoom;
    if (strideScreen <= 0) return 1;
    const contRect = container.getBoundingClientRect();
    const stackRect = stack.getBoundingClientRect();
    // Reference line a little below the viewport top → the page you're reading.
    const into = (contRect.top + contRect.height * 0.34) - stackRect.top;
    return Math.min(pageCount, Math.max(1, Math.floor(into / strideScreen) + 1));
  }
  function reportPagination(force) {
    const current = currentPageFromScroll();
    if (!force && current === lastReportedPage) return;
    lastReportedPage = current;
    onPaginate?.({ pageCount, currentPage: current });
  }
  /** Scroll a given 1-based page to the top of the viewport (for navigation). */
  function goToPage(n) {
    const p = base?.page;
    if (!p) return;
    const strideScreen = (p.height + PAGE_GAP) * zoom;
    const target = Math.max(0, Math.min(pageCount - 1, (Number(n) || 1) - 1));
    const contRect = container.getBoundingClientRect();
    const stackRect = stack.getBoundingClientRect();
    const delta = (stackRect.top + target * strideScreen) - contRect.top - 8;
    container.scrollBy({ top: delta, behavior: 'smooth' });
  }
  const getPageCount = () => pageCount;
  const getCurrentPage = () => currentPageFromScroll();

  /** Remove every pagination artifact (block spacers between top-level blocks, and
   *  the spacer/repeated-header rows injected into tables) so the next measure sees
   *  only real content. Artifacts are also ignored on read (see readBlocks), so a
   *  stray one never reaches the model or export. */
  function clearPaginationArtifacts() {
    page.querySelectorAll(':scope > .doc-pagebreak').forEach((s) => s.remove());
    page.querySelectorAll('tr.doc-pagebreak-row, tr.doc-pagebreak-header').forEach((r) => r.remove());
    // In-paragraph line spacers (the mid-block page-break bridges) live INSIDE a
    // block, so `:scope >` above misses them. Remove each and rejoin the text nodes
    // it split so the next measure sees the paragraph's natural, unbroken flow.
    const lineSpacers = page.querySelectorAll('.doc-linebreak');
    lineSpacers.forEach((s) => { const par = s.parentElement; s.remove(); if (par) par.normalize(); });
    return lineSpacers.length > 0;
  }

  /** A block-level, non-editable bridge inserted INSIDE a paragraph at a line
   *  boundary, so the text after it starts at the top of the next page — i.e. a
   *  single long paragraph splits across pages instead of overflowing the bottom
   *  margin. Stripped on read (no text) and on the next paginate (see above). */
  function makeLineSpacer(h) {
    const s = document.createElement('span');
    s.className = 'doc-pagebreak doc-linebreak';
    s.contentEditable = 'false';
    s.setAttribute('aria-hidden', 'true');
    s.style.display = 'block';
    s.style.width = '100%';
    s.style.height = `${h}px`;
    return s;
  }

  /* ---- caret preservation across pagination surgery (splits/normalise) ---- */
  // Splitting text nodes and normalising them would move the native caret, so we
  // remember it as a character offset within its top-level text block (spacers add
  // no text, so the offset stays valid) and put it back afterwards.
  function charOffsetWithin(root, node, offset) {
    // Count characters from the block start to the caret via a Range — correct for
    // both text-node and element-container carets, and unaffected by empty spacers.
    const r = document.createRange();
    r.setStart(root, 0);
    try { r.setEnd(node, offset); } catch { return 0; }
    return r.toString().length;
  }
  function locateChar(root, off) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let t, seen = 0;
    while ((t = walker.nextNode())) {
      const len = (t.nodeValue || '').length;
      if (seen + len >= off) return { node: t, offset: Math.max(0, off - seen) };
      seen += len;
    }
    return t ? { node: t, offset: (t.nodeValue || '').length } : null;
  }
  function saveCaret() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!r.collapsed || !page.contains(r.startContainer)) return null; // don't disturb a real selection
    let blk = r.startContainer.nodeType === Node.TEXT_NODE ? r.startContainer.parentNode : r.startContainer;
    while (blk && blk.parentNode !== page) blk = blk.parentNode;
    if (!blk || !/^(P|H1|H2|H3)$/.test(blk.tagName)) return null; // only blocks we may split
    return { blk, off: charOffsetWithin(blk, r.startContainer, r.startOffset) };
  }
  function restoreCaret(saved) {
    if (!saved || !page.contains(saved.blk)) return;
    const loc = locateChar(saved.blk, saved.off);
    if (!loc) return;
    try {
      const sel = window.getSelection();
      const r = document.createRange();
      r.setStart(loc.node, loc.offset); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
    } catch { /* selection can throw if the node vanished — ignore */ }
  }

  /**
   * Split one flowing text block (paragraph/heading) across page boundaries by
   * inserting line spacers at the wrap points that cross each page's content
   * bottom. A paragraph taller than a page (or one that starts low and overflows)
   * then fills the current page and continues at the top of the next — instead of
   * spilling past the bottom margin into the inter-page gap. Returns the page index
   * the block ends on. Best-effort: if a break point can't be located it stops and
   * lets the remainder flow (never throws, never loops forever).
   */
  function splitFlowBlock(b, pageIndex, { stride, m, PAGE_H }) {
    const z = zoom || 1;
    for (let guard = 0; guard < 80; guard += 1) {
      const contentBottom = pageIndex * stride + PAGE_H - m.bottom - footerReserve(pageIndex);
      if (b.offsetTop + b.offsetHeight <= contentBottom + 1) break; // fits now
      const bRect = b.getBoundingClientRect();
      const bTop = b.offsetTop;
      // Layout Y (zoom-safe) of the bottom of the text from the block's start up to
      // global character index `g`. Uses getBoundingClientRect, which — unlike
      // caretRangeFromPoint — resolves for content scrolled OUT of the viewport too.
      const pos = textIndex(b);
      if (!pos.total) break;
      const bottomAt = (g) => {
        const loc = locateInIndex(pos, g);
        if (!loc) return -Infinity;
        const r = document.createRange();
        r.setStart(pos.nodes[0].node, 0);
        r.setEnd(loc.node, loc.offset);
        let maxB = -Infinity;
        for (const rc of r.getClientRects()) if (rc.height > 0.5) maxB = Math.max(maxB, rc.bottom);
        return maxB === -Infinity ? bTop : bTop + (maxB - bRect.top) / z;
      };
      if (bottomAt(pos.total) <= contentBottom + 1) break; // (shouldn't happen) fits
      // Largest character count whose text still fits above this page's bottom.
      let lo = 1, hi = pos.total, gFit = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (bottomAt(mid) <= contentBottom) { gFit = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (gFit <= 0) break; // not even one line fits (line taller than page) — leave it
      const g = snapToWord(pos, gFit);            // break on a word boundary
      const lastFitBottom = bottomAt(g);
      const nextTop = (pageIndex + 1) * stride + m.top + headerReserve(pageIndex + 1);
      const spacerH = Math.round(nextTop - lastFitBottom);
      if (spacerH <= 0) break;
      const at = locateInIndex(pos, g);
      if (!at) break;
      insertNodeAt(at.node, at.offset, makeLineSpacer(spacerH));
      pageIndex += 1;
    }
    const bottom = b.offsetTop + b.offsetHeight;
    return Math.max(pageIndex, Math.floor((bottom - 1) / stride));
  }

  /** Ordered text nodes of a block with cumulative offsets, for O(log n) mapping
   *  between a global character index and a (node, offset) DOM position. */
  function textIndex(b) {
    const nodes = []; let total = 0;
    const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = w.nextNode())) { const len = t.nodeValue.length; nodes.push({ node: t, start: total, len }); total += len; }
    return { nodes, total };
  }
  function locateInIndex(idx, g) {
    for (const e of idx.nodes) if (g <= e.start + e.len) return { node: e.node, offset: g - e.start };
    const last = idx.nodes[idx.nodes.length - 1];
    return last ? { node: last.node, offset: last.len } : null;
  }
  /** Move a break index back to just after the previous space, so a paragraph
   *  never splits in the middle of a word (falls back to `g` if none is near). */
  function snapToWord(idx, g) {
    const text = idx.nodes.map((n) => n.node.nodeValue).join('');
    for (let k = Math.min(g, text.length); k > g - 40 && k > 0; k -= 1) {
      if (/\s/.test(text[k - 1])) return k;
    }
    return g;
  }

  /** Insert `node` at a (container, offset) position, splitting a text node when
   *  the position falls inside one. */
  function insertNodeAt(container, offset, node) {
    if (container.nodeType === Node.TEXT_NODE) {
      const after = offset >= container.length ? container.nextSibling : container.splitText(offset);
      container.parentNode.insertBefore(node, after);
    } else {
      container.insertBefore(node, container.childNodes[offset] || null);
    }
  }

  /** A non-editable block-level spacer that bridges the gap a block is pushed
   *  across to begin the next page. */
  function makeBlockSpacer(h) {
    const spacer = document.createElement('div');
    spacer.className = 'doc-pagebreak';
    spacer.contentEditable = 'false';
    spacer.style.height = `${h}px`;
    return spacer;
  }

  /** How many columns a table spans (colgroup wins; else sum the first row's
   *  cell colSpans). Used to size the full-width spacer rows. */
  function tableColCount(table) {
    const cg = table.querySelector(':scope > colgroup');
    if (cg && cg.children.length) return cg.children.length;
    const first = table.rows[0];
    if (!first) return 1;
    let n = 0;
    for (const c of first.cells) n += c.colSpan || 1;
    return n;
  }

  /** A full-width, border-/padding-free spacer row of height `h`. It bridges the
   *  page gap INSIDE a table so the next real row starts on a fresh page — the
   *  table stays a single element, preserving colgroup widths, borders and the
   *  cell model. Marked so it is stripped from measurement and never read back. */
  function makeSpacerRow(colCount, h) {
    const tr = document.createElement('tr');
    tr.className = 'doc-pagebreak-row';
    tr.contentEditable = 'false';
    tr.setAttribute('aria-hidden', 'true');
    tr.style.height = `${h}px`;
    const td = document.createElement('td');
    td.colSpan = colCount;
    td.style.border = 'none';
    td.style.padding = '0';
    td.style.background = 'transparent';
    const filler = document.createElement('div');
    filler.style.height = `${h}px`; // a real box so the row can't collapse below h
    td.appendChild(filler);
    tr.appendChild(td);
    return tr;
  }

  /**
   * Row-level pagination for one table. Each `<tr>` is treated as an atomic unit:
   * its *actual rendered height* (its live offsetHeight, so it includes wrapping,
   * padding, borders and font metrics) is compared against the space left on the
   * current page. A row that would cross the boundary is pushed
   * wholesale to the next page via an in-table spacer row, and the table's first
   * row (the header) is cloned at the top of the continuation. Column widths,
   * borders, cell spans and vertical alignment are preserved because it all stays
   * one `<table>`. Returns the page index the table's last row ends on.
   */
  function paginateTable(table, pageIndex, { stride, m, PAGE_H }) {
    const bodyRows = Array.from(table.rows).filter((r) =>
      !r.classList.contains('doc-pagebreak-row') && !r.classList.contains('doc-pagebreak-header'));
    if (!bodyRows.length) {
      const bottom = table.offsetTop + table.offsetHeight;
      return Math.max(pageIndex, Math.floor((bottom - 1) / stride));
    }
    const headerRow = bodyRows[0];
    const colCount = tableColCount(table);
    // Measure in the page's offset space (like the block loop) so the math holds
    // under CSS `zoom`: a row's offsetTop is relative to its <table>, so add the
    // table's own offsetTop within the page. offsetHeight is the rendered row box
    // (text wrapping + padding + borders + font metrics).
    const topOf = (elm) => table.offsetTop + elm.offsetTop;
    const botOf = (elm) => table.offsetTop + elm.offsetTop + elm.offsetHeight;

    for (let i = 0; i < bodyRows.length; i += 1) {
      const row = bodyRows[i];
      const contentTop = pageIndex * stride + m.top + headerReserve(pageIndex);
      const contentBottom = pageIndex * stride + PAGE_H - m.bottom - footerReserve(pageIndex);
      const top = topOf(row);
      const bottom = botOf(row);
      // Row overflows this page and isn't already the page's first row → move the
      // WHOLE row to the next page. (A row taller than a full page can't fit
      // anywhere; it still starts at a page top and spans onward — never clipped.)
      if (bottom > contentBottom && top > contentTop + 1) {
        pageIndex += 1;
        const nextTop = pageIndex * stride + m.top + headerReserve(pageIndex);
        // Spacer bridges the gap; the header clone (below it) then sits at the top
        // of the new page, and the real row follows the repeated header.
        row.before(makeSpacerRow(colCount, Math.max(0, nextTop - top)));
        if (i > 0) {
          const clone = headerRow.cloneNode(true);
          clone.classList.remove('doc-pagebreak-row');
          clone.classList.add('doc-pagebreak-header');
          clone.contentEditable = 'false';
          clone.setAttribute('aria-hidden', 'true');
          row.before(clone);
        }
      }
      // Advance to the page the row's bottom now lands on (handles very tall rows).
      pageIndex = Math.max(pageIndex, Math.floor((botOf(row) - 1) / stride));
    }
    return pageIndex;
  }

  /** Vertical ruler down the left of the page — a per-page cm scale (0 at each
   *  page's top margin, mirrored into the margins) with the top/bottom margins
   *  and inter-page gaps shaded, matching the horizontal ruler. */
  function renderVRuler(pageCount, total, m) {
    const p = base.page;
    const PAGE_H = p.height;
    const CM = 96 / 2.54;
    const stride = PAGE_H + PAGE_GAP;
    vruler.style.height = `${total}px`;
    const frag = document.createDocumentFragment();
    const band = (top, h) => { const b = document.createElement('div'); b.className = 'doc-vruler__pad'; b.style.top = `${top}px`; b.style.height = `${h}px`; frag.appendChild(b); };
    for (let i = 0; i < pageCount; i += 1) {
      const top = i * stride;
      band(top, m.top);
      band(top + PAGE_H - m.bottom, m.bottom);
      if (i < pageCount - 1) band(top + PAGE_H, PAGE_GAP);
      const origin = top + m.top;
      const quarter = CM / 4;
      for (let k = Math.ceil((top - origin) / quarter); ; k += 1) {
        const y = origin + k * quarter;
        if (y > top + PAGE_H + 0.5) break;
        if (y < top - 0.5) continue;
        const isCm = k % 4 === 0;
        const isHalf = k % 2 === 0;
        const t = document.createElement('div');
        t.className = isCm ? 'doc-vruler__tick doc-vruler__tick--major' : isHalf ? 'doc-vruler__tick doc-vruler__tick--half' : 'doc-vruler__tick';
        t.style.top = `${y}px`;
        frag.appendChild(t);
        if (isCm && k / 4 !== 0) {
          const n = document.createElement('span');
          n.className = 'doc-vruler__num';
          n.style.top = `${y}px`;
          n.textContent = String(Math.abs(k / 4));
          frag.appendChild(n);
        }
      }
    }
    vruler.replaceChildren(frag);
  }
  function renderSheets(count, w, h, bg, backgrounds) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i += 1) {
      const sheet = document.createElement('div');
      sheet.className = 'doc-sheet';
      sheet.style.top = `${i * (h + PAGE_GAP)}px`;
      sheet.style.width = `${w}px`;
      sheet.style.height = `${h}px`;
      sheet.style.background = bg;
      // Positioned (exact-layout) pages paint the PDF page raster as the sheet
      // background so every non-text graphic (borders, shading, lines, images)
      // stays pixel-exact under the editable text boxes. Stretched to the sheet =
      // the page's own px size, so it's a 1:1 reproduction (no crop, no distortion).
      const src = backgrounds && backgrounds[i];
      if (src) {
        sheet.style.backgroundImage = `url("${src}")`;
        sheet.style.backgroundSize = '100% 100%';
        sheet.style.backgroundRepeat = 'no-repeat';
      }
      frag.appendChild(sheet);
    }
    sheets.style.width = `${w}px`;
    sheets.replaceChildren(frag);
  }

  // View-only preference (not part of the model): draw the printable-area outline.
  let showMargins = false;
  /** Per-page dashed rectangle sitting exactly on the content box (page minus its
   *  margins), so the user can see where text/images should stay. Inert overlay. */
  function renderGuides(count, w, h, m) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i += 1) {
      const box = document.createElement('div');
      box.className = 'doc-guide';
      box.style.top = `${i * (h + PAGE_GAP) + m.top}px`;
      box.style.left = `${m.left}px`;
      box.style.width = `${Math.max(0, w - m.left - m.right)}px`;
      box.style.height = `${Math.max(0, h - m.top - m.bottom)}px`;
      frag.appendChild(box);
    }
    guides.style.width = `${w}px`;
    guides.replaceChildren(frag);
  }
  function setShowMargins(on) {
    showMargins = !!on;
    stack.classList.toggle('doc-pagestack--guides', showMargins);
  }
  const getShowMargins = () => showMargins;

  /** Current page setup (for pre-filling the Page setup dialog). */
  function getPageSetup() {
    const p = base?.page || { width: 816, height: 1056, margin: 72 };
    const m = p.margins || { top: p.margin, right: p.margin, bottom: p.margin, left: p.margin };
    return { width: p.width, height: p.height, margins: { ...m }, background: p.background || '#fff' };
  }

  /** Apply a new page setup (orientation/size/margins/colour) to the live page
   *  and the model, so it persists through getModel() and export. */
  function setPageSetup({ width, height, margins, background }) {
    if (!base) return;
    const m = margins || (base.page.margins || { top: base.page.margin, right: base.page.margin, bottom: base.page.margin, left: base.page.margin });
    base.page = {
      ...base.page,
      width: Math.round(width),
      height: Math.round(height),
      // Uniform fallback the DOCX/PDF exporters read (they don't do per-side yet).
      margin: Math.round(m.top),
      margins: { top: Math.round(m.top), right: Math.round(m.right), bottom: Math.round(m.bottom), left: Math.round(m.left) },
      background: background || '#fff',
    };
    applyPageStyle(base.page);
    notify();
  }

  /** Read the current edited state back into a full Document. */
  function getModel() {
    if (hfEditing) flushHfEditing(); // capture an in-progress header/footer edit
    return { ...(base || {}), blocks: readBlocks(page) };
  }

  /* ========================= headers & footers ========================= */
  // A real running head/foot: ONE logical definition per kind (default / first /
  // even) stored in the model, rendered on every applicable page as an overlay in
  // the page margins. Double-click a margin to edit; edits route through the same
  // formatting engine (via `editRoot`) and update the body layout (the reserved
  // header/footer height shrinks the usable body band — never an overlap).

  function pageMargins() {
    const p = base.page;
    return p.margins || { top: p.margin, right: p.margin, bottom: p.margin, left: p.margin };
  }
  const hfContentWidth = () => base.page.width - pageMargins().left - pageMargins().right;

  /** Which kind (default/first/even) applies to `part` on a given 0-based page. */
  function hfKindFor(part, pageIndex) {
    const cfg = hf[part];
    if (cfg.differentFirst && pageIndex === 0) return 'first';
    if (cfg.differentOddEven && (pageIndex + 1) % 2 === 0) return 'even';
    return 'default';
  }
  const hfBlocks = (part, kind) => (hf[part][kind] && hf[part][kind].length ? hf[part][kind] : []);
  const isEmptyBlocks = (blocks) => !blocks || !blocks.length ||
    (blocks.length === 1 && blocks[0].type === 'paragraph' &&
      !(blocks[0].runs || []).some((r) => (r.text && r.text.trim()) || r.field));

  /** Render header/footer content into `box` from a block list, substituting the
   *  page-number / total fields for this page. */
  function fillHfBox(box, blocks, pageNumber) {
    box.replaceChildren(...renderBlocks({ blocks: blocks.length ? blocks : [] }));
    for (const f of box.querySelectorAll('.doc-field')) {
      f.textContent = f.dataset.field === 'pages' ? String(pageCount) : String(pageNumber);
    }
  }

  /** (Re)build the hidden per-kind measurement boxes so pagination knows each
   *  running head/foot's height BEFORE the visible boxes are laid out. */
  function buildHfMeasure() {
    if (!hf) return;
    hfMeasure.style.width = `${hfContentWidth()}px`;
    measBoxes = {};
    const frag = document.createDocumentFragment();
    for (const part of ['header', 'footer']) {
      for (const kind of ['default', 'first', 'even']) {
        const box = document.createElement('div');
        box.className = 'doc-hf-box doc-hf-box--measure';
        const blocks = hfBlocks(part, kind);
        if (!isEmptyBlocks(blocks)) fillHfBox(box, blocks, 1);
        measBoxes[`${part}:${kind}`] = box;
        frag.appendChild(box);
      }
    }
    hfMeasure.replaceChildren(frag);
  }

  /** Measured content height (px) of a running head/foot kind (0 when empty). */
  function measHeight(part, kind) {
    const blocks = hfBlocks(part, kind);
    if (isEmptyBlocks(blocks)) return 0;
    const box = measBoxes[`${part}:${kind}`];
    return box ? box.offsetHeight : 0;
  }

  /** Extra body offset (beyond the top margin) the header claims on a page. */
  function headerReserve(pageIndex) {
    if (!hf) return 0;
    const h = measHeight('header', hfKindFor('header', pageIndex));
    if (!h) return 0;
    const m = pageMargins();
    const bodyTop = Math.max(m.top, hf.header.distance + h + HF_GAP);
    return bodyTop - m.top;
  }
  /** Extra body offset (beyond the bottom margin) the footer claims on a page. */
  function footerReserve(pageIndex) {
    if (!hf) return 0;
    const h = measHeight('footer', hfKindFor('footer', pageIndex));
    if (!h) return 0;
    const m = pageMargins();
    const PAGE_H = base.page.height;
    const bodyBottom = Math.min(PAGE_H - m.bottom, PAGE_H - hf.footer.distance - h - HF_GAP);
    return (PAGE_H - m.bottom) - bodyBottom;
  }

  /** Position + fill one page's running head/foot box. Reuses the live editing box
   *  (so the caret survives) instead of rebuilding it. */
  function buildHfBox(part, pageIndex, kind, editable) {
    const m = pageMargins();
    const PAGE_H = base.page.height;
    const stride = PAGE_H + PAGE_GAP;
    const box = document.createElement('div');
    box.className = `doc-hf-box doc-hf-box--${part}`;
    box.dataset.part = part;
    box.dataset.page = String(pageIndex);
    box.dataset.kind = kind;
    box.style.left = `${m.left}px`;
    box.style.width = `${hfContentWidth()}px`;
    const blocks = hfBlocks(part, kind);
    if (editable) {
      box.contentEditable = 'true';
      box.classList.add('is-editing');
      box.spellcheck = false;
      const src = isEmptyBlocks(blocks) ? [] : blocks;
      if (src.length) box.replaceChildren(...renderBlocks({ blocks: src }));
      else box.appendChild(emptyPara());
      for (const f of box.querySelectorAll('.doc-field')) {
        f.textContent = f.dataset.field === 'pages' ? String(pageCount) : String(pageIndex + 1);
      }
      box.addEventListener('keydown', handleEditorKeydown);
      box.addEventListener('input', onHfInput);
    } else {
      box.contentEditable = 'false';
      if (isEmptyBlocks(blocks)) { box.classList.add('is-empty'); }
      else fillHfBox(box, blocks, pageIndex + 1);
    }
    positionHfBox(box, part, pageIndex, stride, m, PAGE_H);
    return box;
  }

  /** Place a box vertically: header hangs at `distance` from the page top; footer
   *  sits so its bottom is `distance` from the page bottom. */
  function positionHfBox(box, part, pageIndex, stride, m, PAGE_H) {
    const pageTop = pageIndex * stride;
    if (part === 'header') {
      box.style.top = `${pageTop + hf.header.distance}px`;
    } else {
      const h = box.offsetHeight || measHeight('footer', box.dataset.kind) || 0;
      box.style.top = `${pageTop + PAGE_H - hf.footer.distance - h}px`;
    }
  }

  const emptyPara = () => {
    const p = document.createElement('p');
    p.className = 'doc-block';
    p.appendChild(document.createElement('br'));
    return p;
  };

  /** Rebuild every page's running head/foot. The box being edited is left in place
   *  (never detached) so its caret survives a reflow; only the display clones and
   *  the empty-margin slots are regenerated. */
  function renderHfBoxes(count) {
    if (!hf) return;
    const m = pageMargins();
    const PAGE_H = base.page.height;
    const stride = PAGE_H + PAGE_GAP;
    // Drop the previous clones, but keep the live editing box and the chrome.
    for (const child of Array.from(hfLayer.children)) {
      if (hfEditing && child === hfEditing.box) continue;
      if (child === hfChrome) continue;
      child.remove();
    }
    const clones = [];
    for (let i = 0; i < count; i += 1) {
      for (const part of ['header', 'footer']) {
        if (hfEditing && hfEditing.part === part && hfEditing.pageIndex === i) {
          // Live box stays; just refresh its field numbers + position.
          for (const f of hfEditing.box.querySelectorAll('.doc-field')) {
            f.textContent = f.dataset.field === 'pages' ? String(count) : String(i + 1);
          }
          positionHfBox(hfEditing.box, part, i, stride, m, PAGE_H);
          continue;
        }
        const box = buildHfBox(part, i, hfKindFor(part, i), false);
        clones.push(box);
        hfLayer.appendChild(box);
      }
    }
    // Footer clones need a second position pass now they have a real height.
    for (const box of clones) {
      if (box.dataset.part === 'footer') positionHfBox(box, 'footer', Number(box.dataset.page), stride, m, PAGE_H);
    }
    if (hfChrome) positionHfChrome();
  }

  /* ---- entering / leaving a header or footer edit ---- */
  function enterHf(part, pageIndex) {
    if (!hf || page.classList.contains('is-readonly')) return;
    if (hfEditing) {
      if (hfEditing.part === part && hfEditing.pageIndex === pageIndex) return;
      exitHf();
    }
    deselectImage();
    const kind = hfKindFor(part, pageIndex);
    const box = buildHfBox(part, pageIndex, kind, true);
    hfEditing = { part, pageIndex, kind, box };
    editRoot = box;
    page.contentEditable = 'false';
    stack.classList.add('is-hf-editing');
    hfLayer.appendChild(box); // attach the editable box; clones fill in around it
    renderHfBoxes(pageCount);
    showHfChrome();
    // Caret at the start of the box, and reflect its formatting in the toolbar.
    box.focus();
    const r = document.createRange();
    r.selectNodeContents(box);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.addEventListener('pointerdown', onDocPointerDownHf, true);
    emitSelection();
  }

  /** Read the active box back into the model (without leaving edit mode). */
  function flushHfEditing() {
    if (!hfEditing) return;
    const { part, kind, box } = hfEditing;
    let blocks = readBlocks(box);
    if (isEmptyBlocks(blocks)) blocks = [];
    hf[part][kind] = blocks;
    buildHfMeasure();
  }

  function exitHf(commitEdit = true) {
    if (!hfEditing) return;
    flushHfEditing();
    const wasEditing = hfEditing;
    hfEditing = null;
    editRoot = page;
    page.contentEditable = 'true';
    stack.classList.remove('is-hf-editing');
    hideHfChrome();
    document.removeEventListener('pointerdown', onDocPointerDownHf, true);
    wasEditing.box.removeEventListener('keydown', handleEditorKeydown);
    wasEditing.box.removeEventListener('input', onHfInput);
    wasEditing.box.remove(); // drop the editable box; a fresh display clone replaces it
    renderHfBoxes(pageCount);
    if (commitEdit) commit(); // snapshot (body + hf) so undo covers the edit
    else schedulePaginate();
  }

  let hfInputTimer = 0;
  function onHfInput() {
    clearTimeout(hfInputTimer);
    // Live: reflect the running head/foot on the other pages + reflow the body
    // (its height may have changed), without disturbing the caret in this box.
    flushHfEditing();
    schedulePaginate();
    hfInputTimer = setTimeout(() => { if (hfEditing) commit(); }, 400);
  }

  /** Click in the body (or another margin) leaves header/footer editing. Clicks on
   *  the toolbar/menus/dialogs (outside the editor host) keep the edit alive so
   *  formatting a header selection works just like Google Docs. */
  function onDocPointerDownHf(e) {
    if (!hfEditing) return;
    if (hfEditing.box.contains(e.target)) return;
    if (hfChrome && hfChrome.contains(e.target)) return;
    if (hfOptionsMenu && hfOptionsMenu.contains(e.target)) return;
    if (!container.contains(e.target)) return; // toolbar / menus / dialogs
    exitHf();
  }

  /* ---- the "Header/Footer · Different first page · Options" chrome ---- */
  let hfChrome = null;
  let hfOptionsMenu = null;
  function showHfChrome() {
    hideHfChrome();
    const { part } = hfEditing;
    const cfg = hf[part];
    const label = el('span', { class: 'doc-hf-chrome__label' }, part === 'header' ? 'Header' : 'Footer');
    const diffFirst = el('label', { class: 'doc-hf-chrome__check' }, [
      el('input', {
        type: 'checkbox', checked: cfg.differentFirst,
        onChange: (e) => setHfFlag('differentFirst', e.target.checked),
      }),
      el('span', {}, 'Different first page'),
    ]);
    const options = el('button', {
      class: 'doc-hf-chrome__options', type: 'button',
      onMousedown: (e) => e.preventDefault(),
      onClick: (e) => { e.stopPropagation(); toggleHfOptions(options); },
    }, ['Options', el('span', { class: 'doc-hf-chrome__caret' }, '▾')]);
    hfChrome = el('div', {
      class: `doc-hf-chrome doc-hf-chrome--${part}`,
      onMousedown: (e) => { if (e.target.closest('button, input, label')) return; e.preventDefault(); },
    }, [label, el('div', { class: 'doc-hf-chrome__right' }, [diffFirst, options])]);
    hfLayer.appendChild(hfChrome);
    positionHfChrome();
  }
  function hideHfChrome() {
    closeHfOptions();
    if (hfChrome) { hfChrome.remove(); hfChrome = null; }
  }
  function positionHfChrome() {
    if (!hfChrome || !hfEditing) return;
    const m = pageMargins();
    const PAGE_H = base.page.height;
    const stride = PAGE_H + PAGE_GAP;
    const { part, pageIndex } = hfEditing;
    const pageTop = pageIndex * stride;
    hfChrome.style.left = `${m.left}px`;
    hfChrome.style.width = `${hfContentWidth()}px`;
    if (part === 'header') {
      const boundary = pageTop + Math.max(m.top, hf.header.distance + (hfEditing.box.offsetHeight || 0) + HF_GAP);
      hfChrome.style.top = `${boundary}px`;
    } else {
      const boundary = pageTop + Math.min(PAGE_H - m.bottom, PAGE_H - hf.footer.distance - (hfEditing.box.offsetHeight || 0) - HF_GAP);
      hfChrome.style.top = `${boundary - 26}px`;
    }
  }
  function toggleHfOptions(anchor) {
    if (hfOptionsMenu) return closeHfOptions();
    const { part } = hfEditing;
    const cfg = hf[part];
    const item = (labelTxt, checked, onToggle) => el('label', { class: 'doc-hf-optmenu__row' }, [
      el('input', { type: 'checkbox', checked, onChange: (e) => onToggle(e.target.checked) }),
      el('span', {}, labelTxt),
    ]);
    hfOptionsMenu = el('div', {
      class: 'app-menu doc-hf-optmenu', role: 'menu',
      onMousedown: (e) => e.preventDefault(), onPointerdown: (e) => e.stopPropagation(),
    }, [
      el('div', { class: 'doc-hf-optmenu__title' }, 'Header & footer options'),
      item('Different first page', cfg.differentFirst, (v) => setHfFlag('differentFirst', v)),
      item('Different odd & even', cfg.differentOddEven, (v) => setHfFlag('differentOddEven', v)),
      el('div', { class: 'app-menu__sep' }),
      menuBtn('Insert page number', () => { insertField('page'); closeHfOptions(); }),
      menuBtn('Insert page count', () => { insertField('pages'); closeHfOptions(); }),
      el('div', { class: 'app-menu__sep' }),
      menuBtn('Header & footer settings…', () => { closeHfOptions(); onRequestHfSettings?.(); }),
    ]);
    const r = anchor.getBoundingClientRect();
    Object.assign(hfOptionsMenu.style, { position: 'fixed', top: `${r.bottom + 6}px`, left: `${Math.min(r.left, window.innerWidth - 240)}px` });
    document.body.appendChild(hfOptionsMenu);
    setTimeout(() => document.addEventListener('pointerdown', onOptOutside, true), 0);
  }
  function onOptOutside(e) { if (hfOptionsMenu && !hfOptionsMenu.contains(e.target)) closeHfOptions(); }
  function closeHfOptions() {
    if (!hfOptionsMenu) return;
    hfOptionsMenu.remove(); hfOptionsMenu = null;
    document.removeEventListener('pointerdown', onOptOutside, true);
  }
  const menuBtn = (labelTxt, fn) => el('button', {
    class: 'app-menu__item', type: 'button', role: 'menuitem',
    onMousedown: (e) => e.preventDefault(),
    onClick: (e) => { e.stopPropagation(); fn(); },
  }, el('span', { class: 'app-menu__label' }, labelTxt));

  /** Toggle a layout flag. These are section-level in real documents, so the same
   *  flag is kept in sync across the header and the footer. */
  function setHfFlag(flag, on) {
    hf.header[flag] = on;
    hf.footer[flag] = on;
    buildHfMeasureAndReflow();
    if (hfChrome && hfEditing) {
      // The active box's kind may have changed (e.g. page 1 → first). Rebuild it.
      const { part, pageIndex } = hfEditing;
      exitHf(false);
      enterHf(part, pageIndex);
    }
    commit();
  }
  function buildHfMeasureAndReflow() { buildHfMeasure(); schedulePaginate(); }

  /* ---- page-number / total fields ---- */
  function insertField(fieldType) {
    editRoot.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !editRoot.contains(sel.focusNode)) return;
    const span = document.createElement('span');
    span.className = 'doc-field';
    span.dataset.field = fieldType;
    span.contentEditable = 'false';
    const pageNo = hfEditing ? hfEditing.pageIndex + 1 : 1;
    span.textContent = fieldType === 'pages' ? String(pageCount) : String(pageNo);
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(span);
    // Drop the caret just after the field (with a space so typing continues).
    const after = document.createTextNode(' ');
    span.after(after);
    const r = document.createRange();
    r.setStart(after, 1);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    if (hfEditing) onHfInput(); else commit();
    emitSelection();
  }

  /** Re-focus the body and drop the caret back where it last was. Used when the
   *  floating Symbol panel closes so the user keeps typing exactly where they were. */
  function restoreCaret() {
    // In positioned mode the page container is inert; the caret lives inside a
    // `.doc-posbox`. Focus that box (not the page) so the caret is actually placed
    // and typing/insert-at-cursor lands in it.
    const host = caretHost();
    host.focus();
    if (!savedRange || !editRoot.contains(savedRange.startContainer)) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange.cloneRange());
  }

  /**
   * Positioned docs only: place the caret in the nearest editable text box for a
   * click that didn't land on one. The page container is inert (contentEditable
   * false), so clicking the baked page graphics or the gap between line-boxes would
   * otherwise drop no caret and the doc feels un-editable. We find the box closest to
   * the point (0 distance = the click is inside it), focus it, and set the caret at
   * the exact point when possible, else at the nearest end. Returns true if a box
   * took the caret. `clientX/Y` are viewport coords (already post-zoom).
   */
  function focusNearestPosbox(clientX, clientY) {
    const boxes = page.querySelectorAll(':scope > .doc-posbox');
    if (!boxes.length) return false;
    let best = null, bestD = Infinity;
    for (const b of boxes) {
      const r = b.getBoundingClientRect();
      const dx = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
      const dy = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = b; if (d === 0) break; }
    }
    // Only route clicks that are reasonably NEAR text (a gap between lines, the margin
    // beside a line). A click far from every box is on the baked page graphic (e.g. a
    // diagram) — leave it alone rather than teleporting the caret to a distant line,
    // which feels broken. ~90 CSS px ≈ a few lines; scaled by the current zoom.
    const reach = 90 * (zoom || 1);
    if (!best || bestD > reach * reach) return false;
    best.focus();
    const sel = window.getSelection();
    if (!sel) return true;
    // Prefer the exact caret position under the cursor; fall back to the box end when
    // the point is outside the chosen box (a click in the margin/graphic beside it).
    let range = document.caretRangeFromPoint ? document.caretRangeFromPoint(clientX, clientY) : null;
    if (!range || !best.contains(range.startContainer)) {
      range = document.createRange();
      range.selectNodeContents(best);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
    savedRange = range.cloneRange();
    return true;
  }

  /** The element that should take focus for caret operations: in positioned docs,
   *  the `.doc-posbox` holding the saved/live caret; otherwise the edit root. */
  function caretHost() {
    if (base && base.layout === 'positioned') {
      const node = (savedRange && savedRange.startContainer) || (window.getSelection() && window.getSelection().anchorNode);
      const elNode = node && (node.nodeType === 3 ? node.parentElement : node);
      const box = elNode && elNode.closest && elNode.closest('.doc-posbox');
      if (box) return box;
    }
    return editRoot;
  }

  /** Insert a plain string (e.g. a math/science symbol) at the current caret. If
   *  focus has moved to the Symbol panel, fall back to the last saved caret so the
   *  glyph still lands in the document without disturbing existing formatting. */
  function insertText(str) {
    if (!str) return;
    const sel = window.getSelection();
    // Decide the target range BEFORE focusing editRoot: focusing a contenteditable
    // can reset the live selection to its start, which would drop the glyph at the
    // top of the document instead of at the real caret / last saved position.
    let range = null;
    if (sel && sel.rangeCount && editRoot.contains(sel.getRangeAt(0).startContainer)) {
      range = sel.getRangeAt(0).cloneRange();
    } else if (savedRange && editRoot.contains(savedRange.startContainer)) {
      range = savedRange.cloneRange();
    } else {
      // No known caret — append at the very end of the editable body.
      range = document.createRange();
      range.selectNodeContents(editRoot);
      range.collapse(false);
    }
    editRoot.focus();
    range.deleteContents();
    const node = document.createTextNode(str);
    range.insertNode(node);
    // Drop the caret just after the inserted glyph so repeated inserts append.
    const r = document.createRange();
    r.setStartAfter(node);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    savedRange = r.cloneRange();
    if (hfEditing) onHfInput(); else commit();
    emitSelection();
  }

  /* ---- header/footer configuration (Insert menu + settings dialog) ---- */
  function editHeader() { enterHf('header', Math.max(0, Math.min(pageCount - 1, getCurrentPage() - 1))); }
  function editFooter() { enterHf('footer', Math.max(0, Math.min(pageCount - 1, getCurrentPage() - 1))); }
  function getHfSettings() {
    return {
      headerDistance: hf.header.distance,
      footerDistance: hf.footer.distance,
      differentFirst: hf.header.differentFirst,
      differentOddEven: hf.header.differentOddEven,
    };
  }
  function setHfSettings({ headerDistance, footerDistance, differentFirst, differentOddEven }) {
    if (Number.isFinite(headerDistance)) hf.header.distance = Math.max(0, Math.round(headerDistance));
    if (Number.isFinite(footerDistance)) hf.footer.distance = Math.max(0, Math.round(footerDistance));
    if (differentFirst != null) { hf.header.differentFirst = !!differentFirst; hf.footer.differentFirst = !!differentFirst; }
    if (differentOddEven != null) { hf.header.differentOddEven = !!differentOddEven; hf.footer.differentOddEven = !!differentOddEven; }
    if (hfEditing) { const { part, pageIndex } = hfEditing; exitHf(false); buildHfMeasure(); schedulePaginate(); enterHf(part, pageIndex); }
    else { buildHfMeasure(); schedulePaginate(); }
    commit();
  }

  /** Double-click a page margin → edit the header (top) or footer (bottom) there.
   *  Only the actual margin band is a hit zone, so body double-clicks are normal. */
  function onPageDblClickHf(e) {
    if (hfEditing || page.classList.contains('is-readonly') || !hf) return;
    if (e.target.closest && e.target.closest('table')) return; // let table dbl-click win
    const rect = stack.getBoundingClientRect();
    const y = (e.clientY - rect.top) / zoom;
    const m = pageMargins();
    const PAGE_H = base.page.height;
    const stride = PAGE_H + PAGE_GAP;
    const pageIndex = Math.floor(y / stride);
    if (pageIndex < 0 || pageIndex >= pageCount) return;
    const offY = y - pageIndex * stride;
    if (offY > PAGE_H) return; // in the inter-page gap
    const headerZone = m.top + headerReserve(pageIndex);
    const footerZone = PAGE_H - m.bottom - footerReserve(pageIndex);
    if (offY <= headerZone) { e.preventDefault(); enterHf('header', pageIndex); }
    else if (offY >= footerZone) { e.preventDefault(); enterHf('footer', pageIndex); }
  }

  /* ------------------------------- history ------------------------------ */
  // A snapshot captures BOTH the body HTML and the header/footer model, so undo/
  // redo restore running heads/feet too (they live in the model, not the DOM flow).
  function snapshot() {
    return { body: page.innerHTML, hf: hf ? JSON.stringify({ header: hf.header, footer: hf.footer }) : null };
  }
  function restoreSnapshot(s) {
    if (hfEditing) exitHf(false); // never restore while a box is open for editing
    page.innerHTML = s.body;
    if (s.hf && base) {
      const o = JSON.parse(s.hf);
      base.header = normalizeHf(o.header);
      base.footer = normalizeHf(o.footer);
      hf = { header: base.header, footer: base.footer };
      buildHfMeasure();
    }
    stripImgSel();
    lastHtml = page.innerHTML;
    lastSnap = snapshot();
  }
  function commit() {
    if (hfEditing) flushHfEditing(); // fold an in-progress running head/foot edit in
    if (lastSnap) undoStack.push(lastSnap);
    if (undoStack.length > 120) undoStack.shift();
    lastSnap = snapshot();
    lastHtml = page.innerHTML;
    redoStack.length = 0;
    notify();
    schedulePaginate();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restoreSnapshot(undoStack.pop());
    notify();
    schedulePaginate();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restoreSnapshot(redoStack.pop());
    notify();
    schedulePaginate();
  }
  const canUndo = () => undoStack.length > 0;
  const canRedo = () => redoStack.length > 0;

  function notify() {
    syncListMarkers();
    onChange?.({ canUndo: canUndo(), canRedo: canRedo() });
  }

  /**
   * A list's number/bullet marker is drawn by the browser off the <li> element,
   * so bolding text inside the item (which wraps it in a <span>) never touches the
   * marker. Mirror the item's leading formatting onto CSS custom properties the
   * `::marker` reads (see .doc-list li::marker), so the "1." bolds/italicises and
   * colours to match its text — like Google Docs. Kept out of history snapshots
   * (set post-commit) so it never bloats undo state.
   */
  function syncListMarkers() {
    for (const li of page.querySelectorAll('.doc-list > li')) {
      const src = li.querySelector('span') || li;
      const cs = getComputedStyle(src);
      const bold = (parseInt(cs.fontWeight, 10) || 400) >= 600;
      li.style.setProperty('--mk-weight', bold ? '700' : '400');
      li.style.setProperty('--mk-style', cs.fontStyle === 'italic' ? 'italic' : 'normal');
      li.style.setProperty('--mk-color', cs.color);
    }
  }

  /* ---------------------------- text editing ---------------------------- */
  page.addEventListener('input', (e) => {
    // Dormant positioned box: once its text is actually edited, keep it revealed so
    // the change stays visible (it must not snap back to showing the original raster).
    const edited = e.target && e.target.closest && e.target.closest('.doc-posbox');
    if (edited) edited.dataset.edited = '1';
    clearTimeout(inputTimer);
    inputTimer = setTimeout(commit, 350);
    schedulePaginate(); // reflow pages as you type, without waiting for commit
  });

  // While an IME composition is active, DOM surgery (the paragraph splitter,
  // node normalisation) would abort the composition, so pagination holds off and
  // re-runs once composition ends.
  page.addEventListener('compositionstart', () => { composing = true; });
  page.addEventListener('compositionend', () => { composing = false; schedulePaginate(); });

  // Dormant reveal: a positioned box is hidden (original page image shows through)
  // until focused — click it to reveal + edit. On blur it re-hides UNLESS it was
  // edited, so untouched fields stay pixel-exact while edited ones keep their change.
  page.addEventListener('focusin', (e) => {
    const box = e.target && e.target.closest && e.target.closest('.doc-posbox');
    if (!box) return;
    box.classList.remove('doc-posbox--dormant');
    fitPosboxWidth(box);
  });
  page.addEventListener('focusout', (e) => {
    const box = e.target && e.target.closest && e.target.closest('.doc-posbox');
    // `revealed` boxes (erased-raster re-import) are always visible — never re-dorm them.
    if (box && box.dataset.edited !== '1' && box.dataset.revealed !== '1') box.classList.add('doc-posbox--dormant');
  });

  function fitPosboxWidth(box) {
    if (base && base.layout === 'positioned') fitPosboxWidthEl(box, (base.page && base.page.width) || 0);
  }

  // Click an image to select it (show resize handles); click anywhere else to
  // deselect. Handle drags stopPropagation, so they never reach this listener.
  // A contentEditable=false figure is natively draggable inside an editable
  // surface; that native drag fires `dragstart` and cancels our pointer sequence,
  // so image moves would silently abort. Suppress it — we drive movement with our
  // own pointer handler instead.
  page.addEventListener('dragstart', (e) => {
    if (e.target.closest?.('.doc-image')) e.preventDefault();
  });

  page.addEventListener('pointerdown', (e) => {
    // A left-click anywhere that isn't a resize handle clears a selected text box, so
    // clicking returns to normal text editing. (Handle drags stopPropagation, so they
    // never reach here; right-click is handled by the contextmenu listener below.)
    if (e.button === 0 && boxSel && !e.target.closest?.('.doc-imgsel__h')) deselectBox();
    const fig = e.target.closest?.('.doc-image');
    if (fig && page.contains(fig)) {
      if (e.button === 2) return; // right-click → let contextmenu handle it
      e.preventDefault(); // don't drop a caret; select the image object
      selectImage(fig);
      if (e.button === 0) startImageMove(e, fig); // drag the body to reposition
    } else if (!e.target.closest?.('.doc-imgsel')) {
      deselectImage();
      // Positioned docs: the page container is inert, so a left-click that isn't on a
      // text box (baked graphics, or the gap between line-boxes) would place no caret
      // and typing would do nothing. Route it to the nearest box so clicking anywhere
      // near text starts editing. Direct clicks on a box fall through to the browser
      // (native caret + drag-select preserved).
      if (base && base.layout === 'positioned' && e.button === 0 && !e.target.closest?.('.doc-posbox')) {
        if (focusNearestPosbox(e.clientX, e.clientY)) e.preventDefault();
      }
    }
  });

  // Right-click an inserted shape/image → our own shape-editing menu (Fill /
  // Border / Line colour, opacity, arrange, duplicate, delete), never the
  // browser default. Right-clicking elsewhere keeps native behaviour.
  page.addEventListener('contextmenu', (e) => {
    const fig = e.target.closest?.('.doc-image');
    if (fig && page.contains(fig)) {
      e.preventDefault();
      selectImage(fig);
      // Professional Library charts get their own chart-specific menu; shapes/
      // images keep the existing shape menu (unchanged).
      if (fig.classList.contains('doc-chart')) openChartMenu(fig, e.clientX, e.clientY);
      else openShapeMenu(fig, e.clientX, e.clientY);
      return;
    }
    // Right-click a positioned text box → select it as an object and open its menu
    // (resize handles + background opacity + delete). Any box, whenever needed.
    const box = e.target.closest?.('.doc-posbox');
    if (box && page.contains(box) && base && base.layout === 'positioned') {
      e.preventDefault();
      selectBox(box);
      openBoxMenu(box, e.clientX, e.clientY);
    }
  });

  // Keep Undo/Redo ours (Ctrl+Z/Y) so it stays in sync with the snapshot stack.
  // Attached to the body page AND each header/footer box, so editing behaves the
  // same in both (it reads/writes through `editRoot`).
  function handleEditorKeydown(e) {
    const k = e.key.toLowerCase();
    // Escape leaves header/footer editing and returns to the body.
    if (e.key === 'Escape' && hfEditing) {
      e.preventDefault();
      exitHf();
      page.focus();
      return;
    }
    // Delete a selected image with Delete/Backspace.
    if (imgSel && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      const fig = imgSel;
      deselectImage();
      fig.remove();
      ensureTrailingParagraph();
      commit();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && k === 'z') {
      e.preventDefault();
      // Flush any pending typed burst first so undo steps feel natural.
      clearTimeout(inputTimer);
      if (page.innerHTML !== lastHtml) commit();
      e.shiftKey ? redo() : undo();
    } else if ((e.ctrlKey || e.metaKey) && k === 'y') {
      e.preventDefault();
      redo();
    } else if ((e.ctrlKey || e.metaKey) && (k === 'b' || k === 'i' || k === 'u')) {
      e.preventDefault();
      toggleMark({ b: 'bold', i: 'italic', u: 'underline' }[k]);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Inside a list or a table cell, defer to the browser's native behaviour
      // (new <li>, exit-on-empty, cell line breaks) — it handles these correctly.
      if (inList() || inTableCell()) return;
      // Own paragraph creation so it works consistently (browser defaults for
      // Enter inside styled spans are unreliable and vary by engine).
      e.preventDefault();
      insertParagraphBreak();
    } else if (e.key === 'Backspace') {
      // Let the browser edit list items / table cells natively.
      if (inList() || inTableCell()) return;
      // Merge into the previous block when the caret sits at a block's start.
      if (maybeMergeBackspace()) e.preventDefault();
    }
  }
  page.addEventListener('keydown', handleEditorKeydown);

  /**
   * Split the current block at the caret into two blocks. Content after the
   * caret moves into a new block placed right after; the caret lands at its
   * start. Pressing Enter in a heading starts a normal body paragraph next.
   */
  function insertParagraphBreak() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!editRoot.contains(range.startContainer)) return;

    // Positioned (exact-layout) docs: the caret's "block" is a `.doc-posbox` pinned to
    // page coordinates. The flow split below would extract the post-caret content into
    // a NEW sibling flow <div>, tearing text out of the positioned box — the box empties
    // and the line "disappears" (the reported bug). Break INSIDE the box instead:
    // lossless, the caret lands on the new line, and the box just grows a line.
    const host = blockOf(range.startContainer);
    if (host && host.classList && host.classList.contains('doc-posbox')) {
      const r = breakInPosbox(range, host);
      sel.removeAllRanges();
      sel.addRange(r);
      host.dataset.edited = '1';                       // keep it revealed once edited
      host.classList.remove('doc-posbox--dormant');
      commit();
      emitSelection();
      return;
    }

    if (!range.collapsed) range.deleteContents();

    const block = blockOf(range.startContainer);
    if (!block) return;

    // Extract everything from the caret to the end of the block.
    const tail = document.createRange();
    tail.selectNodeContents(block);
    tail.setStart(range.startContainer, range.startOffset);
    const frag = tail.extractContents();

    const newTag = /^H[1-3]$/.test(block.tagName) ? 'p' : block.tagName.toLowerCase();
    const nb = document.createElement(newTag);
    nb.className = 'doc-block';
    // Carry paragraph-level styling (align, line-height, spacing) forward.
    nb.style.cssText = block.style.cssText;
    if (frag.childNodes.length) nb.appendChild(frag);
    else nb.appendChild(document.createElement('br'));
    if (!block.childNodes.length) block.appendChild(document.createElement('br'));

    block.after(nb);

    const r = document.createRange();
    r.setStart(nb, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    commit();
    emitSelection();
  }

  /** When Backspace is pressed at the very start of a block, merge it up. */
  function maybeMergeBackspace() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const block = blockOf(range.startContainer);
    if (!block) return false;
    // Is the caret at the very start of the block's text?
    const probe = document.createRange();
    probe.selectNodeContents(block);
    probe.setEnd(range.startContainer, range.startOffset);
    if (probe.toString().length !== 0) return false;

    // Skip any pagination spacers sitting between blocks.
    let prev = block.previousElementSibling;
    while (prev && prev.classList.contains('doc-pagebreak')) prev = prev.previousElementSibling;
    if (!prev || !/^(P|H1|H2|H3|DIV)$/.test(prev.tagName)) return false;

    // Place caret at end of prev, then move this block's content into it.
    const caret = document.createRange();
    if (prev.lastChild) caret.setStartAfter(prev.lastChild);
    else caret.setStart(prev, 0);
    caret.collapse(true);
    const prevHadBr = prev.querySelector(':scope > br');
    if (prevHadBr) prevHadBr.remove();
    while (block.firstChild) prev.appendChild(block.firstChild);
    block.remove();
    sel.removeAllRanges();
    sel.addRange(caret);
    commit();
    emitSelection();
    return true;
  }

  /* ---------------------------- formatting ------------------------------ */
  function toggleMark(name) {
    editRoot.focus();
    try {
      document.execCommand('styleWithCSS', false, true);
    } catch {
      /* ignore */
    }
    document.execCommand(name);
    commit();
    emitSelection();
  }

  /** Strip inline character formatting (bold/italic/underline/strike/colour/
   *  sup·sub, etc.) from the selection — Word's "Clear formatting". Leaves block
   *  structure (paragraph vs heading, lists) untouched. */
  function clearFormatting() {
    editRoot.focus();
    document.execCommand('removeFormat');
    // removeFormat leaves sup/sub wrappers in some engines — undo them explicitly.
    if (document.queryCommandState('superscript')) document.execCommand('superscript');
    if (document.queryCommandState('subscript')) document.execCommand('subscript');
    commit();
    emitSelection();
  }

  /**
   * Highlighter (text background). Uses `hiliteColor` via execCommand so it
   * behaves like Google Docs: with a real selection it paints that text; with a
   * collapsed caret it sets the PENDING typing style, so whatever you type next
   * comes out highlighted until the colour is cleared. Pass 'transparent' to
   * clear the highlight (Format → Remove highlight / palette "None").
   */
  function setHighlight(color) {
    editRoot.focus();
    const off = !color || color === 'transparent';
    const sel = window.getSelection();

    // Turning the marker OFF at a collapsed caret (disarm typing): a "transparent"
    // typing style doesn't reliably stop the browser continuing the current
    // highlighted run. Instead, break out of the run — drop a zero-width anchor
    // right AFTER the highlighted span, at block level, and put the caret in it.
    // New text lands in that plain anchor, not the coloured span.
    if (off) {
      if (sel && sel.isCollapsed && editRoot.contains(sel.focusNode)) {
        const elx = sel.focusNode?.nodeType === 3 ? sel.focusNode.parentElement : sel.focusNode;
        const span = elx?.closest?.('span[style*="background"]');
        if (span && editRoot.contains(span)) {
          const anchor = document.createTextNode('​'); // zero-width space
          span.after(anchor);
          const r = document.createRange();
          r.setStart(anchor, 1);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
          commit();
          emitSelection();
          return;
        }
        return; // caret isn't in a highlighted run — nothing to disarm
      }
      // A real selection: clear its background so the highlight is removed.
    }

    try {
      document.execCommand('styleWithCSS', false, true);
    } catch {
      /* ignore */
    }
    // Chromium/Edge honours 'hiliteColor'; fall back to 'backColor' elsewhere.
    const value = off ? 'transparent' : color;
    if (!document.execCommand('hiliteColor', false, value)) {
      document.execCommand('backColor', false, value);
    }
    commit();
    emitSelection();
  }

  /** Wrap the current (non-empty) selection in a styled span. */
  function setInlineStyle(prop, value) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed || !editRoot.contains(range.commonAncestorContainer)) return;
    const span = document.createElement('span');
    span.style[prop] = value;
    try {
      range.surroundContents(span);
    } catch {
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    sel.removeAllRanges();
    const r = document.createRange();
    r.selectNodeContents(span);
    sel.addRange(r);
    commit();
    emitSelection();
  }

  /** Apply a CSS property to every block element the selection touches. */
  function setBlockStyle(prop, value) {
    const blocks = selectedBlocks();
    if (!blocks.length) return;
    for (const b of blocks) b.style[prop] = String(value);
    commit();
    emitSelection();
  }

  function setBlockTag(tag) {
    const blocks = selectedBlocks();
    if (!blocks.length) return;
    for (const b of blocks) {
      if (b.tagName.toLowerCase() === tag) continue;
      const nb = document.createElement(tag);
      nb.className = b.className;
      if (b.dataset.blockId) nb.dataset.blockId = b.dataset.blockId;
      nb.style.cssText = b.style.cssText;
      while (b.firstChild) nb.appendChild(b.firstChild);
      b.replaceWith(nb);
    }
    commit();
    emitSelection();
  }

  /* ------------------------- inline text styling ------------------------ */
  /**
   * Apply a run-level CSS property (font family/size, colour). With a real
   * selection we wrap just that text; with a collapsed caret we style the whole
   * current block/list-item, which is the intuitive Word-like behaviour.
   */
  function styleText(prop, value) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !editRoot.contains(sel.focusNode)) return;
    if (!sel.getRangeAt(0).collapsed) { setInlineStyle(prop, value); return; }
    const target = styleableOf(sel.focusNode);
    if (!target) return;
    target.style[prop] = String(value);
    commit();
    emitSelection();
  }
  const setFontFamily = (family) => styleText('fontFamily', family);
  const setFontSize = (px) => styleText('fontSize', `${parseFloat(px) || 16}px`);
  /**
   * Text colour. Uses `foreColor` via execCommand so it behaves like Word/Docs:
   * with a real selection it recolours just that text; with a collapsed caret it
   * sets the PENDING typing style, so only text typed NEXT takes the colour —
   * existing text is left untouched. (The old block-level path recoloured the
   * whole paragraph, so picking a colour for the next word restyled earlier text.)
   */
  function setColor(color) {
    editRoot.focus();
    try {
      document.execCommand('styleWithCSS', false, true);
    } catch {
      /* ignore */
    }
    document.execCommand('foreColor', false, color);
    commit();
    emitSelection();
  }
  /** Alignment is always a block property; apply to every block the selection spans. */
  const setAlign = (align) => setBlockStyle('textAlign', align);

  /** The nearest element whose inline style should carry run formatting. */
  function styleableOf(node) {
    const elx = node?.nodeType === 3 ? node.parentElement : node;
    return elx?.closest?.('li, td, .doc-block') || blockOf(node);
  }

  /* --------------------------- lists / tables --------------------------- */
  function insertList(ordered) {
    editRoot.focus();
    document.execCommand(ordered ? 'insertOrderedList' : 'insertUnorderedList');
    // execCommand's lists are bare <ul>/<ol>; tag them so they read back as list
    // blocks and pick up the document's list styling.
    editRoot.querySelectorAll('ul:not(.doc-list), ol:not(.doc-list)').forEach((l) =>
      l.classList.add('doc-block', 'doc-list')
    );
    commit();
    emitSelection();
  }

  function insertTable(rows = 3, cols = 3) {
    const table = document.createElement('table');
    table.className = 'doc-block doc-table';
    const tbody = document.createElement('tbody');
    for (let r = 0; r < rows; r += 1) {
      const tr = document.createElement('tr');
      for (let c = 0; c < cols; c += 1) {
        const td = document.createElement('td');
        td.appendChild(document.createElement('br'));
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    // Give the table explicit equal column widths (a <colgroup>) so it uses
    // `table-layout: fixed`. Without this the table is content-sized (auto), and
    // merging cells by erasing grid lines produces irregular columns where the
    // merged cell can't fill its full box.
    setEqualColgroup(table, cols);
    insertBlock(table, table.querySelector('td'));
  }

  /** Replace a table's <colgroup> with `nCols` equal-width columns (percent), so
   *  the table renders with fixed, uniform columns. */
  function setEqualColgroup(table, nCols) {
    if (!table || nCols < 1) return null;
    let cg = table.querySelector(':scope > colgroup');
    if (!cg) { cg = document.createElement('colgroup'); table.insertBefore(cg, table.firstChild); }
    const w = (100 / nCols).toFixed(4);
    cg.replaceChildren(...Array.from({ length: nCols }, () => {
      const col = document.createElement('col');
      col.style.width = `${w}%`;
      return col;
    }));
    return cg;
  }

  /** The table element containing the current selection, or null. */
  function tableAtSelection() {
    const n = window.getSelection()?.focusNode;
    const elx = n?.nodeType === 3 ? n.parentElement : n;
    const table = elx?.closest?.('table.doc-table');
    return table && page.contains(table) ? table : null;
  }
  const inTable = () => !!tableAtSelection();

  /** Set the border weight of the table under the caret: 'thin'|'thick'|'none'. */
  function setTableBorder(style) {
    const table = tableAtSelection();
    if (!table) return false;
    table.classList.remove('doc-table--thick', 'doc-table--none');
    if (style && style !== 'thin') {
      table.classList.add(`doc-table--${style}`);
      table.dataset.border = style;
    } else {
      delete table.dataset.border;
    }
    commit();
    emitSelection();
    return true;
  }

  /** The <td> containing the current selection, or null. */
  function cellAtSelection() {
    const n = window.getSelection()?.focusNode;
    const elx = n?.nodeType === 3 ? n.parentElement : n;
    const td = elx?.closest?.('td, th');
    return td && page.contains(td) ? td : null;
  }

  /** A fresh empty cell that keeps the caret selectable. */
  function newCell() {
    const td = document.createElement('td');
    td.appendChild(document.createElement('br'));
    return td;
  }

  /** Put the caret at the start of a cell. */
  function caretInCell(td) {
    if (!td) return;
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(td, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /* ---- span-aware structural ops via the pure table-grid engine ---- */
  // Rows the pagination engine injected (page-break spacers + repeated headers)
  // are visual-only. Every structural / geometric read below must ignore them so
  // row indices, spans and hit-testing map to the real cell grid, not the
  // transient pagination scaffolding.
  const isArtifactRow = (tr) =>
    tr.classList.contains('doc-pagebreak-row') || tr.classList.contains('doc-pagebreak-header');
  const realRows = (table) => Array.from(table.rows).filter((tr) => !isArtifactRow(tr));

  // Read the live <table> into the engine's master-cell list (ref = the <td>).
  function fromDomTable(table) {
    const occ = [];
    const masters = [];
    realRows(table).forEach((tr, r) => {
      let c = 0;
      for (const td of tr.cells) {
        while (occ[r] && occ[r][c]) c += 1;
        const rs = td.rowSpan || 1;
        const cs = td.colSpan || 1;
        masters.push({ r, c, rs, cs, ref: td });
        for (let dr = 0; dr < rs; dr += 1) for (let dc = 0; dc < cs; dc += 1) {
          (occ[r + dr] = occ[r + dr] || [])[c + dc] = true;
        }
        c += cs;
      }
    });
    return masters;
  }

  // Rebuild the table body from a master list, reusing existing <td> nodes (so
  // their content and caret survive) and minting blanks for new positions.
  function toDomTable(table, masters) {
    const { nrows } = TG.dims(masters);
    const byRow = Array.from({ length: nrows }, () => []);
    for (const m of TG.sortMasters(masters)) byRow[m.r].push(m);
    const heights = realRows(table).map((tr) => tr.style.height || '');
    const tbody = table.tBodies[0] || table.appendChild(document.createElement('tbody'));
    const trs = [];
    for (let r = 0; r < nrows; r += 1) {
      const tr = document.createElement('tr');
      if (heights[r]) tr.style.height = heights[r];
      for (const m of byRow[r]) {
        const td = m.ref instanceof HTMLElement ? m.ref : newCell();
        if (m.cs > 1) td.colSpan = m.cs; else td.removeAttribute('colspan');
        if (m.rs > 1) td.rowSpan = m.rs; else td.removeAttribute('rowspan');
        td.style.height = heights[r] || '';
        tr.appendChild(td); // moves the node into the fresh row
      }
      trs.push(tr);
    }
    tbody.replaceChildren(...trs);
  }

  // Fold one cell's real content into another (used when merging cells).
  function appendCellContent(src, dst) {
    if (!src || !dst || src === dst) return;
    if (!(src.textContent || '').replace(/[\s ]/g, '')) return; // empty → nothing to carry
    if ((dst.textContent || '').replace(/[\s ]/g, '')) dst.appendChild(document.createElement('br'));
    else dst.replaceChildren(); // drop dst's placeholder <br> so there's no blank first line
    while (src.firstChild) dst.appendChild(src.firstChild);
  }

  /** Insert a row above ('above') or below ('below') the caret's row. */
  function insertTableRow(where = 'below') {
    const td = cellAtSelection();
    const table = td?.closest('table.doc-table');
    if (!td || !table) return false;
    const masters = fromDomTable(table);
    const m = masters.find((x) => x.ref === td);
    if (!m) return false;
    const at = where === 'above' ? m.r : m.r + m.rs;
    toDomTable(table, TG.insertRow(masters, at, () => newCell()));
    commit();
    caretInCell(td);
    emitSelection();
    return true;
  }

  /** Insert a column left ('left') or right ('right') of the caret's column. */
  function insertTableColumn(where = 'right') {
    const td = cellAtSelection();
    const table = td?.closest('table.doc-table');
    if (!td || !table) return false;
    const masters = fromDomTable(table);
    const m = masters.find((x) => x.ref === td);
    if (!m) return false;
    const at = where === 'left' ? m.c : m.c + m.cs;
    const nextMasters = TG.insertCol(masters, at, () => newCell());
    toDomTable(table, nextMasters);
    // Column count changed → reset to equal fixed widths (keeps table-layout:fixed
    // so cells stay uniform and merges fill their full box).
    setEqualColgroup(table, TG.dims(nextMasters).ncols);
    commit();
    caretInCell(td);
    emitSelection();
    return true;
  }

  /** Delete the caret's row (removes the whole table if it was the last row). */
  function deleteTableRow() {
    const td = cellAtSelection();
    const table = td?.closest('table.doc-table');
    if (!td || !table) return false;
    const masters = fromDomTable(table);
    const m = masters.find((x) => x.ref === td);
    if (!m) return false;
    if (TG.dims(masters).nrows <= 1) return deleteTable();
    toDomTable(table, TG.deleteRow(masters, m.r).masters);
    commit();
    caretInCell(page.contains(td) ? td : table.querySelector('td'));
    emitSelection();
    return true;
  }

  /** Delete the caret's column (removes the whole table if it was the last one). */
  function deleteTableColumn() {
    const td = cellAtSelection();
    const table = td?.closest('table.doc-table');
    if (!td || !table) return false;
    const masters = fromDomTable(table);
    const m = masters.find((x) => x.ref === td);
    if (!m) return false;
    if (TG.dims(masters).ncols <= 1) return deleteTable();
    table.querySelector('colgroup')?.remove();
    toDomTable(table, TG.deleteCol(masters, m.c).masters);
    commit();
    caretInCell(page.contains(td) ? td : table.querySelector('td'));
    emitSelection();
    return true;
  }

  /** Remove the whole table under the caret. */
  function deleteTable() {
    const table = tableAtSelection();
    if (!table) return false;
    const after = table.nextElementSibling || table.previousElementSibling;
    table.remove();
    ensureTrailingParagraph();
    commit();
    const target = (after && page.contains(after)) ? after : page.lastElementChild;
    if (target) caretInCell(target);
    emitSelection();
    return true;
  }

  /* ------------------------- column resizing ---------------------------- */
  // Drag a vertical grid line to change how the two columns on either side share
  // the row width. Widths live on a <colgroup> (percent) so table-layout:fixed
  // honours them and they round-trip through the model + exporters.
  let colResize = null;
  let rowResize = null;
  let borderEdit = false; // "Lines" mode: click a grid line to remove/restore it

  const EDGE_PROP = { t: 'borderTopStyle', r: 'borderRightStyle', b: 'borderBottomStyle', l: 'borderLeftStyle' };

  /** Turn line-editing mode on/off (click a line to toggle it). */
  function setBorderEdit(on) {
    borderEdit = !!on;
    page.classList.toggle('is-borderedit', borderEdit);
    if (!borderEdit) { page.style.cursor = ''; edgeHi.hidden = true; }
    return borderEdit;
  }

  /**
   * The LOGICAL grid geometry of a table: where every column boundary (x) and
   * row boundary (y) sits, plus the master-cell list. Column boundaries are
   * uniform (table-layout:fixed) so they're derived from the colgroup/width even
   * inside a merged cell; row boundaries come from the <tr> positions. This lets
   * the Lines tool address a boundary that has no <td> edge — the invisible line
   * inside a merged cell — which a td-edge test could never see.
   */
  function tableGeometry(table) {
    const masters = fromDomTable(table);
    const { nrows, ncols } = TG.dims(masters);
    const tRect = table.getBoundingClientRect();
    const cg = table.querySelector('colgroup');
    let widths;
    if (cg && cg.children.length === ncols) {
      const ws = Array.from(cg.children).map((c) => parseFloat(c.style.width) || 0);
      const sum = ws.reduce((a, b) => a + b, 0) || ncols;
      widths = ws.map((w) => (w / sum) * tRect.width);
    } else {
      widths = new Array(ncols).fill(tRect.width / ncols);
    }
    const colX = [tRect.left];
    for (let i = 0; i < ncols; i += 1) colX.push(colX[i] + widths[i]);
    const trs = realRows(table);
    const rowY = [];
    for (let r = 0; r < nrows; r += 1) rowY.push(trs[r].getBoundingClientRect().top);
    rowY.push(trs[nrows - 1].getBoundingClientRect().bottom);
    return { masters, nrows, ncols, colX, rowY };
  }

  /**
   * The grid line nearest the pointer, described on the logical grid:
   *   action:'merge' — the segment separates two different cells → click removes
   *                    it (merges them so text flows across).
   *   action:'split' — both sides are the SAME merged cell → click restores the
   *                    boundary (splits the cell back), the exact inverse.
   *   action:'outer' — a table-edge line → click toggles that border's paint.
   */
  function lineHitAt(e) {
    if (page.classList.contains('is-readonly')) return null;
    const t = e.target;
    const td = t?.nodeType === 1 ? t.closest?.('td, th') : null;
    const table = td?.closest?.('table.doc-table');
    if (!td || !table || !page.contains(table)) return null;
    const { masters, nrows, ncols, colX, rowY } = tableGeometry(table);
    const x = e.clientX;
    const yv = e.clientY;
    let cc = 0; while (cc < ncols - 1 && x >= colX[cc + 1]) cc += 1;
    let rr = 0; while (rr < nrows - 1 && yv >= rowY[rr + 1]) rr += 1;
    let vk = 0; let vd = Infinity;
    for (let k = 0; k <= ncols; k += 1) { const d = Math.abs(x - colX[k]); if (d < vd) { vd = d; vk = k; } }
    let hk = 0; let hd = Infinity;
    for (let k = 0; k <= nrows; k += 1) { const d = Math.abs(yv - rowY[k]); if (d < hd) { hd = d; hk = k; } }
    if (vd <= hd) { // nearest boundary is vertical
      if (vd > GRAB) return null;
      const segRect = { left: colX[vk] - 1.5, top: rowY[rr], width: 3, height: rowY[rr + 1] - rowY[rr] };
      if (vk === 0 || vk === ncols) {
        const m = TG.masterAt(masters, rr, vk === 0 ? 0 : ncols - 1);
        return m ? { action: 'outer', td: m.ref, edge: vk === 0 ? 'l' : 'r', segRect } : null;
      }
      const left = TG.masterAt(masters, rr, vk - 1);
      const right = TG.masterAt(masters, rr, vk);
      if (!left || !right) return null;
      if (left === right) return { action: 'split', masterTd: left.ref, orient: 'v', at: vk, segRect };
      return { action: 'merge', aTd: left.ref, orient: 'v', segRect };
    }
    if (hd > GRAB) return null; // nearest boundary is horizontal
    const segRect = { left: colX[cc], top: rowY[hk] - 1.5, width: colX[cc + 1] - colX[cc], height: 3 };
    if (hk === 0 || hk === nrows) {
      const m = TG.masterAt(masters, hk === 0 ? 0 : nrows - 1, cc);
      return m ? { action: 'outer', td: m.ref, edge: hk === 0 ? 't' : 'b', segRect } : null;
    }
    const top = TG.masterAt(masters, hk - 1, cc);
    const bot = TG.masterAt(masters, hk, cc);
    if (!top || !bot) return null;
    if (top === bot) return { action: 'split', masterTd: top.ref, orient: 'h', at: hk, segRect };
    return { action: 'merge', aTd: top.ref, orient: 'h', segRect };
  }

  /** Flag cells that have any erased edge so Lines mode can tint them. */
  function refreshErasedMarks(table) {
    if (!table) return;
    for (const tr of realRows(table)) for (const td of tr.cells) {
      const any = ['t', 'r', 'b', 'l'].some((e) => td.style[EDGE_PROP[e]] === 'hidden');
      td.classList.toggle('is-lineerased', any);
    }
  }

  /**
   * Act on the grid line under the cursor. The three actions are exact inverses
   * where it matters: 'merge' removes a boundary (cells become continuous),
   * 'split' restores that same boundary (cells separate again, content kept in
   * the top-left piece), 'outer' just toggles a table-edge border's paint.
   */
  function handleLineClick(hit) {
    const anchor = hit.masterTd || hit.aTd || hit.td;
    const table = anchor && anchor.closest('table.doc-table');
    if (!table) return;
    if (hit.action === 'merge') {
      const res = TG.mergeAcrossEdge(fromDomTable(table), hit.aTd, hit.orient === 'v' ? 'r' : 'b');
      if (!res) return;
      for (const rmTd of res.removed) appendCellContent(rmTd, hit.aTd);
      for (const e of ['t', 'r', 'b', 'l']) hit.aTd.style[EDGE_PROP[e]] = '';
      hit.aTd.classList.remove('is-lineerased');
      // A merged (colspan) cell only fills its full box under `table-layout:fixed`.
      // Freeze fixed equal column widths first if the table has no colgroup yet
      // (auto-layout would size the merged cell to its content instead).
      if (!table.querySelector(':scope > colgroup')) setEqualColgroup(table, TG.dims(res.masters).ncols);
      toDomTable(table, res.masters);
      caretInCell(hit.aTd);
      commit();
    } else if (hit.action === 'split') {
      // Restore exactly this one boundary: split the merged cell in two. Content
      // stays in the first piece; the new piece starts empty. Fully reversible.
      const res = TG.splitMaster(fromDomTable(table), hit.masterTd, hit.orient, hit.at, () => newCell());
      if (!res.added.length) return;
      toDomTable(table, res.masters);
      caretInCell(hit.masterTd);
      commit();
    } else {
      hit.td.style[EDGE_PROP[hit.edge]] = hit.td.style[EDGE_PROP[hit.edge]] === 'hidden' ? '' : 'hidden';
      refreshErasedMarks(table);
      commit();
    }
  }

  /** Hidden outer edges of a cell (only outer edges are hide-able now). */
  function hiddenEdgesOf(td) {
    return ['t', 'r', 'b', 'l'].filter((e) => td.style[EDGE_PROP[e]] === 'hidden');
  }

  /**
   * Double-click a cell in Lines mode: split a merged cell back into a grid, or
   * (for a plain cell) restore any hidden outer borders around it.
   */
  function onTableDblClick(e) {
    if (!borderEdit || page.classList.contains('is-readonly')) return;
    const t = e.target;
    const td = t?.nodeType === 1 ? t.closest?.('td, th') : null;
    if (!td || !page.contains(td)) return;
    const table = td.closest('table.doc-table');
    if ((td.colSpan || 1) > 1 || (td.rowSpan || 1) > 1) {
      // Merged cell → unmerge it back into individual cells.
      e.preventDefault();
      const u = TG.unmergeAt(fromDomTable(table), td, () => newCell());
      toDomTable(table, u.masters);
      caretInCell(td);
      commit();
      return;
    }
    const edges = hiddenEdgesOf(td);
    if (!edges.length) return; // nothing to restore — leave word-select alone
    e.preventDefault();
    for (const edge of edges) td.style[EDGE_PROP[edge]] = '';
    refreshErasedMarks(table);
    commit();
  }

  function colgroupFor(table) {
    const rows = realRows(table);
    const nCols = Math.max(1, ...rows.map((r) => r.cells.length));
    let cg = table.querySelector('colgroup');
    if (!cg) {
      cg = document.createElement('colgroup');
      table.insertBefore(cg, table.firstChild);
    }
    while (cg.children.length < nCols) cg.appendChild(document.createElement('col'));
    while (cg.children.length > nCols) cg.lastChild.remove();
    // Seed any unset column from its current on-screen share so dragging is smooth.
    const firstRow = rows[0];
    const total = table.getBoundingClientRect().width || 1;
    Array.from(cg.children).forEach((col, i) => {
      if (!col.style.width && firstRow?.cells[i]) {
        const w = firstRow.cells[i].getBoundingClientRect().width;
        col.style.width = `${(w / total * 100).toFixed(3)}%`;
      }
    });
    return cg;
  }

  // How near the pointer must be to a line to grab it (generous so thin, or even
  // erased, grid lines are still easy to hit).
  const GRAB = 6;

  /** The resizable line nearest the pointer: a column boundary or a row boundary. */
  function resizeTargetAt(e) {
    if (page.classList.contains('is-readonly')) return null;
    const t = e.target;
    const td = t?.nodeType === 1 ? t.closest?.('td, th') : null;
    const table = td?.closest?.('table.doc-table');
    if (!td || !table || !page.contains(table)) return null;
    const rect = td.getBoundingClientRect();
    const rows = realRows(table);
    const tr = td.closest('tr');
    const ri = rows.indexOf(tr);
    const ci = td.cellIndex;
    const nCols = rows[0]?.cells.length || 0;
    const c = [];
    if (Math.abs(e.clientX - rect.right) <= GRAB && ci < nCols - 1) c.push(['col', Math.abs(e.clientX - rect.right), ci]);
    if (Math.abs(e.clientX - rect.left) <= GRAB && ci > 0) c.push(['col', Math.abs(e.clientX - rect.left), ci - 1]);
    if (Math.abs(e.clientY - rect.bottom) <= GRAB) c.push(['row', Math.abs(e.clientY - rect.bottom), ri]);
    if (Math.abs(e.clientY - rect.top) <= GRAB && ri > 0) c.push(['row', Math.abs(e.clientY - rect.top), ri - 1]);
    if (!c.length) return null;
    c.sort((a, b) => a[1] - b[1]);
    return { table, axis: c[0][0], index: c[0][2] };
  }

  function onTablePointerMove(e) {
    if (colResize || rowResize) return;
    if (borderEdit) {
      const hit = lineHitAt(e);
      page.style.cursor = hit ? 'pointer' : '';
      showLineHighlight(hit);
      return;
    }
    const hit = resizeTargetAt(e);
    page.style.cursor = hit ? (hit.axis === 'col' ? 'col-resize' : 'row-resize') : '';
  }
  const onTablePointerLeave = () => { edgeHi.hidden = true; };

  function onTablePointerDown(e) {
    // Line-editing mode: click an inner line to merge (remove it) or, inside a
    // merged cell, to split it back (restore it); an outer line toggles paint.
    if (borderEdit) {
      const hit = lineHitAt(e);
      if (hit) { e.preventDefault(); handleLineClick(hit); }
      return;
    }
    const hit = resizeTargetAt(e);
    if (!hit) return;
    e.preventDefault(); // don't start a text selection
    if (hit.axis === 'col') startColResize(hit, e);
    else startRowResize(hit, e);
  }

  /* ---- column width (drag a vertical line) ---- */
  function startColResize(hit, e) {
    const cg = colgroupFor(hit.table);
    const cols = Array.from(cg.children);
    colResize = {
      cols, li: hit.index, ri: hit.index + 1,
      startX: e.clientX,
      total: hit.table.getBoundingClientRect().width || 1,
      wl: parseFloat(cols[hit.index].style.width) || 0,
      wr: parseFloat(cols[hit.index + 1].style.width) || 0,
    };
    try { page.setPointerCapture(e.pointerId); } catch { /* not captured */ }
    window.addEventListener('pointermove', onColResizeMove);
    window.addEventListener('pointerup', onColResizeUp, { once: true });
  }

  function onColResizeMove(e) {
    if (!colResize) return;
    const r = colResize;
    const dPct = ((e.clientX - r.startX) / r.total) * 100;
    const min = (24 / r.total) * 100; // never shrink a column below ~24px
    let nl = r.wl + dPct;
    let nr = r.wr - dPct;
    if (nl < min) { nr -= (min - nl); nl = min; }
    if (nr < min) { nl -= (min - nr); nr = min; }
    r.cols[r.li].style.width = `${nl.toFixed(3)}%`;
    r.cols[r.ri].style.width = `${nr.toFixed(3)}%`;
    updateTableTools();
  }

  function onColResizeUp() {
    window.removeEventListener('pointermove', onColResizeMove);
    page.style.cursor = '';
    if (colResize) { colResize = null; commit(); updateTableTools(); }
  }

  /* ---- row height (drag a horizontal line) ---- */
  function startRowResize(hit, e) {
    const tr = realRows(hit.table)[hit.index];
    if (!tr) return;
    rowResize = { tr, startY: e.clientY, startH: tr.getBoundingClientRect().height || 20 };
    try { page.setPointerCapture(e.pointerId); } catch { /* not captured */ }
    window.addEventListener('pointermove', onRowResizeMove);
    window.addEventListener('pointerup', onRowResizeUp, { once: true });
  }

  function onRowResizeMove(e) {
    if (!rowResize) return;
    const h = Math.max(20, Math.round(rowResize.startH + (e.clientY - rowResize.startY)));
    rowResize.tr.style.height = `${h}px`;
    // Cells honour a row height via their own height (some engines ignore tr).
    for (const td of rowResize.tr.cells) td.style.height = `${h}px`;
    updateTableTools();
  }

  function onRowResizeUp() {
    window.removeEventListener('pointermove', onRowResizeMove);
    page.style.cursor = '';
    if (rowResize) { rowResize = null; commit(); updateTableTools(); }
  }

  function insertImage(src, width) {
    const fig = document.createElement('figure');
    fig.className = 'doc-block doc-image';
    fig.contentEditable = 'false';
    const img = document.createElement('img');
    img.src = src;
    if (width) img.style.width = `${width}px`;
    img.draggable = false;
    fig.appendChild(img);
    insertBlock(fig, null);
    // Select the freshly inserted image so its resize handles are ready, and
    // re-flow once it has real height (so it can push to the next page).
    img.addEventListener('load', () => { selectImage(fig); schedulePaginate(); }, { once: true });
    selectImage(fig);
  }

  /* ------------------------------- shapes ------------------------------- */
  // A shape is an <img> whose src is a baked SVG, PLUS its parameters kept on the
  // figure as data-* so it stays recolourable (regenerate the SVG on change) and
  // round-trips through the model (see editableHtml readImage/imageToEl). This
  // reuses the whole image pipeline: float/drag/resize, save/load and export.
  function insertShape({ id, fill = '#4472C4', stroke = '#2F528F', strokeWidth = 2, opacity = 1, width = 180 } = {}) {
    if (!id) return;
    const fig = document.createElement('figure');
    fig.className = 'doc-block doc-image doc-shape';
    fig.contentEditable = 'false';
    fig.dataset.shapeId = id;
    fig.dataset.fill = fill;
    fig.dataset.stroke = stroke;
    fig.dataset.strokeWidth = String(strokeWidth);
    fig.dataset.opacity = String(opacity);
    const img = document.createElement('img');
    img.src = shapeSrc(fig);
    img.style.width = `${width}px`;
    img.draggable = false;
    fig.appendChild(img);
    insertBlock(fig, null);
    img.addEventListener('load', () => { selectImage(fig); schedulePaginate(); }, { once: true });
    selectImage(fig);
  }

  const shapeParams = (fig) => ({
    id: fig.dataset.shapeId,
    fill: fig.dataset.fill || '#4472C4',
    stroke: fig.dataset.stroke || '#2F528F',
    strokeWidth: parseFloat(fig.dataset.strokeWidth) || 2,
    opacity: fig.dataset.opacity != null ? parseFloat(fig.dataset.opacity) : 1,
  });
  function shapeSrc(fig) {
    const p = shapeParams(fig);
    const svg = shapeSvg(p.id, { width: 200, height: 150, fill: p.fill, stroke: p.stroke, strokeWidth: p.strokeWidth, opacity: p.opacity });
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }
  /** Update a shape figure's colours/opacity live (regenerates the baked SVG).
   *  Pass commit=true to snapshot for undo (discrete picks); false while dragging
   *  the opacity slider (a single commit lands on release). */
  function styleShape(fig, patch, doCommit = true) {
    if (!fig || !fig.dataset.shapeId) return;
    if (patch.fill != null) fig.dataset.fill = patch.fill;
    if (patch.stroke != null) fig.dataset.stroke = patch.stroke;
    if (patch.strokeWidth != null) fig.dataset.strokeWidth = String(patch.strokeWidth);
    if (patch.opacity != null) fig.dataset.opacity = String(patch.opacity);
    const img = fig.querySelector('img');
    if (img) img.src = shapeSrc(fig);
    if (doCommit) commit();
  }

  /* ---- arrange / duplicate / delete ---- */
  function figZ() { return Array.from(page.querySelectorAll('.doc-image')).map((f) => parseInt(f.style.zIndex, 10) || 0); }
  function bringToFront(fig) { fig.style.zIndex = String(Math.max(3, ...figZ()) + 1); commit(); }
  function sendToBack(fig) { fig.style.zIndex = String(Math.min(0, ...figZ()) - 1); commit(); }
  function duplicateFigure(fig) {
    const clone = fig.cloneNode(true);
    clone.querySelector(':scope > .doc-imgsel')?.remove();
    clone.classList.remove('is-selected');
    clone.dataset.blockId = `img-${Math.random().toString(36).slice(2, 9)}`; // avoid a duplicate id
    if (clone.classList.contains('is-floating')) {
      clone.style.left = `${(parseFloat(clone.style.left) || 0) + 16}px`;
      clone.style.top = `${(parseFloat(clone.style.top) || 0) + 16}px`;
    }
    fig.after(clone);
    ensureTrailingParagraph();
    commit();
    selectImage(clone);
    schedulePaginate();
  }
  function deleteFigure(fig) { deselectImage(); fig.remove(); ensureTrailingParagraph(); commit(); schedulePaginate(); }

  /* ---------------------------- shape context menu ---------------------- */
  // A polished, shape-aware right-click menu (replaces the browser default on an
  // inserted shape/image): Fill / Border for filled shapes, Line for connectors,
  // an opacity slider, and arrange / duplicate / delete — all undoable.
  const SWATCHES = [
    '#FFFFFF', '#000000', '#F3F4F6', '#D1D5DB', '#9CA3AF', '#6B7280', '#374151',
    '#EF4444', '#F97316', '#FACC15', '#22C55E', '#2563EB', '#8B5CF6', '#EC4899',
  ];
  let shapeMenu = null;
  function closeShapeMenu() {
    if (!shapeMenu) return;
    shapeMenu.remove();
    shapeMenu = null;
    document.removeEventListener('pointerdown', onDocDownForMenu, true);
    document.removeEventListener('keydown', onKeyForMenu, true);
  }
  function onDocDownForMenu(e) { if (shapeMenu && !shapeMenu.contains(e.target)) closeShapeMenu(); }
  function onKeyForMenu(e) { if (e.key === 'Escape') { e.stopPropagation(); closeShapeMenu(); } }

  /** A collapsible colour control (fill / border / line). Applies immediately. */
  function colorControl(fig, label, kind) {
    const cur = () => shapeParams(fig)[kind];
    const dot = el('span', { class: 'doc-cmenu__dot', style: swatchStyle(cur()) });
    const panel = el('div', { class: 'doc-colorpanel', hidden: true });
    const row = el('button', {
      class: 'doc-cmenu__item doc-cmenu__item--color', type: 'button',
      onClick: () => {
        const open = panel.hidden;
        shapeMenu.querySelectorAll('.doc-colorpanel').forEach((p) => { p.hidden = true; });
        panel.hidden = !open;
      },
    }, [el('span', { class: 'doc-cmenu__lbl' }, label), dot, el('span', { class: 'doc-cmenu__arrow' }, '▸')]);

    const grid = el('div', { class: 'doc-colorpanel__grid' },
      SWATCHES.map((c) => el('button', {
        class: 'doc-colorpanel__sw', type: 'button', title: c, style: swatchStyle(c),
        onClick: () => { styleShape(fig, { [kind]: c }, true); dot.setAttribute('style', swatchStyle(c)); hex.value = c; },
      })));
    const transp = el('button', {
      class: 'doc-colorpanel__transparent', type: 'button',
      onClick: () => { styleShape(fig, { [kind]: 'none' }, true); dot.setAttribute('style', swatchStyle('none')); },
    }, 'Transparent');
    const native = el('input', {
      type: 'color', class: 'doc-colorpanel__native', value: /^#/.test(cur()) ? cur() : '#2563eb',
      onInput: (e) => { styleShape(fig, { [kind]: e.target.value }, false); dot.setAttribute('style', swatchStyle(e.target.value)); hex.value = e.target.value.toUpperCase(); },
      onChange: () => commit(),
    });
    const hex = el('input', {
      type: 'text', class: 'doc-colorpanel__hex', spellcheck: false, value: /^#/.test(cur()) ? cur().toUpperCase() : '',
      placeholder: '#2563EB', maxLength: 7,
      onInput: (e) => {
        let v = e.target.value.trim(); if (v && v[0] !== '#') v = `#${v}`;
        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) { styleShape(fig, { [kind]: v }, false); dot.setAttribute('style', swatchStyle(v)); native.value = v.length === 4 ? v : v; }
      },
      onChange: () => commit(),
      onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } },
    });
    panel.append(
      grid, transp,
      el('div', { class: 'doc-colorpanel__custom' }, [el('span', { class: 'doc-colorpanel__custom-lbl' }, 'Custom'), native, hex]),
    );
    return el('div', { class: 'doc-cmenu__color' }, [row, panel]);
  }

  function openShapeMenu(fig, x, y) {
    closeShapeMenu();
    const isShape = !!fig.dataset.shapeId;
    const filled = isShape && shapeHasFill(fig.dataset.shapeId);
    const items = [el('div', { class: 'doc-cmenu__title' }, isShape ? 'Shape' : 'Image')];

    if (isShape && filled) {
      items.push(colorControl(fig, 'Fill Color', 'fill'), colorControl(fig, 'Border Color', 'stroke'));
    } else if (isShape) {
      items.push(colorControl(fig, 'Line Color', 'stroke'));
    }
    if (isShape) {
      const val = Math.round((shapeParams(fig).opacity ?? 1) * 100);
      const slider = el('input', {
        type: 'range', min: '10', max: '100', value: String(val), class: 'doc-cmenu__slider',
        onInput: (e) => { pct.textContent = `${e.target.value}%`; styleShape(fig, { opacity: (+e.target.value) / 100 }, false); },
        onChange: () => commit(),
      });
      const pct = el('span', { class: 'doc-cmenu__pct' }, `${val}%`);
      items.push(el('div', { class: 'doc-cmenu__opacity' }, [el('span', { class: 'doc-cmenu__lbl' }, 'Opacity'), slider, pct]));
    }
    items.push(el('div', { class: 'doc-cmenu__sep' }));
    const action = (label, fn) => el('button', {
      class: 'doc-cmenu__item', type: 'button',
      onClick: () => { closeShapeMenu(); fn(); },
    }, label);
    items.push(
      action('Bring to Front', () => bringToFront(fig)),
      action('Send to Back', () => sendToBack(fig)),
      action('Duplicate', () => duplicateFigure(fig)),
      action('Delete', () => deleteFigure(fig)),
    );
    // Text wrapping — lets the user place the image/shape without covering text
    // (wrap left/right reflow the words around it; behind keeps text on top).
    items.push(el('div', { class: 'doc-cmenu__sep' }));
    items.push(el('div', { class: 'doc-cmenu__grouplbl' }, 'Text wrapping'));
    const wrapItem = (label, mode) => el('button', {
      class: `doc-cmenu__item${currentWrap(fig) === mode ? ' is-active' : ''}`, type: 'button',
      onClick: () => { closeShapeMenu(); setWrap(fig, mode); selectImage(fig); },
    }, label);
    items.push(
      wrapItem('In line with text', 'inline'),
      wrapItem('Wrap text — left', 'left'),
      wrapItem('Wrap text — right', 'right'),
      wrapItem('Behind text', 'behind'),
      wrapItem('In front of text', 'front'),
    );

    shapeMenu = el('div', {
      class: 'doc-cmenu', role: 'menu',
      onContextmenu: (e) => e.preventDefault(),
      onPointerdown: (e) => e.stopPropagation(),
    }, items);
    document.body.appendChild(shapeMenu);
    // Clamp inside the viewport (reposition off the bottom/right edges).
    const mw = shapeMenu.offsetWidth || 220;
    const mh = shapeMenu.offsetHeight || 300;
    shapeMenu.style.left = `${Math.round(Math.min(x, window.innerWidth - mw - 8))}px`;
    shapeMenu.style.top = `${Math.round(Math.min(y, window.innerHeight - mh - 8))}px`;
    document.addEventListener('pointerdown', onDocDownForMenu, true);
    document.addEventListener('keydown', onKeyForMenu, true);
  }

  const swatchStyle = (c) => c === 'none'
    ? 'background:conic-gradient(#fff 0 25%,#e5e7eb 0 50%,#fff 0 75%,#e5e7eb 0);background-size:8px 8px;'
    : `background:${c};`;

  /* ==================== Professional Library: charts ==================== */
  // A chart is a doc-image figure (so it reuses move/resize/z-order/duplicate/
  // delete/undo/pagination/save/export) carrying its editable spec on data-chart.
  // A chart-specific toolbar + right-click menu drive Edit Data / Chart Type /
  // Colours / Elements / Format / 3D / Arrange. Wholly separate from Shapes.
  const CHART_DEFAULT_W = 480;
  let chartTools = null;
  let chartToolsFig = null;
  let chartPopover = null;
  let chartMenu = null;
  let chartDataPanel = null;
  let pointInput = null; // inline editor for a per-point custom label

  // Uncropped data URL — the fallback when content measurement isn't available.
  const chartSvgUrlOf = (chart) =>
    `data:image/svg+xml,${encodeURIComponent(renderChartSvg(chart, { width: chart.width, height: chart.height }))}`;

  /* ---- content-fit: an inserted chart's bounds hug the actual graphic ---- *
   * A chart SVG is a fixed canvas with the graphic (e.g. a centred pie) filling
   * only part of it. We measure the real drawn content (getBBox on the render's
   * `.chart-content` group) and crop the SVG's viewBox to it, so the inserted
   * object — and therefore text wrapping, pagination and export — uses the tight
   * dimensions rather than a big empty box. This is generic: it works for EVERY
   * chart type off the actual geometry, with no per-type hardcoding.               */
  const CHART_FIT_PAD = 8;
  // A fixed reference canvas per TYPE (independent of the display size) keeps the
  // measured content box — and the fitted aspect ratio — stable across data edits
  // and resizes, so there's no shrink/grow feedback loop.
  function chartLayoutDims(chart) {
    const d = sampleChart(chart.type || 'pie');
    return { lw: Math.max(120, d.width || 480), lh: Math.max(100, d.height || 320) };
  }
  function measureChartBox(chart, lw, lh) {
    try {
      const str = renderChartSvg(chart, { width: lw, height: lh });
      const svg = new DOMParser().parseFromString(str, 'image/svg+xml').documentElement;
      if (!svg || svg.tagName === 'parsererror' || svg.getElementsByTagName('parsererror').length) return null;
      Object.assign(svg.style, { position: 'absolute', left: '-99999px', top: '0', width: `${lw}px`, height: `${lh}px`, visibility: 'hidden' });
      document.body.appendChild(svg);
      let box = null;
      try {
        const g = svg.querySelector('.chart-content') || svg;
        const b = g.getBBox();
        if (b && b.width > 0 && b.height > 0) box = { x: b.x, y: b.y, w: b.width, h: b.height };
      } catch { box = null; }
      svg.remove();
      return box;
    } catch { return null; }
  }
  /** Crop view + display size. `targetW` = desired object width (null → natural content px). */
  function fitChartView(chart, targetW) {
    const { lw, lh } = chartLayoutDims(chart);
    const box = measureChartBox(chart, lw, lh);
    if (!box || box.w < 8 || box.h < 8) return null;
    const pad = CHART_FIT_PAD;
    // Crop to the exact content box (+pad). Don't clamp the origin to 0 — a viewBox may
    // start at a negative coordinate, so anything drawn at/just past an edge stays fully
    // visible instead of having its leading edge sliced off.
    const x = box.x - pad, y = box.y - pad;
    const w = box.w + pad * 2, h = box.h + pad * 2;
    const dw = Math.max(40, Math.round(targetW || w));
    const dh = Math.max(1, Math.round(dw * (h / w)));
    return { lw, lh, view: { x, y, w, h }, dw, dh };
  }
  /** Fit `chart` to its content, sync the spec's width/height, and paint the img.
   *  `natural` sizes a freshly inserted chart to its true content px; otherwise the
   *  current display width is kept and the height re-derives from the aspect. */
  function applyChartRender(fig, chart, { natural = false } = {}) {
    const img = fig.querySelector('img');
    const fit = fitChartView(chart, natural ? null : chart.width);
    if (fit) {
      chart.width = fit.dw; chart.height = fit.dh;
      fig.dataset.chart = JSON.stringify(chart);
      if (img) {
        img.src = `data:image/svg+xml,${encodeURIComponent(renderChartSvg(chart, { width: fit.lw, height: fit.lh, view: fit.view, outW: fit.dw, outH: fit.dh }))}`;
        // Width drives the box; height follows the cropped SVG's intrinsic aspect, so
        // any inline height left over from a live resize drag must be cleared.
        img.style.width = `${fit.dw}px`;
        img.style.height = '';
      }
    } else {
      fig.dataset.chart = JSON.stringify(chart);
      if (img) { img.src = chartSvgUrlOf(chart); img.style.width = `${chart.width || CHART_DEFAULT_W}px`; img.style.height = ''; }
    }
  }

  function chartSpecOf(fig) {
    try { return normalizeChart(JSON.parse(fig.dataset.chart || '{}')); } catch { return normalizeChart({}); }
  }
  function setChartSpec(fig, spec, doCommit = true) {
    if (!fig || !fig.classList.contains('doc-chart') || !fig.isConnected) return;
    const chart = normalizeChart(spec);
    applyChartRender(fig, chart, { natural: false });
    if (doCommit) commit();
  }
  function mutateChart(fig, fn, doCommit = true) {
    const c = chartSpecOf(fig);
    fn(c);
    setChartSpec(fig, c, doCommit);
  }

  /** Insert a chart from the Professional Library as a real editable object. */
  function insertChart(spec) {
    const chart = normalizeChart(spec);
    const fig = document.createElement('figure');
    fig.className = 'doc-block doc-image doc-chart';
    fig.contentEditable = 'false';
    fig.dataset.chart = JSON.stringify(chart);
    fig.dataset.wrap = 'inline';
    const img = document.createElement('img');
    img.draggable = false;
    fig.appendChild(img);
    // Fit the fresh insert to its real content (natural size) so it lands as a tight
    // object, not a large empty canvas — for every chart type.
    applyChartRender(fig, chart, { natural: true });
    insertBlock(fig, null);
    img.addEventListener('load', () => { selectImage(fig); schedulePaginate(); }, { once: true });
    selectImage(fig);
  }

  /** On resize end, re-render the chart at the new width (aspect locked to the
   *  content, so the picture never stretches) and re-crop to its bounds. */
  function applyChartResize(fig, img) {
    const w = Math.round(img.getBoundingClientRect().width);
    if (!w) return;
    const c = chartSpecOf(fig);
    c.width = w;
    applyChartRender(fig, c, { natural: false });
  }

  /* --------------------------- text wrapping ----------------------------- *
   * Five modes, matching Word/Google Docs:
   *   inline  — a block image in the text flow (default).
   *   left    — floats left; text wraps down its right side.
   *   right   — floats right; text wraps down its left side.
   *   behind  — freely positioned, painted BEHIND the text (readable on top).
   *   front   — freely positioned, painted in front (can cover text).
   * left/right stay in the flow (real CSS float), so nothing is hidden; behind/
   * front are absolutely positioned so they can sit anywhere on the page.       */
  function currentWrap(fig) {
    if (fig.classList.contains('is-floating')) return fig.classList.contains('is-behind') ? 'behind' : 'front';
    if (fig.classList.contains('is-wrap-left')) return 'left';
    if (fig.classList.contains('is-wrap-right')) return 'right';
    return 'inline';
  }
  function setWrap(fig, mode) {
    // Clear every mode first, then apply the requested one — modes are exclusive.
    fig.classList.remove('is-floating', 'is-behind', 'is-wrap-left', 'is-wrap-right');
    fig.style.left = ''; fig.style.top = ''; fig.style.zIndex = '';
    if (mode === 'front' || mode === 'behind') {
      floatFigure(fig);
      if (mode === 'behind') { fig.classList.add('is-behind'); fig.style.zIndex = '-1'; }
      else fig.style.zIndex = String(Math.max(3, ...figZ()) + 1);
    } else if (mode === 'left' || mode === 'right') {
      fig.classList.add(mode === 'left' ? 'is-wrap-left' : 'is-wrap-right');
    } // inline: no extra class — the figure is a normal in-flow block.
    fig.dataset.wrap = mode;
    commit();
    schedulePaginate();
  }
  function stepZ(fig, dir) { fig.style.zIndex = String((parseInt(fig.style.zIndex, 10) || 0) + dir); commit(); }

  /* ---- chart toolbar (shown while a chart is selected) ---- */
  function buildChartTools() {
    const btn = (label, tip, fn, role) => el('button', {
      class: 'doc-charttools__btn', type: 'button', 'data-tip': tip, 'aria-label': tip,
      dataset: role ? { role } : {},
      onMousedown: (e) => e.preventDefault(),
      onClick: (e) => { e.stopPropagation(); fn(e.currentTarget); },
    }, label);
    const sep = () => el('span', { class: 'doc-charttools__sep' });
    chartTools = el('div', { class: 'doc-charttools', 'aria-label': 'Chart tools' }, [
      btn('Edit Data', 'Edit chart data', () => chartToolsFig && openDataEditor(chartToolsFig)),
      sep(),
      btn('Type ▾', 'Change chart type', (a) => togglePop(a, () => typePopover(chartToolsFig))),
      btn('Colors ▾', 'Colours & palette', (a) => togglePop(a, () => colorsPopover(chartToolsFig))),
      btn('Elements ▾', 'Chart elements', (a) => togglePop(a, () => elementsPopover(chartToolsFig))),
      btn('Format ▾', 'Format', (a) => togglePop(a, () => formatPopover(chartToolsFig))),
      btn('3D ▾', '3D & effects', (a) => togglePop(a, () => threeDPopover(chartToolsFig)), 'threeD'),
      sep(),
      btn('Arrange ▾', 'Arrange & wrap', (a) => togglePop(a, () => arrangePopover(chartToolsFig))),
    ]);
    chartTools.hidden = true;
    container.appendChild(chartTools);
  }
  function showChartTools(fig) {
    chartToolsFig = fig;
    if (!chartTools) buildChartTools();
    refreshChartToolsState(fig);
    chartTools.hidden = false;
    positionChartTools();
  }
  function hideChartTools() {
    if (chartTools) chartTools.hidden = true;
    closeChartPopover();
    closeChartMenu();
    closePointInput();
  }
  function refreshChartToolsState(fig) {
    if (!chartTools) return;
    const meta = TYPE_META[chartSpecOf(fig).type] || {};
    const is3d = !!(meta.d3 || meta.explode || meta.family === 'pie');
    const b3 = chartTools.querySelector('[data-role="threeD"]');
    if (b3) b3.hidden = !is3d;
  }
  function positionChartTools() {
    if (!chartTools || !chartToolsFig || chartTools.hidden) return;
    const rect = chartToolsFig.getBoundingClientRect();
    const h = chartTools.offsetHeight || 34;
    let top = rect.top - h - 6;
    if (top < 96) top = rect.bottom + 6;
    chartTools.style.top = `${Math.round(top)}px`;
    chartTools.style.left = `${Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - chartTools.offsetWidth - 8)))}px`;
  }

  /* ---- popovers ---- */
  function openChartPopoverAt(rect, node) {
    closeChartPopover();
    chartPopover = el('div', {
      class: 'doc-chartpop', role: 'menu',
      onMousedown: (e) => { if (!e.target.closest('input, select, button, textarea')) e.preventDefault(); },
      onPointerdown: (e) => e.stopPropagation(),
    }, node);
    document.body.appendChild(chartPopover);
    const mw = chartPopover.offsetWidth || 240;
    const mh = chartPopover.offsetHeight || 200;
    chartPopover.style.left = `${Math.round(Math.min(rect.left, window.innerWidth - mw - 8))}px`;
    let top = rect.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 6);
    chartPopover.style.top = `${Math.round(top)}px`;
    setTimeout(() => document.addEventListener('pointerdown', onChartPopOutside, true), 0);
  }
  function openChartPopover(anchor, node) { openChartPopoverAt(anchor.getBoundingClientRect(), node); if (chartPopover) chartPopover.__anchor = anchor; }
  function togglePop(anchor, builder) {
    if (chartPopover && chartPopover.__anchor === anchor) { closeChartPopover(); return; }
    openChartPopover(anchor, builder());
  }
  function onChartPopOutside(e) {
    if (chartPopover && (chartPopover.contains(e.target) || (chartTools && chartTools.contains(e.target)) || (chartMenu && chartMenu.contains(e.target)))) return;
    closeChartPopover();
  }
  function closeChartPopover() {
    if (!chartPopover) return;
    chartPopover.remove(); chartPopover = null;
    document.removeEventListener('pointerdown', onChartPopOutside, true);
  }

  const popLabel = (t) => el('div', { class: 'doc-chartpop__lbl' }, t);
  function toHexColor(c) {
    if (/^#[0-9a-f]{6}$/i.test(c)) return c;
    if (/^#[0-9a-f]{3}$/i.test(c)) return `#${c.slice(1).split('').map((x) => x + x).join('')}`;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(c || '');
    if (m) { const h = (n) => (+n).toString(16).padStart(2, '0'); return `#${h(m[1])}${h(m[2])}${h(m[3])}`; }
    return '#4472C4';
  }

  function typePopover(fig) {
    const cur = chartSpecOf(fig).type;
    const wrap = el('div', { class: 'doc-chartpop__types' });
    for (const cat of CHART_CATALOG) {
      wrap.appendChild(el('div', { class: 'doc-chartpop__cat' }, cat.name));
      wrap.appendChild(el('div', { class: 'doc-chartpop__typegrid' }, cat.items.map((id) => el('button', {
        class: `doc-chartpop__type${cur === id ? ' is-active' : ''}`, type: 'button',
        onClick: () => { mutateChart(fig, (c) => { c.type = id; }, true); refreshChartToolsState(fig); closeChartPopover(); },
      }, chartTypeLabel(id)))));
    }
    return wrap;
  }

  function colorsPopover(fig) {
    const c = chartSpecOf(fig);
    const meta = TYPE_META[c.type] || {};
    const pieLike = PER_POINT_FAMILIES.includes(meta.family);
    const pal = PALETTES[c.options.palette] || PALETTES.office;
    const palettes = el('div', { class: 'doc-chartpop__palettes' }, PALETTE_IDS.map((pid) => el('button', {
      class: `doc-chartpop__pal${c.options.palette === pid ? ' is-active' : ''}`, type: 'button', title: pid,
      onClick: () => { mutateChart(fig, (cc) => { cc.options.palette = pid; }, true); if (chartPopover) chartPopover.replaceChildren(colorsPopover(fig)); },
    }, PALETTES[pid].slice(0, 5).map((col) => el('span', { class: 'doc-chartpop__paldot', style: `background:${col}` })))));
    const items = pieLike ? c.categories : c.series.map((s) => s.name);
    const list = el('div', { class: 'doc-chartpop__elems' }, items.map((label, i) => {
      const cur = pieLike ? (c.colors[i] || pal[i % pal.length]) : (c.series[i].color || pal[i % pal.length]);
      return el('label', { class: 'doc-chartpop__elem' }, [
        el('span', { class: 'doc-chartpop__elemname' }, label || (pieLike ? `Slice ${i + 1}` : `Series ${i + 1}`)),
        el('input', {
          type: 'color', class: 'doc-chartpop__elemcolor', value: toHexColor(cur),
          onInput: (e) => mutateChart(fig, (cc) => { if (pieLike) cc.colors[i] = e.target.value; else cc.series[i].color = e.target.value; }, false),
          onChange: () => mutateChart(fig, () => {}, true),
        }),
      ]);
    }));
    return el('div', { class: 'doc-chartpop__colors' }, [popLabel('Color palette'), palettes, popLabel(pieLike ? 'Slice colors' : 'Series colors'), list]);
  }

  function elementsPopover(fig) {
    const c = chartSpecOf(fig);
    const o = c.options;
    const meta = TYPE_META[c.type] || {};
    const cartesian = ['bar', 'line', 'area', 'scatter', 'combo', 'waterfall', 'candlestick', 'pareto', 'histogram', 'boxplot', 'gantt', 'timeline', 'matrix'].includes(meta.family);
    // Each control is an INDEPENDENT visibility toggle; hiding one reclaims its layout
    // space and re-showing restores it. The chart geometry (incl. 3D) is unaffected.
    const check = (key, label) => el('label', { class: 'doc-chartpop__check' }, [
      el('input', { type: 'checkbox', checked: o[key], onChange: (e) => mutateChart(fig, (cc) => { cc.options[key] = e.target.checked; }, true) }),
      el('span', {}, label),
    ]);
    const textRow = (label, get, set) => el('label', { class: 'doc-chartpop__row' }, [
      el('span', {}, label),
      el('input', { type: 'text', class: 'doc-chartpop__text', value: get(),
        onInput: (e) => mutateChart(fig, (cc) => set(cc, e.target.value), false), onChange: () => mutateChart(fig, () => {}, true) }),
    ]);
    const title = textRow('Title', () => c.title, (cc, v) => { cc.title = v; });
    const legendPos = el('label', { class: 'doc-chartpop__row' }, [
      el('span', {}, 'Legend position'),
      el('select', { class: 'doc-chartpop__sel', onChange: (e) => mutateChart(fig, (cc) => { cc.options.legendPos = e.target.value; }, true) },
        ['bottom', 'right', 'top'].map((p) => el('option', { value: p, selected: o.legendPos === p }, p[0].toUpperCase() + p.slice(1)))),
    ]);
    const rows = [
      popLabel('Chart elements'),
      title, check('showTitle', 'Chart Title'),
      check('showLegend', 'Legend'), legendPos,
      check('showCatLabels', 'Category Labels'),
      check('showDataLabels', 'Data Labels'), check('showPercentLabels', 'Percentage Labels'),
    ];
    if (cartesian) {
      rows.push(
        check('showAxis', 'Axis'),
        check('showAxisTitles', 'Axis Titles'),
        textRow('X-axis title', () => o.axisTitleX || '', (cc, v) => { cc.options.axisTitleX = v; }),
        textRow('Y-axis title', () => o.axisTitleY || '', (cc, v) => { cc.options.axisTitleY = v; }),
        check('showGridlines', 'Gridlines'),
      );
    }
    return el('div', { class: 'doc-chartpop__col' }, rows);
  }

  function formatPopover(fig) {
    const c = chartSpecOf(fig);
    const o = c.options;
    const colorRow = (key, label, def) => el('label', { class: 'doc-chartpop__row' }, [
      el('span', {}, label),
      el('input', { type: 'color', value: toHexColor(o[key] || def),
        onInput: (e) => mutateChart(fig, (cc) => { cc.options[key] = e.target.value; }, false), onChange: () => mutateChart(fig, () => {}, true) }),
    ]);
    const range = (key, label, min, max, step, path) => el('label', { class: 'doc-chartpop__row' }, [
      el('span', {}, label),
      el('input', { type: 'range', min, max, step, value: path ? o[key] : o[key],
        onInput: (e) => mutateChart(fig, (cc) => { cc.options[key] = parseFloat(e.target.value); }, false), onChange: () => mutateChart(fig, () => {}, true) }),
    ]);
    const chk = (key, label) => el('label', { class: 'doc-chartpop__check' }, [
      el('input', { type: 'checkbox', checked: o[key], onChange: (e) => mutateChart(fig, (cc) => { cc.options[key] = e.target.checked; }, true) }),
      el('span', {}, label),
    ]);
    return el('div', { class: 'doc-chartpop__col' }, [
      colorRow('background', 'Background', '#ffffff'),
      colorRow('borderColor', 'Border color', '#e2e8f0'),
      range('borderWidth', 'Border width', '0', '4', '0.5'),
      chk('shadow', 'Shadow'), chk('gradient', 'Gradient'),
      range('opacity', 'Transparency', '0.2', '1', '0.05'),
    ]);
  }

  function threeDPopover(fig) {
    const meta = TYPE_META[chartSpecOf(fig).type] || {};
    const isPie = meta.family === 'pie';
    const slider = (key, label, min, max, step) => {
      const t = chartSpecOf(fig).options.threeD;
      return el('label', { class: 'doc-chartpop__row' }, [
        el('span', {}, label),
        el('input', { type: 'range', min, max, step, value: t[key],
          onInput: (e) => mutateChart(fig, (cc) => { cc.options.threeD[key] = parseFloat(e.target.value); }, false), onChange: () => mutateChart(fig, () => {}, true) }),
      ]);
    };
    const rows = [popLabel('3D & effects'), slider('depth', '3D depth', '0', '40', '1')];
    // Explode / rotation / spacing only affect pie-family charts.
    if (isPie) rows.push(
      slider('explode', 'Explode amount', '0', '1', '0.05'),
      slider('rotation', 'Rotation', '0', '360', '5'),
      slider('spacing', 'Slice spacing', '0', '1', '0.05'),
    );
    return el('div', { class: 'doc-chartpop__col' }, rows);
  }

  function arrangePopover(fig) {
    const item = (label, fn, active) => el('button', {
      class: `doc-chartpop__item${active ? ' is-active' : ''}`, type: 'button',
      onClick: () => { fn(); },
    }, label);
    return el('div', { class: 'doc-chartpop__col' }, [
      item('Bring to Front', () => { bringToFront(fig); closeChartPopover(); }),
      item('Send to Back', () => { sendToBack(fig); closeChartPopover(); }),
      item('Bring Forward', () => { stepZ(fig, 1); }),
      item('Send Backward', () => { stepZ(fig, -1); }),
      el('div', { class: 'doc-chartpop__sep' }),
      item('Duplicate', () => { closeChartPopover(); duplicateFigure(fig); }),
      item('Delete', () => { closeChartPopover(); deleteFigure(fig); }),
      el('div', { class: 'doc-chartpop__sep' }),
      popLabel('Text wrapping'),
      item('In line with text', () => setWrap(fig, 'inline'), currentWrap(fig) === 'inline'),
      item('Wrap text — left', () => setWrap(fig, 'left'), currentWrap(fig) === 'left'),
      item('Wrap text — right', () => setWrap(fig, 'right'), currentWrap(fig) === 'right'),
      item('Behind text', () => setWrap(fig, 'behind'), currentWrap(fig) === 'behind'),
      item('In front of text', () => setWrap(fig, 'front'), currentWrap(fig) === 'front'),
    ]);
  }

  /* ---- right-click chart menu ---- */
  function closeChartMenu() {
    if (!chartMenu) return;
    chartMenu.remove(); chartMenu = null;
    document.removeEventListener('pointerdown', onChartMenuOutside, true);
  }
  function onChartMenuOutside(e) {
    if (chartMenu && chartMenu.contains(e.target)) return;
    if (chartPopover && chartPopover.contains(e.target)) return;
    closeChartMenu();
  }
  function openChartMenu(fig, x, y) {
    closeChartMenu();
    const meta = TYPE_META[chartSpecOf(fig).type] || {};
    const is3d = !!(meta.d3 || meta.explode || meta.family === 'pie');
    const item = (label, fn) => el('button', {
      class: 'doc-cmenu__item', type: 'button',
      onMousedown: (e) => e.preventDefault(),
      onClick: (e) => { e.stopPropagation(); fn(e.currentTarget); },
    }, el('span', { class: 'doc-cmenu__label' }, label));
    const pop = (builder) => (a) => { const r = a.getBoundingClientRect(); closeChartMenu(); openChartPopoverAt(r, builder(fig)); };
    chartMenu = el('div', {
      class: 'doc-cmenu doc-chartmenu', role: 'menu',
      onContextmenu: (e) => e.preventDefault(), onPointerdown: (e) => e.stopPropagation(),
    }, [
      el('div', { class: 'doc-cmenu__title' }, 'Chart'),
      item('Edit Data…', () => { closeChartMenu(); openDataEditor(fig); }),
      item('Change Chart Type', pop(typePopover)),
      item('Colors & Palette', pop(colorsPopover)),
      item('Chart Elements', pop(elementsPopover)),
      item('Format', pop(formatPopover)),
      ...(is3d ? [item('3D & Effects', pop(threeDPopover))] : []),
      el('div', { class: 'doc-cmenu__sep' }),
      item('Bring to Front', () => { closeChartMenu(); bringToFront(fig); }),
      item('Send to Back', () => { closeChartMenu(); sendToBack(fig); }),
      item('Duplicate', () => { closeChartMenu(); duplicateFigure(fig); }),
      item('Delete', () => { closeChartMenu(); deleteFigure(fig); }),
    ]);
    document.body.appendChild(chartMenu);
    const mw = chartMenu.offsetWidth || 200;
    const mh = chartMenu.offsetHeight || 300;
    chartMenu.style.left = `${Math.round(Math.min(x, window.innerWidth - mw - 8))}px`;
    chartMenu.style.top = `${Math.round(Math.min(y, window.innerHeight - mh - 8))}px`;
    setTimeout(() => document.addEventListener('pointerdown', onChartMenuOutside, true), 0);
  }

  /* ---- data editor ---- */
  function closeChartDataPanel() { if (chartDataPanel) { chartDataPanel.close(); chartDataPanel = null; } }
  function openDataEditor(fig) {
    closeChartDataPanel();
    chartDataPanel = openChartDataEditor({
      chart: chartSpecOf(fig),
      onPreview: (spec) => setChartSpec(fig, spec, false),
      onCommit: (spec) => setChartSpec(fig, spec, true),
      onClose: () => { chartDataPanel = null; },
    });
  }

  /* ---- per-point labels: double-click a bar/slice/point to type text on it ---- */
  // Re-render into a hotspots collector to learn each data point's click target (in
  // SVG coords), then map the click there. Same ONE model — no per-type handling.
  function chartHotspotsOf(fig) {
    const c = chartSpecOf(fig);
    const { lw, lh } = chartLayoutDims(c);
    // Hotspots are recorded in the LAYOUT coordinate space (the same space the crop
    // view is expressed in), so clicks map through the cropped viewBox below.
    const hot = [];
    renderChartSvg(c, { width: lw, height: lh, hotspots: hot });
    return { c, hot, fit: fitChartView(c, c.width) };
  }
  function openPointLabelEditor(fig, clientX, clientY) {
    const img = fig.querySelector('img');
    if (!img) return;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const { hot, fit } = chartHotspotsOf(fig);
    if (!hot.length || !fit) return;
    // click (screen) → layout SVG coords, accounting for the cropped view rectangle.
    const v = fit.view;
    const lx = v.x + (clientX - rect.left) / rect.width * v.w;
    const ly = v.y + (clientY - rect.top) / rect.height * v.h;
    let best = null, bestD = Infinity;
    for (const h of hot) { const d = (h.x - lx) ** 2 + (h.y - ly) ** 2; if (d < bestD) { bestD = d; best = h; } }
    if (!best || bestD > 90 * 90) return; // clicked too far from any data point
    const screenX = rect.left + (best.x - v.x) / v.w * rect.width;
    const screenY = rect.top + (best.y - v.y) / v.h * rect.height;
    showPointInput(fig, best.id, screenX, screenY);
  }
  function showPointInput(fig, id, screenX, screenY) {
    closePointInput();
    const c = chartSpecOf(fig);
    const cur = (c.pointLabels && c.pointLabels[id]) || '';
    const input = el('input', {
      class: 'doc-chartlabel-input', type: 'text', value: cur, placeholder: 'Label…',
      onInput: (e) => mutateChart(fig, (cc) => {
        if (!cc.pointLabels || typeof cc.pointLabels !== 'object') cc.pointLabels = {};
        if (e.target.value) cc.pointLabels[id] = e.target.value; else delete cc.pointLabels[id];
      }, false),
      onKeydown: (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commitPointInput(fig); }
        else if (e.key === 'Escape') { e.preventDefault(); closePointInput(); }
      },
      onBlur: () => commitPointInput(fig),
      onPointerdown: (e) => e.stopPropagation(),
    });
    pointInput = input;
    document.body.appendChild(input);
    input.style.left = `${Math.round(screenX - input.offsetWidth / 2)}px`;
    input.style.top = `${Math.round(screenY - input.offsetHeight / 2)}px`;
    input.focus();
    input.select();
  }
  function commitPointInput(fig) {
    if (!pointInput) return;
    mutateChart(fig, () => {}, true); // snapshot for undo
    closePointInput();
  }
  function closePointInput() {
    if (pointInput) { pointInput.remove(); pointInput = null; }
  }
  function onChartDblClick(e) {
    const fig = e.target.closest && e.target.closest('.doc-chart');
    if (!fig) return;
    e.preventDefault(); e.stopPropagation();
    selectImage(fig);
    openPointLabelEditor(fig, e.clientX, e.clientY);
  }

  /* --------------------------- image handles ---------------------------- */
  // Click an image to select it; drag a corner handle to resize (keeping aspect
  // ratio); Delete removes it. Handles live in a non-editable overlay inside the
  // figure and are stripped from history snapshots so they never reach the model.
  function selectImage(fig) {
    if (imgSel === fig) return;
    deselectImage();
    imgSel = fig;
    fig.classList.add('is-selected');
    const img = fig.querySelector('img');
    const overlay = document.createElement('div');
    overlay.className = 'doc-imgsel';
    overlay.contentEditable = 'false';
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      const h = document.createElement('div');
      h.className = `doc-imgsel__h doc-imgsel__h--${corner}`;
      h.addEventListener('pointerdown', (e) => startImageResize(e, fig, img, corner, h));
      overlay.appendChild(h);
    }
    fig.appendChild(overlay);
    // Professional Library charts show a chart-specific toolbar while selected.
    if (fig.classList.contains('doc-chart')) showChartTools(fig); else hideChartTools();
  }

  function deselectImage() {
    if (!imgSel) return;
    imgSel.classList.remove('is-selected');
    imgSel.querySelector(':scope > .doc-imgsel')?.remove();
    imgSel = null;
    hideChartTools();
  }

  /** Remove any stray selection overlays (e.g. after an undo restored them). */
  function stripImgSel() {
    page.querySelectorAll('.doc-imgsel').forEach((o) => o.remove());
    page.querySelectorAll('.doc-image.is-selected').forEach((f) => f.classList.remove('is-selected'));
    page.querySelectorAll('.doc-posbox--selected').forEach((b) => b.classList.remove('doc-posbox--selected'));
    imgSel = null; boxSel = null;
  }

  /* ---------------- positioned text-box: select, resize, opacity ----------------
   * In a positioned (exact-layout) doc, right-clicking a `.doc-posbox` selects it as
   * an OBJECT (corner resize handles + a context menu to resize / set the box's
   * background opacity / delete). A normal click still edits the text. The text
   * itself always stays fully solid — only the box BACKGROUND fades (rgba), never CSS
   * opacity. Reuses the image selection overlay/handles (`.doc-imgsel`). */
  let boxSel = null;
  function selectBox(box) {
    if (boxSel === box) return;
    deselectBox();
    deselectImage();
    boxSel = box;
    box.classList.add('doc-posbox--selected');
    box.dataset.wasEditable = box.getAttribute('contenteditable') || 'true';
    box.contentEditable = 'false'; // so a handle drag never drops a caret / edits text
    const overlay = document.createElement('div');
    overlay.className = 'doc-imgsel';
    overlay.contentEditable = 'false';
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      const h = document.createElement('div');
      h.className = `doc-imgsel__h doc-imgsel__h--${corner}`;
      h.addEventListener('pointerdown', (e) => startBoxResize(e, box, corner, h));
      overlay.appendChild(h);
    }
    box.appendChild(overlay);
  }
  function deselectBox() {
    if (!boxSel) return;
    const b = boxSel;
    boxSel = null;
    closeBoxMenu();
    b.classList.remove('doc-posbox--selected');
    b.querySelector(':scope > .doc-imgsel')?.remove();
    b.contentEditable = b.dataset.wasEditable || 'true';
    delete b.dataset.wasEditable;
  }
  function startBoxResize(e, box, corner, handle) {
    e.preventDefault();
    e.stopPropagation();
    const z = zoom || 1;
    const sx = e.clientX, sy = e.clientY;
    const rect = box.getBoundingClientRect();
    const w0 = parseFloat(box.style.width) || rect.width / z;
    const h0 = parseFloat(box.style.minHeight) || rect.height / z;
    const x0 = parseFloat(box.style.left) || 0;
    const top0 = parseFloat(box.style.top) || 0;
    const y0 = parseFloat(box.dataset.y) || 0;
    const west = corner === 'nw' || corner === 'sw';
    const north = corner === 'nw' || corner === 'ne';
    const cs = getComputedStyle(page);
    const maxW = Math.max(40, page.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0));
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const onMove = (ev) => {
      const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
      let w = w0, h = h0, x = x0, top = top0, y = y0;
      if (west) { w = Math.max(40, Math.min(maxW, w0 - dx)); x = x0 + (w0 - w); } else { w = Math.max(40, Math.min(maxW, w0 + dx)); }
      if (north) { h = Math.max(14, h0 - dy); top = top0 + (h0 - h); y = y0 + (h0 - h); } else { h = Math.max(14, h0 + dy); }
      box.style.width = `${Math.round(w)}px`;
      box.style.minHeight = `${Math.round(h)}px`;
      box.style.left = `${Math.round(x)}px`;
      box.style.top = `${Math.round(top)}px`;
      box.dataset.w = String(Math.round(w)); box.dataset.h = String(Math.round(h));
      box.dataset.x = String(Math.round(x)); box.dataset.y = String(Math.round(y));
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      commit(); // persist the new frame (readPosbox reads style/dataset back)
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  }

  /** Fade/solid a box's BACKGROUND (rgba) without touching the text. Ensures the box
   *  carries a base fill colour so the change round-trips through readPosbox. */
  function applyBoxOpacity(box, a) {
    const alpha = Math.max(0, Math.min(1, a));
    const base = (box.dataset.fill || 'ffffff').replace(/^#/, '');
    box.dataset.fill = base;
    box.dataset.opacity = String(alpha);
    if (alpha >= 0.999) box.style.background = `#${base}`;
    else if (alpha <= 0.001) box.style.background = 'transparent';
    else {
      const r = parseInt(base.slice(0, 2), 16) || 0, g = parseInt(base.slice(2, 4), 16) || 0, b = parseInt(base.slice(4, 6), 16) || 0;
      box.style.background = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }

  let boxMenu = null;
  function closeBoxMenu() {
    if (!boxMenu) return;
    boxMenu.remove(); boxMenu = null;
    document.removeEventListener('pointerdown', onDocDownForBoxMenu, true);
  }
  function onDocDownForBoxMenu(e) {
    if (boxMenu && !boxMenu.contains(e.target) && !(boxSel && boxSel.contains(e.target))) closeBoxMenu();
  }
  function openBoxMenu(box, x, y) {
    closeBoxMenu();
    const cur = (box.dataset.opacity != null && box.dataset.opacity !== '')
      ? Math.round(parseFloat(box.dataset.opacity) * 100)
      : (box.dataset.fill ? 100 : 0);
    const pct = el('span', { class: 'doc-cmenu__pct' }, `${cur}%`);
    const slider = el('input', {
      type: 'range', min: '0', max: '100', value: String(cur), class: 'doc-cmenu__slider',
      onInput: (e) => { pct.textContent = `${e.target.value}%`; applyBoxOpacity(box, (+e.target.value) / 100); },
      onChange: () => commit(),
    });
    const action = (label, fn) => el('button', { class: 'doc-cmenu__item', type: 'button', onClick: () => { closeBoxMenu(); fn(); } }, label);
    const items = [
      el('div', { class: 'doc-cmenu__title' }, 'Text box'),
      el('div', { class: 'doc-cmenu__opacity' }, [el('span', { class: 'doc-cmenu__lbl' }, 'Box opacity'), slider, pct]),
      el('div', { class: 'doc-cmenu__sep' }),
      action('Make transparent', () => { applyBoxOpacity(box, 0); commit(); }),
      action('Solid background', () => { applyBoxOpacity(box, 1); commit(); }),
      el('div', { class: 'doc-cmenu__sep' }),
      el('div', { class: 'doc-cmenu__grouplbl' }, 'Drag the corner handles to resize'),
      action('Delete box', () => { const b = boxSel; deselectBox(); b?.remove(); commit(); }),
    ];
    boxMenu = el('div', {
      class: 'doc-cmenu', role: 'menu',
      onContextmenu: (e) => e.preventDefault(),
      onPointerdown: (e) => e.stopPropagation(),
    }, items);
    document.body.appendChild(boxMenu);
    const mw = boxMenu.offsetWidth || 220, mh = boxMenu.offsetHeight || 220;
    boxMenu.style.left = `${Math.round(Math.min(x, window.innerWidth - mw - 8))}px`;
    boxMenu.style.top = `${Math.round(Math.min(y, window.innerHeight - mh - 8))}px`;
    setTimeout(() => document.addEventListener('pointerdown', onDocDownForBoxMenu, true), 0);
  }

  function startImageResize(e, fig, img, corner, handle) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = img.getBoundingClientRect().width;
    const startH = img.getBoundingClientRect().height;
    const aspect = startH > 0 ? startW / startH : 1;
    // Grow up to the page's usable content width (the figure itself shrink-wraps
    // the image, so it can't be the cap).
    const cs = getComputedStyle(page);
    const maxW = Math.max(48, page.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0));
    const grows = corner === 'ne' || corner === 'se'; // east corners grow with +dx
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    fig.classList.add('is-resizing');
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const w = Math.max(48, Math.min(maxW, startW + (grows ? dx : -dx)));
      img.style.width = `${Math.round(w)}px`;
      img.style.height = `${Math.round(w / aspect)}px`;
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      fig.classList.remove('is-resizing');
      // A chart re-renders its SVG at the new size so it stays crisp (and the new
      // width/height persist in its spec).
      if (fig.classList.contains('doc-chart')) applyChartResize(fig, img);
      commit(); // persist the new size (readImage reads it back into the model)
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  }

  /* ---------------------------- image move ------------------------------ */
  // Drag the image body to freely position it on the page (Google-Docs "in front
  // of text" style). The first real movement lifts the figure out of the text
  // flow into absolute positioning at its current spot, then it follows the
  // pointer. A press that never travels stays a plain select. Corner-handle drags
  // stopPropagation, so resizing never reaches this.

  /** Lift a still-inline figure into absolute positioning without visually moving
   *  it: its current on-screen spot becomes its explicit left/top. Offsets are
   *  measured from the page's padding box (the containing block for abs children),
   *  i.e. the page border edge — so no margin subtraction. */
  function floatFigure(fig) {
    if (fig.classList.contains('is-floating')) return;
    const pr = page.getBoundingClientRect();
    const fr = fig.getBoundingClientRect();
    fig.classList.add('is-floating');
    // Lift in place, but clamp into the printable area so the very first frame is
    // already inside the margins (matches the drag clamp above).
    const mm = pageMargins();
    const maxL = Math.max(mm.left, page.clientWidth - mm.right - fig.offsetWidth);
    const maxT = Math.max(mm.top, page.clientHeight - mm.bottom - fig.offsetHeight);
    fig.style.left = `${Math.round(Math.max(mm.left, Math.min(fr.left - pr.left, maxL)))}px`;
    fig.style.top = `${Math.round(Math.max(mm.top, Math.min(fr.top - pr.top, maxT)))}px`;
  }

  /** The top-level block sitting under a screen point (skipping the figure being
   *  dragged and any inert spacers) — the re-anchor target for a wrapped image. */
  function blockUnderPoint(x, y, exclude) {
    for (const elm of document.elementsFromPoint(x, y)) {
      const b = blockOf(elm);
      if (b && b !== exclude && editRoot.contains(b)
        && !b.classList.contains('doc-pagebreak') && !b.classList.contains('is-floating')) return b;
    }
    return null;
  }

  /** Drop a wrapped figure back into the flow: re-anchor it before the paragraph
   *  under the pointer and pick the side (left/right) from the drop X, so the text
   *  reflows around its new home instead of the image floating over the words. */
  function reanchorWrap(fig, x, y) {
    const target = blockUnderPoint(x, y, fig);
    const pr = page.getBoundingClientRect();
    const side = (x - pr.left) > page.clientWidth / 2 ? 'right' : 'left';
    fig.classList.remove('is-floating', 'is-behind', 'is-moving');
    fig.style.left = ''; fig.style.top = ''; fig.style.zIndex = '';
    if (target && target !== fig) editRoot.insertBefore(fig, target);
    fig.classList.remove('is-wrap-left', 'is-wrap-right');
    fig.classList.add(side === 'right' ? 'is-wrap-right' : 'is-wrap-left');
    fig.dataset.wrap = side;
  }

  function startImageMove(e, fig) {
    const startX = e.clientX, startY = e.clientY;
    const fr = fig.getBoundingClientRect();
    const grabX = e.clientX - fr.left; // where inside the image the pointer grabbed
    const grabY = e.clientY - fr.top;
    // A wrapped image re-anchors on drop (keeps flowing text around it); front/
    // behind/inline images drag to a free absolute position.
    const wasWrapped = currentWrap(fig) === 'left' || currentWrap(fig) === 'right';
    let moving = false;
    let lastX = e.clientX, lastY = e.clientY;
    try { page.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    const onMove = (ev) => {
      lastX = ev.clientX; lastY = ev.clientY;
      if (!moving) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return; // jitter → still a click
        moving = true;
        fig.classList.add('is-moving');
        floatFigure(fig); // lift for smooth dragging; wrapped ones re-anchor on drop
      }
      const pr = page.getBoundingClientRect();
      // Keep the image inside the printable area (within the page margins), so a
      // dragged image never spills into the margin or off the sheet.
      const mm = pageMargins();
      const maxL = Math.max(mm.left, page.clientWidth - mm.right - fig.offsetWidth);
      const maxT = Math.max(mm.top, page.clientHeight - mm.bottom - fig.offsetHeight);
      const left = Math.max(mm.left, Math.min((ev.clientX - grabX) - pr.left, maxL));
      const top = Math.max(mm.top, Math.min((ev.clientY - grabY) - pr.top, maxT));
      fig.style.left = `${Math.round(left)}px`;
      fig.style.top = `${Math.round(top)}px`;
    };
    const onUp = () => {
      page.removeEventListener('pointermove', onMove);
      page.removeEventListener('pointerup', onUp);
      page.removeEventListener('pointercancel', onUp);
      try { page.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (!moving) return; // plain click — selection already handled above
      if (wasWrapped) reanchorWrap(fig, lastX, lastY);
      fig.classList.remove('is-moving');
      commit();
      schedulePaginate();
      emitSelection();
    };
    page.addEventListener('pointermove', onMove);
    page.addEventListener('pointerup', onUp);
    page.addEventListener('pointercancel', onUp);
  }

  /** Drop a non-text block after the caret's block and keep editing flowing. */
  function insertBlock(node, caretInto) {
    const sel = window.getSelection();
    // Reference block, in order of preference: the live caret, the last caret we
    // saw (survives a button click that stole focus), then the block the user is
    // currently looking at. Only as a last resort do we append at the very end —
    // otherwise a fresh insert on a just-opened multi-page doc lands off-screen.
    const live = sel && sel.rangeCount && editRoot.contains(sel.focusNode) ? blockOf(sel.focusNode) : null;
    const ref = live
      || (lastCaretBlock && editRoot.contains(lastCaretBlock) ? lastCaretBlock : null)
      || visibleAnchorBlock();
    if (ref) ref.after(node);
    else editRoot.appendChild(node);
    ensureTrailingParagraph();
    const r = document.createRange();
    if (caretInto) { r.selectNodeContents(caretInto); r.collapse(true); }
    else {
      const after = node.nextElementSibling || node;
      r.setStart(after, 0); r.collapse(true);
    }
    sel?.removeAllRanges();
    sel?.addRange(r);
    commit();
    emitSelection();
  }

  /** The top-level content block the user is currently looking at — the first one
   *  reaching into the scroll viewport. Used so an insert with no caret still
   *  lands on the visible page, not at the far end of a long document. */
  function visibleAnchorBlock() {
    const kids = Array.from(editRoot.children).filter((n) =>
      !n.classList.contains('doc-pagebreak') && !n.classList.contains('is-floating'));
    if (!kids.length) return null;
    const vpTop = container.getBoundingClientRect().top + 8;
    for (const b of kids) {
      const r = b.getBoundingClientRect();
      if (r.bottom >= vpTop) return b;
    }
    return kids[kids.length - 1];
  }

  /** Guarantee an editable paragraph after trailing non-text blocks. */
  function ensureTrailingParagraph() {
    const last = editRoot.lastElementChild;
    if (!last || /^(TABLE|FIGURE|UL|OL)$/.test(last.tagName)) {
      const p = document.createElement('p');
      p.className = 'doc-block';
      p.appendChild(document.createElement('br'));
      editRoot.appendChild(p);
    }
  }

  function inList() {
    const n = window.getSelection()?.focusNode;
    const elx = n?.nodeType === 3 ? n.parentElement : n;
    return !!elx?.closest?.('li');
  }
  function inTableCell() {
    const n = window.getSelection()?.focusNode;
    const elx = n?.nodeType === 3 ? n.parentElement : n;
    return !!elx?.closest?.('td, th');
  }

  /* ---------------------------- selection ------------------------------- */
  function blockOf(node) {
    let n = node?.nodeType === 3 ? node.parentNode : node;
    while (n && n.parentNode !== editRoot) n = n.parentNode;
    return n && n.parentNode === editRoot ? n : null;
  }
  function selectedBlocks() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return [];
    const r = sel.getRangeAt(0);
    const a = blockOf(r.startContainer);
    const b = blockOf(r.endContainer);
    if (!a) return [];
    const kids = Array.from(editRoot.children);
    let i = kids.indexOf(a);
    let j = kids.indexOf(b === null ? a : b);
    if (j < i) [i, j] = [j, i];
    return kids.slice(i, j + 1).filter((n) => /^(P|H1|H2|H3|DIV)$/.test(n.tagName));
  }

  function currentFormat() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !editRoot.contains(sel.focusNode)) return null;
    const node = sel.focusNode;
    const elx = node.nodeType === 3 ? node.parentElement : node;
    const m = marksFromEl(elx);
    const blk = blockOf(node) || editRoot;
    const cs = getComputedStyle(blk);
    const align = blk.style.textAlign || (cs.textAlign === 'start' ? 'left' : cs.textAlign) || 'left';
    const lh = parseFloat(blk.style.lineHeight) || Math.round((parseFloat(cs.lineHeight) / parseFloat(cs.fontSize)) * 100) / 100;
    const tag = (blk.tagName || 'P').toLowerCase();
    // Is the caret/selection inside a highlighted run? (used to toggle the
    // highlighter button's active state). A non-transparent inline background
    // on the run element means it's highlighted.
    const bg = elx ? getComputedStyle(elx).backgroundColor : '';
    const highlight = !!bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
    // Superscript/subscript come from <sup>/<sub>, not inline marks — read them
    // straight from the command state so the toolbar can reflect them.
    let superscript = false, subscript = false;
    try { superscript = document.queryCommandState('superscript'); subscript = document.queryCommandState('subscript'); } catch { /* ignore */ }
    return { ...m, align, lineHeight: lh || 1.4, blockTag: tag, ordered: tag === 'ol', unordered: tag === 'ul', highlight, superscript, subscript };
  }

  function emitSelection() {
    const fmt = currentFormat();
    if (fmt) onSelection?.(fmt);
    updateTableTools();
  }

  function onSelChange() {
    if (!editRoot.contains(window.getSelection()?.focusNode || null)) { tableTools.hidden = true; return; }
    // Remember where the caret is so Insert-image/table/chart lands here even after
    // clicking a toolbar/menu button moves focus off the page.
    const sel = window.getSelection();
    const b = blockOf(sel?.focusNode);
    if (b) lastCaretBlock = b;
    // Snapshot the live caret so Insert-symbol can drop a glyph exactly here even
    // after focus moves to the (separate, floating) symbol panel or its search box.
    if (sel && sel.rangeCount) savedRange = sel.getRangeAt(0).cloneRange();
    clearTimeout(selTimer);
    selTimer = setTimeout(emitSelection, 40);
  }
  document.addEventListener('selectionchange', onSelChange);
  // The toolbar is position:fixed, so keep it pinned to the table as the page
  // scrolls or the window resizes.
  const onReposition = () => { edgeHi.hidden = true; if (!tableTools.hidden) updateTableTools(); if (chartTools && !chartTools.hidden) positionChartTools(); reportPagination(false); };
  // The scroll viewport is `container` (.doc-host, overflow:auto); the inner
  // .doc-editor-scroll just grows with content. Listen on both so the page
  // counter and floating toolbar track the scroll wherever it actually happens.
  scroll.addEventListener('scroll', onReposition, { passive: true });
  container.addEventListener('scroll', onReposition, { passive: true });
  window.addEventListener('resize', onReposition);
  // Re-flow pages when the window resizes or a font finishes loading later (e.g.
  // a heading font applied after load), so pagination always reflects real sizes.
  const onWindowResize = () => schedulePaginate();
  window.addEventListener('resize', onWindowResize);
  const onFontsLoaded = () => { if (base) schedulePaginate(); };
  if (document.fonts && document.fonts.addEventListener) {
    document.fonts.addEventListener('loadingdone', onFontsLoaded);
  }
  // Column resizing: hover shows the col-resize cursor, drag re-shares the width.
  page.addEventListener('pointermove', onTablePointerMove);
  page.addEventListener('pointerleave', onTablePointerLeave);
  page.addEventListener('pointerdown', onTablePointerDown);
  // Double-click a cell to restore any lines erased around it.
  page.addEventListener('dblclick', onTableDblClick);
  // Double-click a page margin (top/bottom) to edit the running head/foot there.
  page.addEventListener('dblclick', onPageDblClickHf);
  // Double-click a chart bar/slice/point to add a custom text/number label on it.
  page.addEventListener('dblclick', onChartDblClick);

  /* ------------------------------ lifecycle ----------------------------- */
  function focus() {
    // Positioned docs: the page container is inert, so focus the first editable
    // box (and drop the caret in it) — otherwise focusing the page does nothing
    // and the user would have to click a box before they can type.
    if (base && base.layout === 'positioned') {
      const first = page.querySelector(':scope > .doc-posbox');
      if (first) { first.focus(); return; }
    }
    page.focus();
  }
  function setEditable(on) {
    if (!on && hfEditing) exitHf(false); // leave any running head/foot edit first
    // Positioned (exact-layout) documents keep the page container non-editable and
    // make each `.doc-posbox` individually editable, so the caret lands in the box
    // at its coordinates (like the PDF editor) rather than in one flowing column.
    const positioned = base && base.layout === 'positioned';
    page.contentEditable = (on && !positioned) ? 'true' : 'false';
    if (positioned) {
      for (const b of page.querySelectorAll(':scope > .doc-posbox')) b.contentEditable = on ? 'true' : 'false';
    }
    page.classList.toggle('is-readonly', !on);
    page.classList.toggle('is-positioned', !!positioned);
    // Suspend workspace shortcuts while this editor is live; restore them on Done.
    if (on && !endEditing) endEditing = keyboard.beginEditing();
    else if (!on && endEditing) { endEditing(); endEditing = null; }
    if (!on) tableTools.hidden = true; // no inline table tools while read-only
  }
  const isLoaded = () => base != null;

  /* -------------------------------- zoom -------------------------------- */
  // Scale the page area with the CSS `zoom` property (not transform): Chromium/
  // Edge treat it as a layout scale, so the scroll host's scrollbars stay correct
  // and no manual size math is needed. Clamped to a sane range.
  let zoom = 1;
  const ZMIN = 0.5, ZMAX = 2.5;
  function setZoom(z) {
    zoom = Math.min(ZMAX, Math.max(ZMIN, Math.round((z || 1) * 100) / 100));
    stack.style.zoom = String(zoom);
    reportPagination(true); // zoom changes the scroll→page mapping
    return zoom;
  }
  const zoomIn = () => setZoom(zoom + 0.1);
  const zoomOut = () => setZoom(zoom - 0.1);
  const getZoom = () => zoom;

  function destroy() {
    if (endEditing) { endEditing(); endEditing = null; }
    document.removeEventListener('selectionchange', onSelChange);
    scroll.removeEventListener('scroll', onReposition);
    container.removeEventListener('scroll', onReposition);
    window.removeEventListener('resize', onReposition);
    window.removeEventListener('resize', onWindowResize);
    if (document.fonts && document.fonts.removeEventListener) {
      document.fonts.removeEventListener('loadingdone', onFontsLoaded);
    }
    page.removeEventListener('pointermove', onTablePointerMove);
    page.removeEventListener('pointerleave', onTablePointerLeave);
    page.removeEventListener('pointerdown', onTablePointerDown);
    page.removeEventListener('dblclick', onTableDblClick);
    page.removeEventListener('dblclick', onPageDblClickHf);
    if (hfEditing) exitHf(false);
    hideHfChrome();
    hideChartTools();
    closeChartDataPanel();
    if (chartTools) { chartTools.remove(); chartTools = null; }
    document.removeEventListener('pointerdown', onDocPointerDownHf, true);
    clearTimeout(inputTimer);
    clearTimeout(selTimer);
    clearTimeout(paginateTimer);
    clearTimeout(hfInputTimer);
    container.replaceChildren();
    container.classList.remove('doc-editor');
  }

  return {
    load,
    getModel,
    getPageSetup,
    setPageSetup,
    getShowMargins,
    setShowMargins,
    isLoaded,
    setEditable,
    focus,
    setZoom,
    zoomIn,
    zoomOut,
    getZoom,
    getPageCount,
    getCurrentPage,
    goToPage,
    toggleMark,
    clearFormatting,
    setInlineStyle,
    setHighlight,
    setBlockStyle,
    setBlockTag,
    setFontFamily,
    setFontSize,
    setColor,
    setAlign,
    insertList,
    insertTable,
    setTableBorder,
    inTable,
    insertTableRow,
    insertTableColumn,
    deleteTableRow,
    deleteTableColumn,
    deleteTable,
    insertImage,
    insertShape,
    insertChart,
    editHeader,
    editFooter,
    insertField,
    insertText,
    restoreCaret,
    getHfSettings,
    setHfSettings,
    getFormat: currentFormat,
    undo,
    redo,
    canUndo,
    canRedo,
    destroy,
    get element() {
      return page;
    },
  };
}
