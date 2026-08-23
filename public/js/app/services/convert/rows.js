/**
 * Table reconstruction for the spreadsheet converter.
 *
 * Turns a page's positioned text runs into a real grid of rows × columns, so a
 * PDF invoice/table lands in Excel with each value in its own cell — not every
 * value dumped into column A. It works for both bordered tables and BORDERLESS
 * ones (columns implied only by whitespace / x-alignment), because detection is
 * driven entirely by text coordinates, never by grid lines.
 *
 * Pipeline:
 *   1. Runs sharing a baseline are grouped into a ROW (font-size tolerance, so a
 *      missing run height can't scatter every run onto its own row).
 *   2. Each row becomes positioned CELLS: kerning fragments are re-joined, and a
 *      run that itself spans several columns (a whole line as one text item,
 *      separated by wide spacing) is split back into cells.
 *   3. COLUMNS are the x-positions that recur DOWN the page — cell left-edges are
 *      clustered, and a cluster becomes a column only if cells from ≥2 rows line
 *      up under it. This "align vertically across rows" test finds borderless
 *      columns and ignores one-off cells (a title, a stray note), which are
 *      snapped to their nearest real column.
 *   4. Every cell is placed in the column its left-edge is nearest; cells landing
 *      in the same column on a row are joined, giving a rectangular grid.
 *
 * Plain prose (no vertical alignment) yields a single column — still valid.
 */

/** @typedef {{text:string,x:number,y:number,w:number,h:number,fontSize?:number}} Run */

/* Diagnostics: set `window.__XLSX_DEBUG = true` in the browser console, then run
 * PDF → Excel. Every pipeline stage is logged so a column collapse can be traced
 * to extraction, row grouping, column detection or grid building. No-op when the
 * flag is off, so it's safe to leave in. */
const dbgOn = () => typeof globalThis !== 'undefined' && globalThis.__XLSX_DEBUG;
function dbg(label, data) {
  if (!dbgOn()) return;
  try { console.log(`%c[xlsx] ${label}`, 'color:#7c3aed;font-weight:600', data); }
  catch { /* console unavailable */ }
}

/** Median font size across a page's runs — the unit for spacing thresholds. */
function emUnit(runs) {
  const sizes = runs.map((r) => r.fontSize || r.h || 12).filter((n) => n > 0).sort((a, b) => a - b);
  return sizes.length ? sizes[Math.floor(sizes.length / 2)] : 12;
}

/**
 * Re-join adjacent fragments of the SAME word/cell — glyph splits from kerning,
 * ligatures or form fields — where the horizontal gap is far below a word space.
 * Everything with a real gap is kept as its own positioned cell so columns stay
 * separate. Runs are assumed sorted left-to-right.
 * @param {Run[]} parts
 * @returns {{text:string,x:number,w:number,fs:number}[]}
 */
function mergeGlyphSplits(parts) {
  const out = [];
  for (const r of parts) {
    const text = String(r.text || '');
    const x = r.x || 0;
    const w = r.w || 0;
    const prev = out[out.length - 1];
    if (prev) {
      const fs = Math.max(prev.fs || 12, r.fontSize || 12);
      const gap = x - (prev.x + prev.w);
      // < ~0.18em with no whitespace either side ⇒ a split mid-token, not a gap.
      if (gap < fs * 0.18 && !/\s$/.test(prev.text) && !/^\s/.test(text)) {
        prev.text += text;
        prev.w = Math.max(prev.x + prev.w, x + w) - prev.x;
        continue;
      }
    }
    out.push({ text, x, w, fs: r.fontSize || 12 });
  }
  return out;
}

/**
 * A single run may hold a whole table row (a line returned as one text item,
 * columns separated by runs of spaces). Split it back into positioned cells at
 * those wide-space gaps, estimating each fragment's x by its character offset
 * across the run's width. Single spaces (within-cell words) are preserved, so a
 * two-word cell such as "Sales Rep" stays one cell.
 * @param {{text:string,x:number,w:number,fs:number}} cell
 * @returns {{text:string,x:number,w:number}[]}
 */
function splitWideSpaces(cell) {
  const text = cell.text;
  if (!/\s{2,}/.test(text)) return [cell];
  const len = text.length || 1;
  const cw = cell.w && cell.w > 0 ? cell.w / len : (cell.fs || 12) * 0.5;
  const spans = [];
  const re = /\s{2,}/g;
  let start = 0;
  let m;
  while ((m = re.exec(text))) { spans.push([start, m.index]); start = m.index + m[0].length; }
  spans.push([start, text.length]);
  return spans
    .map(([s, e]) => ({ s, e, t: text.slice(s, e).trim() }))
    .filter((o) => o.t)
    .map((o) => ({ text: o.t, x: cell.x + o.s * cw, w: (o.e - o.s) * cw }));
}

