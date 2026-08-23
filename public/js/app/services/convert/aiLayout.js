/**
 * AI layout → editable blocks (the accuracy engine for AI PDF→Word).
 *
 * The layout model's job is only the HARD part the geometry heuristics fail at:
 * "where are the tables / paragraphs / titles, and in what reading order." This
 * module takes those detected regions plus the PDF's OWN extracted text runs
 * (exact characters + positions) and produces clean, ordered blocks:
 *
 *   • a `table` region → a real grid, built by clustering the runs that fall
 *     inside it into rows (by y) and columns (by x). Scoping the clustering to a
 *     KNOWN table region is what makes this reliable — unlike guessing table
 *     regions from scratch, which is the current source of scrambled tables.
 *   • a `text`/`title` region → a paragraph (title ⇒ heading).
 *   • runs outside every region → paragraphs by position, so nothing is dropped.
 *
 * Output block shape (consumed by the docx builder once wired):
 *   { kind:'paragraph', text, heading:0|1|2|3 }
 *   { kind:'table', rows: [ [ { text, colSpan } ] ] }
 *
 * Pure geometry + text — no DOM, no model — so it's fully unit-testable in Node.
 *
 * @typedef {{ x:number,y:number,w:number,h:number }} Box
 * @typedef {{ type:'table'|'text'|'title'|'figure', box:Box, order?:number }} Region
 * @typedef {{ text:string, x:number, y:number, w:number, h:number, fontSize?:number }} Run
 */

const cx = (r) => r.x + (r.w || 0) / 2;
const cy = (r) => r.y + (r.h || 0) / 2;
const inBox = (r, b) => cx(r) >= b.x && cx(r) <= b.x + b.w && cy(r) >= b.y && cy(r) <= b.y + b.h;

/** Cluster sorted numeric positions into groups; a gap larger than `tol` starts
 *  a new group. Returns group centers (sorted). */
function clusterPositions(values, tol) {
  const sorted = [...values].sort((a, b) => a - b);
  const groups = [];
  let cur = [];
  for (const v of sorted) {
    if (cur.length && v - cur[cur.length - 1] > tol) { groups.push(cur); cur = []; }
    cur.push(v);
  }
  if (cur.length) groups.push(cur);
  return groups.map((g) => g.reduce((s, x) => s + x, 0) / g.length);
}

function medianSize(runs, dim) {
  const sizes = runs.map((r) => (dim === 'h' ? (r.h || r.fontSize || 12) : (r.w || 0))).filter((v) => v > 0).sort((a, b) => a - b);
  return sizes.length ? sizes[Math.floor(sizes.length / 2)] : 12;
}

/**
 * The dominant style across a set of runs, weighted by how many characters each
 * run contributes — so the paragraph/cell inherits the styling of its BODY text,
 * not an incidental one-character run. Keeps the PDF's real font size, weight,
 * colour and family instead of letting the docx builder invent them (which is
 * what turned small centred headers into giant left-aligned headings).
 */
function styleOf(runs) {
  const pick = (key, fallback) => {
    const tally = new Map();
    for (const r of (runs || [])) {
      const n = ((r.text || '').trim().length) || 1;
      const v = r[key] == null ? fallback : r[key];
      tally.set(v, (tally.get(v) || 0) + n);
    }
    let best = fallback, bd = -1;
    for (const [v, n] of tally) if (n > bd) { bd = n; best = v; }
    return best;
  };
  const majority = (key) => {
    let t = 0, f = 0;
    for (const r of (runs || [])) { const n = ((r.text || '').trim().length) || 1; if (r[key]) t += n; else f += n; }
    return t > f;
  };
  return {
    size: pick('fontSize', 16),
    bold: majority('bold'),
    italic: majority('italic'),
    color: pick('color', '111827'),
    font: pick('fontFamily', 'Calibri'),
  };
}

/**
 * Horizontal alignment of text lines within their region box: centred when each
 * line has near-equal left/right slack, right when the right slack is smallest,
 * else left. Lets a centred header stay centred instead of snapping to the left.
 */
function alignOf(lines, box) {
  if (!box || !(box.w > 0)) return 'left';
  const tol = Math.max(6, box.w * 0.05);
  const votes = { left: 0, center: 0, right: 0 };
  for (const ls of lines) {
    if (!ls || !ls.length) continue;
    const minX = Math.min(...ls.map((r) => r.x));
    const maxX = Math.max(...ls.map((r) => r.x + (r.w || 0)));
    const leftGap = minX - box.x;
    const rightGap = (box.x + box.w) - maxX;
    if (leftGap > tol && Math.abs(leftGap - rightGap) <= tol) votes.center += 1;
    else if (rightGap + tol < leftGap && rightGap <= tol * 1.5) votes.right += 1;
    else votes.left += 1;
  }
  if (votes.center >= votes.left && votes.center >= votes.right && votes.center > 0) return 'center';
  if (votes.right > votes.left && votes.right > votes.center) return 'right';
  return 'left';
}

