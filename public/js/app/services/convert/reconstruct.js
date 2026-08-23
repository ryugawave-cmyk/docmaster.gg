/**
 * Visual reconstruction: positioned text runs → ordered, editable document blocks.
 *
 * The converters used to either (a) flow all text top-to-bottom (losing tables,
 * columns and spacing) or (b) emit VML absolutely-positioned text boxes — which
 * desktop Word honours but Google Docs silently collapses into scattered flow.
 * Neither reproduced the PDF's appearance in the editors people actually use.
 *
 * This module segments each page's positioned runs into a READING-ORDER sequence
 * of blocks — real tables (grids of aligned cells), headings, and paragraphs —
 * that map onto native OOXML constructs every word processor (Word, Google Docs,
 * LibreOffice) renders the same way. Tables are detected from the geometry of the
 * runs (rows by shared baseline, columns by shared x), so a bordered grid like the
 * RRB "Personal Details" section becomes a genuine editable Word table rather than
 * loose text. Styling (size, weight, italic, colour, alignment) is carried through.
 *
 * Pure geometry + text — no DOM — so it is unit-testable in Node.
 *
 * @typedef {import('./model.js').Run} Run
 *
 * @see coalesceLineRuns — re-joins word fragments before column detection.
 * @typedef {{ text:string, style:object, align:string, colStart:number, span:number }} Cell
 * @typedef {{ type:'table', cols:number[], rows:Cell[][] }
 *   | { type:'heading', text:string, style:object, align:string, level:number }
 *   | { type:'paragraph', text:string, style:object, align:string }
 *   | { type:'image', src:string, x:number, y:number, w:number, h:number }} Block
 */

/**
 * @param {{pages:{index:number,w:number,h:number,runs:Run[],images:any[]}[]}} content
 * @returns {{index:number,w:number,h:number,blocks:Block[]}[]}
 */
import { coalesceLineRuns } from './model.js';

export function reconstructPages(content) {
  const sizes = [];
  for (const p of content.pages) for (const r of p.runs) sizes.push(r.fontSize);
  sizes.sort((a, b) => a - b);
  const bodySize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 16;

  return content.pages.map((pg) => ({
    index: pg.index,
    w: pg.w,
    h: pg.h,
    blocks: pageToBlocks(pg, bodySize),
  }));
}

/** Group a page's runs into blocks: tables where a grid is detected, otherwise
 *  headings/paragraphs — in top-to-bottom reading order, with images interleaved
 *  by vertical position so a side photo lands near its row. */
function pageToBlocks(pg, bodySize) {
  const lines = groupLines(pg.runs);
  const blocks = [];

  let i = 0;
  while (i < lines.length) {
    // A table band = ≥2 consecutive multi-cell lines whose columns line up.
    const band = collectTableBand(lines, i);
    if (band) {
      blocks.push({ ...buildTable(band.lines, pg.w), _y: band.lines[0].top });
      i = band.end;
      continue;
    }
    const line = lines[i];
    blocks.push({ ...buildTextBlock(line, bodySize), _y: line.top });
    i += 1;
  }

  // Interleave images (discrete objects and/or images cropped out of the page
  // raster) by vertical position so a side photo lands near its row.
  for (const im of (pg.images || [])) {
    blocks.push({ type: 'image', src: im.src, x: im.x, y: im.y, w: im.w, h: im.h, _y: im.y });
  }
  blocks.sort((a, b) => (a._y || 0) - (b._y || 0));
  return blocks;
}

/**
 * Detect table regions as GEOMETRY (for drawing absolute cell borders in the
 * position-faithful DOCX): each region carries its rows' y/height and its
 * columns' x/width in page pixels. Reuses the same band/column detection as the
 * flow reconstruction, so what becomes a real table there becomes a bordered grid
 * here.
 * @returns {{rows:{y:number,h:number}[], cols:{x:number,w:number}[]}[]}
 */
export function detectTableRegions(runs, pageW) {
  const lines = groupLines(runs);
  const regions = [];
  let i = 0;
  while (i < lines.length) {
    const band = collectTableBand(lines, i);
    if (!band) { i += 1; continue; }
    const cols = clusterColumns(band.lines);
    const colRight = cols.map((x, k) => (k < cols.length - 1 ? cols[k + 1] : Math.max(pageW, x + 40)));
    const rows = band.lines.map((ln, k) => {
      const nextTop = band.lines[k + 1] ? band.lines[k + 1].top : ln.bottom;
      return { y: ln.top, h: Math.max(ln.bottom - ln.top, nextTop - ln.top, ln.h) };
    });
    regions.push({ rows, cols: cols.map((x, k) => ({ x, w: colRight[k] - x })) });
    i = band.end;
  }
  return regions;
}

/* ------------------------------- lines ---------------------------------- */

/** Merge runs sharing a baseline into left-to-right lines. */
function groupLines(runs) {
  const sorted = runs.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const r of sorted) {
    const last = lines[lines.length - 1];
    const tol = Math.min(r.h, last ? last.h : r.h) * 0.6;
    if (last && Math.abs(r.y - last.y) <= tol) {
      last.cells.push(r);
      last.y = (last.y * (last.cells.length - 1) + r.y) / last.cells.length;
      last.h = Math.max(last.h, r.h);
      last.top = Math.min(last.top, r.y);
      last.bottom = Math.max(last.bottom, r.y + r.h);
    } else {
      lines.push({ y: r.y, h: r.h, top: r.y, bottom: r.y + r.h, cells: [r] });
    }
  }
  // Re-join word fragments (PDF extraction splits words into adjacent runs) so a
  // "cell" is a contiguous text segment, not a single glyph that would otherwise
  // seed a phantom narrow column and tear words apart during column clustering.
  for (const ln of lines) {
    ln.cells.sort((a, b) => a.x - b.x);
    ln.cells = coalesceLineRuns(ln.cells);
  }
  return lines;
}