/**
 * Learn the page's word-gap vs column-gap boundary (in em) from the horizontal
 * gaps between adjacent runs on every row. A table has two gap populations: the
 * small spaces WITHIN a cell (between words of "Human Resources") and the wide
 * gutters BETWEEN columns. We look for the largest jump between those populations
 * and put the threshold there, so runs closer than a column gutter are treated as
 * one logical cell. Clamped to a sane range and defaulted when a page has too few
 * gaps to judge.
 * @param {{x:number,w:number,fs:number}[][]} rowSegs  glyph-merged segments/row
 * @param {number} em
 * @returns {number}  threshold in em units (gap/fontSize)
 */
function wordGapThreshold(rowSegs, em) {
  const gaps = [];
  for (const segs of rowSegs) {
    for (let i = 1; i < segs.length; i += 1) {
      const g = segs[i].x - (segs[i - 1].x + segs[i - 1].w);
      const fs = Math.max(segs[i].fs || em, segs[i - 1].fs || em) || 12;
      if (g > 0) gaps.push(g / fs);
    }
  }
  // No word-gap population by default: only glyph-tight joins happen (mergeGlyph-
  // Splits already did those), so nothing extra is merged. We only raise the bar
  // when the data actually shows a cluster of small (word-space) gaps sitting
  // BELOW a clearly larger column-gutter cluster.
  const NONE = 0.35;
  if (gaps.length < 2) return NONE;
  gaps.sort((a, b) => a - b);
  // Walk from the smallest gap and find the first big step up (gutter ≥ ~1.8× the
  // word space) whose lower side is still word-sized (≤ ~0.85em). The cut goes
  // between the word cluster and the column cluster; if there's no such step, the
  // page has no split multi-word cells and we merge nothing beyond glyph joins.
  for (let i = 1; i < gaps.length; i += 1) {
    const lo = gaps[i - 1];
    const hi = gaps[i];
    if (lo > 0.85) break;          // past any plausible word space → no word cluster
    if (hi / lo >= 1.8 && hi - lo >= 0.2) {
      return Math.min(Math.max((lo + hi) / 2, 0.45), 1.1);
    }
  }
  return NONE;
}

/**
 * Merge a row's glyph-merged segments into logical CELLS: neighbours separated by
 * less than a column gutter (≤ thrEm) belong to the same cell and are joined with
 * a single space (a word break). This is what keeps "Human Resources", "Laptop
 * Pro 15" and "AI Document Converter" in one cell instead of splitting on every
 * small gap. Segments assumed sorted left-to-right.
 * @param {{text:string,x:number,w:number,fs:number}[]} segs
 * @param {number} thrEm
 */
function mergeByGap(segs, thrEm) {
  const cells = [];
  for (const s of segs) {
    const prev = cells[cells.length - 1];
    if (prev) {
      const fs = Math.max(prev.fs || 12, s.fs || 12);
      const gap = s.x - (prev.x + prev.w);
      if (gap / fs <= thrEm) {
        const needSpace = !/\s$/.test(prev.text) && !/^\s/.test(s.text);
        prev.text = prev.text.replace(/\s+$/, '') + (needSpace ? ' ' : '') + s.text.replace(/^\s+/, '');
        prev.w = Math.max(prev.x + prev.w, s.x + s.w) - prev.x;
        prev.fs = fs;
        continue;
      }
    }
    cells.push({ ...s });
  }
  return cells;
}

/** Group runs into rows by baseline proximity (reading order top-to-bottom).
 *  Tolerance keys off FONT SIZE, not the run height: imported text objects don't
 *  always carry a height (it falls back to 0), and an h-based tolerance of 0 puts
 *  every run on its own row — the "every value in column A, one per line" bug. */
function groupRows(runs) {
  const sorted = [...runs].filter((r) => r && String(r.text || '').trim())
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const rows = [];
  for (const r of sorted) {
    const fs = r.fontSize || r.h || 12;
    const last = rows[rows.length - 1];
    const tol = Math.max(fs, last ? last.fs : 0) * 0.6;
    if (last && Math.abs(r.y - last.y) <= tol) {
      last.parts.push(r);
      last.y = (last.y * last.n + r.y) / (last.n + 1);
      last.n += 1;
      last.fs = Math.max(last.fs, fs);
    } else {
      rows.push({ y: r.y, fs, n: 1, parts: [r] });
    }
  }
  return rows;
}

/**
 * Learn column x-anchors from vertical alignment. Only rows with ≥2 cells vote
 * (a full-width title/paragraph is one cell that would otherwise bridge gutters).
 * Cell left-edges are clustered; a cluster becomes a column only if cells from
 * ≥2 DISTINCT rows stack under it, so a one-off cell can't invent a column.
 * Returns anchor x-positions, ascending.
 * @param {{text:string,x:number,w:number}[][]} rowCells
 * @param {number} em
 * @returns {number[]}
 */