const nearestIndex = (centers, v) => {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < centers.length; i += 1) { const d = Math.abs(centers[i] - v); if (d < bd) { bd = d; bi = i; } }
  return bi;
};

/** Merge runs sharing a cell (same row+col) into one string, left-to-right.
 *  Runs on different baselines (a wrapped cell) keep their line break. */
function cellText(runs) {
  const lineH = medianSize(runs, 'h');
  const sorted = runs.slice().sort((a, b) => cy(a) - cy(b) || a.x - b.x);
  const lines = [];
  for (const r of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(cy(r) - last.y) <= lineH * 0.6) { last.parts.push(r); last.y = (last.y + cy(r)) / 2; }
    else lines.push({ y: cy(r), parts: [r] });
  }
  return lines
    .map((l) => l.parts.sort((a, b) => a.x - b.x).map((r) => (r.text || '').trim()).filter(Boolean).join(' '))
    .join('\n').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

/**
 * Infer the table's column x-centres from its runs. Clustering by run LEFT EDGE is
 * unreliable when cells are aligned differently (a centred number vs a left-aligned
 * header end up in separate columns). Instead we:
 *   1. split each row into cells by horizontal whitespace gaps,
 *   2. take the cell count that appears across the most rows as the real column
 *      count (data rows outvote a sparse header/footer row),
 *   3. average the k-th cell's centre over the rows that have that many cells.
 * Runs are then assigned to the NEAREST centre, so mixed alignment lands correctly.
 */
function detectColumns(runs, lineH, rowCenters) {
  const cellGap = Math.max(10, lineH * 1.4);
  const byRow = rowCenters.map(() => []);
  for (const r of runs) byRow[nearestIndex(rowCenters, cy(r))].push(r);

  const rowCells = byRow.map((rs) => {
    const sorted = rs.slice().sort((a, b) => a.x - b.x);
    const cells = [];
    let cell = null;
    for (const r of sorted) {
      const x1 = r.x + (r.w || 0);
      if (cell && r.x - cell.x1 <= cellGap) cell.x1 = Math.max(cell.x1, x1);
      else { cell = { x0: r.x, x1 }; cells.push(cell); }
    }
    return cells;
  });

  const counts = new Map();
  for (const cells of rowCells) if (cells.length) counts.set(cells.length, (counts.get(cells.length) || 0) + 1);
  if (!counts.size) return [0];
  // Modal cell count = column count; ties prefer MORE columns (avoid merging).
  let ncol = 1, best = -1;
  for (const [k, n] of [...counts.entries()].sort((a, b) => a[0] - b[0])) if (n >= best) { best = n; ncol = k; }

  const sum = new Array(ncol).fill(0);
  const seen = new Array(ncol).fill(0);
  for (const cells of rowCells) {
    if (cells.length !== ncol) continue;
    for (let k = 0; k < ncol; k += 1) { sum[k] += (cells[k].x0 + cells[k].x1) / 2; seen[k] += 1; }
  }
  return sum.map((s, k) => (seen[k] ? s / seen[k] : s)).sort((a, b) => a - b);
}

/** Left/right x-extent of each column, midway between neighbouring centres and
 *  bounded by the table region box. Used to judge per-cell alignment. */
function colEdges(box, centers) {
  const left = [], right = [];
  const bx0 = box ? box.x : centers[0] - 20;
  const bx1 = box ? box.x + box.w : centers[centers.length - 1] + 20;
  for (let k = 0; k < centers.length; k += 1) {
    left[k] = k === 0 ? bx0 : (centers[k - 1] + centers[k]) / 2;
    right[k] = k === centers.length - 1 ? bx1 : (centers[k] + centers[k + 1]) / 2;
  }
  return { left, right };
}

/**
 * Build a table block from the runs inside a table region. Rows are y-clusters;
 * columns come from column-count inference (see detectColumns). Empty cells are
 * kept so the grid stays rectangular (Word-friendly). All spans are 1 for now.
 */