/* ------------------------------ table band ------------------------------ */

/**
 * Starting at index `start`, gather the longest run of consecutive lines that
 * form a table: at least two lines, each with ≥2 cells, that share at least two
 * aligned column positions. Returns null when no table starts here.
 */
function collectTableBand(lines, start) {
  if (!lines[start] || lines[start].cells.length < 2) return null;
  let end = start;
  while (end < lines.length && lines[end].cells.length >= 2) end += 1;
  if (end - start < 2) return null; // need ≥2 rows to be a table

  const band = lines.slice(start, end);
  // Require the rows to actually share columns (guards against two unrelated
  // multi-cell lines that merely happen to be adjacent).
  const cols = clusterColumns(band);
  if (cols.length < 2) return null;
  const aligned = band.filter((ln) => ln.cells.length >= 2
    && ln.cells.every((c) => nearestCol(cols, c.x) >= 0)).length;
  if (aligned < 2) return null;
  return { lines: band, end };
}

/** Cluster all cell left-edges in the band into column x-positions. */
function clusterColumns(band) {
  const xs = [];
  for (const ln of band) for (const c of ln.cells) xs.push(c.x);
  xs.sort((a, b) => a - b);
  const tol = 14; // px — cells within this share a column
  const cols = [];
  for (const x of xs) {
    const last = cols[cols.length - 1];
    if (last && x - last.x <= tol) { last.x = (last.x * last.n + x) / (last.n + 1); last.n += 1; }
    else cols.push({ x, n: 1 });
  }
  // Keep columns that recur (drop one-off strays that would over-segment).
  return cols.filter((c) => c.n >= 2).map((c) => c.x);
}

function nearestCol(cols, x) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < cols.length; i += 1) {
    const d = Math.abs(cols[i] - x);
    if (d < bestD) { bestD = d; best = i; }
  }
  return bestD <= 24 ? best : (x >= cols[cols.length - 1] - 24 ? cols.length - 1 : best);
}

/** Build a table block: assign each row's cells to columns, compute spans. */
function buildTable(band, pageW) {
  const cols = clusterColumns(band);
  const n = cols.length;
  const colRight = cols.map((x, i) => (i < n - 1 ? cols[i + 1] : Math.max(pageW, x + 40)));
  const widths = cols.map((x, i) => Math.max(24, Math.round(colRight[i] - x)));

  const rows = band.map((ln) => {
    const slots = new Array(n).fill(null);
    for (const c of ln.cells) {
      let ci = nearestCol(cols, c.x);
      if (ci < 0) ci = 0;
      if (slots[ci]) slots[ci].run = mergeCellRuns(slots[ci].run, c);
      else slots[ci] = { run: c };
    }
    // Turn occupied slots into cells with a gridSpan reaching the next occupant.
    const cells = [];
    let ci = 0;
    while (ci < n) {
      if (!slots[ci]) { ci += 1; continue; }
      let span = 1;
      while (ci + span < n && !slots[ci + span]) span += 1;
      const r = slots[ci].run;
      cells.push({
        text: r.text, style: styleOf(r), align: r.align || 'left',
        colStart: ci, span,
      });
      ci += span;
    }
    // Pad a leading empty column so cells keep their horizontal position.
    if (cells.length && cells[0].colStart > 0) {
      cells.unshift({ text: '', style: {}, align: 'left', colStart: 0, span: cells[0].colStart });
    }
    return cells;
  });

  return { type: 'table', cols: widths, rows, left: Math.round(cols[0]) };
}

function mergeCellRuns(a, b) {
  // Two runs landed in the same column (wrapped value / split label): join text.
  return { ...a, text: `${a.text} ${b.text}`.replace(/\s+/g, ' ').trim() };
}

/* ------------------------------ text blocks ----------------------------- */

function buildTextBlock(line, bodySize) {
  line.cells.sort((a, b) => a.x - b.x);
  const text = line.cells.map((c) => c.text.replace(/\n/g, ' ')).join('  ').replace(/\s+/g, ' ').trim();
  const lead = line.cells[0];
  const size = Math.max(...line.cells.map((c) => c.fontSize));
  const bold = line.cells.every((c) => c.bold);
  const style = styleOf({ ...lead, fontSize: size, bold });
  const align = lead.align || 'left';

  const isHeading = (size >= bodySize * 1.3 || (bold && size >= bodySize * 1.08)
    || isColoured(lead.color)) && text.length <= 140 && line.cells.length <= 3;
  const x = Math.round(lead.x || 0);
  if (isHeading) {
    const level = size >= bodySize * 1.8 ? 1 : size >= bodySize * 1.4 ? 2 : 3;
    return { type: 'heading', text, style, align, level, x };
  }
  return { type: 'paragraph', text, style, align, x };
}

const styleOf = (r) => ({
  size: r.fontSize, bold: !!r.bold, italic: !!r.italic,
  color: r.color, font: r.fontFamily,
  // Sampled page colour behind the run — used to SHADE a coloured heading bar or
  // table cell in the editable DOCX so the PDF's fills reappear (editable, native).
  boxBg: r.boxBg || '',
});

/** A run coloured away from near-black counts as an emphasised/section colour. */
function isColoured(hex) {
  const h = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return false;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return Math.max(r, g, b) - Math.min(r, g, b) > 40 || (r + g + b) / 3 > 90 && (r + g + b) / 3 < 210 && Math.max(r, g, b) < 150;
}