function detectColumns(rowCells, em) {
  const pts = [];
  rowCells.forEach((cells, ri) => {
    if (cells.length >= 2) for (const c of cells) pts.push({ x: c.x, ri });
  });
  if (pts.length < 2) return [];
  pts.sort((a, b) => a.x - b.x);
  // Left edges of one column repeat almost exactly; a new column is a jump wider
  // than ~one character. Keep the tolerance tight so neighbours don't chain.
  const tol = Math.max(em * 0.9, 4);
  const clusters = [];
  let cur = [pts[0]];
  for (let i = 1; i < pts.length; i += 1) {
    if (pts[i].x - cur[cur.length - 1].x <= tol) cur.push(pts[i]);
    else { clusters.push(cur); cur = [pts[i]]; }
  }
  clusters.push(cur);
  const anchors = [];
  for (const cl of clusters) {
    if (new Set(cl.map((p) => p.ri)).size < 2) continue; // must recur down the page
    const xs = cl.map((p) => p.x).sort((a, b) => a - b);
    anchors.push(xs[Math.floor(xs.length / 2)]);
  }
  return anchors;
}

/**
 * Reconstruct a page's table as a rectangular grid (rows × columns). Every row
 * has the same number of columns; empty cells are ''.
 * @param {{runs:Run[]}} page
 * @returns {string[][]}
 */
export function pageToTable(page) {
  const runs = (page && page.runs) || [];
  if (!runs.length) return [];
  // STAGE 1 — raw extracted objects reaching reconstruction.
  dbg(`STAGE 1 raw runs (${runs.length})`,
    runs.map((r) => ({ text: r.text, x: r.x, y: r.y, w: r.w, h: r.h, fs: r.fontSize })));

  const em = emUnit(runs);
  const rows = groupRows(runs);
  // STAGE 2 — rows after baseline grouping (how many runs landed on each row).
  dbg(`STAGE 2 rows after grouping (${rows.length})`,
    rows.map((row) => ({ y: Math.round(row.y), n: row.parts.length, texts: row.parts.map((p) => p.text) })));

  // Glyph-merge each row's runs into segments (kerning fragments joined).
  const rowSegs = rows.map((row) => {
    row.parts.sort((a, b) => a.x - b.x);
    return mergeGlyphSplits(row.parts);
  });
  // Learn where a WORD gap ends and a COLUMN gutter begins, then merge segments
  // closer than a gutter into one logical cell (so "Human Resources", "Laptop Pro
  // 15" survive). A run that itself spans columns is still wide-space split.
  const thrEm = wordGapThreshold(rowSegs, em);
  dbg(`STAGE 2a word/column gap threshold = ${thrEm.toFixed(2)} em`, null);
  const rowCells = rowSegs.map((segs) => {
    const cells = [];
    for (const merged of mergeByGap(segs, thrEm)) {
      for (const c of splitWideSpaces(merged)) cells.push(c);
    }
    return cells;
  });
  dbg('STAGE 2b cells per row',
    rowCells.map((cells) => cells.map((c) => ({ text: c.text, x: Math.round(c.x) }))));

  const columns = detectColumns(rowCells, em);
  // STAGE 3 — column x-anchors from vertical alignment.
  dbg(`STAGE 3 detectColumns → ${columns.length} column(s)`, columns.map((x) => Math.round(x)));
  if (columns.length <= 1) {
    // No vertically-aligned columns ⇒ not a table. Emit one column of line text.
    const flat = rowCells
      .map((cells) => cells.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((line) => [line]);
    dbg('STAGE 4 grid (single-column fallback)', flat);
    return flat;
  }

  // Assign a cell to the column whose anchor its left edge is nearest.
  const colOf = (x) => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < columns.length; i += 1) {
      const d = Math.abs(x - columns[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  const grid = [];
  for (const cells of rowCells) {
    const line = new Array(columns.length).fill('');
    for (const c of cells) {
      const text = c.text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const ci = colOf(c.x);
      line[ci] = line[ci] ? `${line[ci]} ${text}` : text;
    }
    if (line.some((v) => v)) grid.push(line);
  }
  // STAGE 4 — final reconstructed grid handed to the Excel writer.
  dbg(`STAGE 4 grid (${grid.length}×${columns.length})`, grid);
  return grid;
}

/**
 * Back-compat alias — the spreadsheet converter reconstructs the table grid.
 * @param {{runs:Run[]}} page
 * @returns {string[][]}
 */
export function pageToRows(page) {
  return pageToTable(page);
}