export function buildTable(runs, box) {
  if (!runs.length) return { kind: 'table', rows: [] };
  const lineH = medianSize(runs, 'h');
  const rowTol = lineH * 0.7;
  const rowCenters = clusterPositions(runs.map(cy), rowTol);
  const colCenters = detectColumns(runs, lineH, rowCenters);
  const ncol = Math.max(1, colCenters.length);
  const { left, right } = colEdges(box, colCenters);

  const grid = rowCenters.map(() => Array.from({ length: ncol }, () => []));
  for (const r of runs) {
    const ri = nearestIndex(rowCenters, cy(r));
    const ci = nearestIndex(colCenters, cx(r));
    grid[ri][ci].push(r);
  }
  const rows = grid.map((row) => row.map((cellRuns, ci) => ({
    text: cellText(cellRuns),
    colSpan: 1,
    style: cellRuns.length ? styleOf(cellRuns) : null,
    align: cellRuns.length ? alignOf([cellRuns], { x: left[ci], w: Math.max(1, right[ci] - left[ci]) }) : 'left',
  })));
  return { kind: 'table', rows };
}

/** Build a paragraph/heading block from the runs inside a text/title region.
 *  `box` (the region's bounds) lets us recover the on-page alignment. */
export function buildParagraph(runs, type, box) {
  const rowTol = medianSize(runs, 'h') * 0.7;
  const rowCenters = clusterPositions(runs.map(cy), rowTol);
  const lines = rowCenters.map(() => []);
  for (const r of runs) lines[nearestIndex(rowCenters, cy(r))].push(r);
  for (const ls of lines) ls.sort((a, b) => a.x - b.x);
  const text = lines
    .map((ls) => ls.map((r) => (r.text || '').trim()).join(' '))
    .join('\n').replace(/[ \t]+/g, ' ').trim();
  return {
    kind: 'paragraph',
    text,
    heading: type === 'title' ? 1 : 0,
    style: styleOf(runs),
    align: alignOf(lines, box),
  };
}

/** Tight bounding box of a set of runs. */
function bboxOf(runs) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of runs) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + (r.w || 0)); y1 = Math.max(y1, r.y + (r.h || 0));
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Runs that fell outside every detected region become paragraphs grouped by
 *  vertical gaps — so scattered stray text keeps its position and reading order
 *  instead of collapsing into one block dumped at the end of the document. */
function leftoverParagraphs(runs) {
  if (!runs.length) return [];
  const lineH = medianSize(runs, 'h');
  const sorted = runs.slice().sort((a, b) => cy(a) - cy(b) || a.x - b.x);
  const groups = [];
  let cur = null, prevY = null;
  for (const r of sorted) {
    const y = cy(r);
    if (cur && prevY != null && y - prevY <= lineH * 1.8) cur.push(r);
    else { cur = [r]; groups.push(cur); }
    prevY = y;
  }
  return groups.map((g) => {
    const box = bboxOf(g);
    const p = buildParagraph(g, 'text', box);
    p.y = box.y; p.x = box.x;
    return p;
  });
}

/**
 * Turn detected regions + PDF text runs into ordered editable blocks. Every block
 * carries its on-page `y`/`x` so the docx builder can interleave the page's images
 * into the same reading-order stream.
 * @param {Run[]} runs
 * @param {Region[]} regions
 * @returns {Array<{kind:'paragraph'|'table', y:number, x:number, [k:string]:any}>}
 */
export function buildBlocksFromRegions(runs, regions) {
  const regs = (regions || []).filter((r) => r && r.box);
  const buckets = regs.map(() => []);
  const leftovers = [];

  for (const run of (runs || [])) {
    if (!run || !run.text || !String(run.text).trim()) continue;
    let hit = -1;
    for (let i = 0; i < regs.length; i += 1) if (inBox(run, regs[i].box)) { hit = i; break; }
    if (hit >= 0) buckets[hit].push(run); else leftovers.push(run);
  }

  const blocks = [];
  regs.forEach((reg, i) => {
    if (!buckets[i].length || reg2skip(reg)) return;
    const b = reg.type === 'table' ? buildTable(buckets[i], reg.box) : buildParagraph(buckets[i], reg.type, reg.box);
    b.y = reg.box.y; b.x = reg.box.x;
    blocks.push(b);
  });
  blocks.push(...leftoverParagraphs(leftovers));

  // Reading order: honour explicit region `order` first, else top-to-bottom then
  // left-to-right by position. Interleaving (not appending) fixes headings/notes
  // that the model left out of a region landing below the table.
  blocks.sort((a, b) => {
    if (a.order != null && b.order != null && a.order !== b.order) return a.order - b.order;
    return (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0);
  });
  return blocks;
}

// `figure` regions carry no editable text (image handled separately) → skipped.
function reg2skip(reg) { return reg.type === 'figure'; }
