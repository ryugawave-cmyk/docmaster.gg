/**
 * PDF → Unified Document Model importer.
 *
 * This is the boundary where PDF.js stops being an editor and becomes only an
 * *extractor*. It decodes a PDF, pulls each page's text items (string, position,
 * font size, style), groups them into lines and then paragraphs, and emits a
 * `Document` (see `documentModel.js`) of editable paragraphs/runs. From here the
 * editor works purely on the model — PDF.js is no longer involved in editing.
 *
 * Grouping is heuristic (PDFs carry no paragraph structure): items on a shared
 * baseline form a line; lines separated by more than ~1.6× the local line height
 * start a new paragraph; unusually large text becomes a heading. Images/tables
 * are a later increment (text is extracted first, per the plan).
 */
import { getDocument, PDF_DOCUMENT_DEFAULTS, CSS_UNITS } from '../../workspace/pdf/pdfjs.js';
import { createDocument, createParagraph, createRun } from './documentModel.js';

export async function importPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocument({ data, ...PDF_DOCUMENT_DEFAULTS }).promise;

  const first = await pdf.getPage(1);
  const vp = first.getViewport({ scale: CSS_UNITS, rotation: 0 });

  const allSizes = [];
  const blocks = [];

  for (let p = 1; p <= pdf.numPages; p += 1) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = normalizeItems(content, allSizes);
    const lines = groupLines(items);
    const paras = groupParagraphs(lines);
    for (const para of paras) blocks.push(para);
  }

  // Second pass: classify headings relative to the document's median font size.
  const median = medianOf(allSizes) || 16;
  for (const block of blocks) {
    if (block.type !== 'paragraph') continue;
    const size = dominantSize(block);
    if (size >= median * 1.7) block.tag = 'h1';
    else if (size >= median * 1.3) block.tag = 'h2';
  }

  try {
    await pdf.cleanup();
    await pdf.destroy();
  } catch {
    /* already torn down */
  }

  return createDocument({
    title: file.name.replace(/\.pdf$/i, ''),
    source: 'pdf',
    page: { width: Math.round(vp.width), height: Math.round(vp.height), margin: 64 },
    blocks: blocks.length ? blocks : [createParagraph()],
  });
}

/** Flatten PDF text items to CSS-space glyph runs with style flags. */
function normalizeItems(content, sizeSink) {
  const styles = content.styles || {};
  const items = [];
  for (const it of content.items) {
    if (!it.str || !it.str.trim()) continue;
    const t = it.transform; // [a,b,c,d,e,f]
    const fontSize = Math.max(6, Math.round(Math.hypot(t[2], t[3]) * CSS_UNITS));
    const x = t[4] * CSS_UNITS;
    const y = t[5] * CSS_UNITS;
    const style = styles[it.fontName] || {};
    const fam = (style.fontFamily || it.fontName || '').toString();
    items.push({
      str: it.str,
      x,
      y,
      w: (it.width || 0) * CSS_UNITS,
      fontSize,
      bold: /bold|black|heavy|semibold/i.test(fam),
      italic: /italic|oblique/i.test(fam),
      fontFamily: mapFamily(fam),
      hasEOL: it.hasEOL,
    });
    sizeSink.push(fontSize);
  }
  return items;
}

/** Group items sharing a baseline (within tolerance) into left-to-right lines. */
function groupLines(items) {
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x); // top→bottom, left→right
  const lines = [];
  let current = null;
  for (const it of sorted) {
    const tol = Math.max(3, it.fontSize * 0.4);
    if (current && Math.abs(current.y - it.y) <= tol) {
      current.items.push(it);
      current.y = (current.y * (current.items.length - 1) + it.y) / current.items.length;
    } else {
      current = { y: it.y, items: [it] };
      lines.push(current);
    }
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

/** Turn lines into paragraphs, joining lines separated by normal leading. */
function groupParagraphs(lines) {
  const paras = [];
  let runsAcc = [];
  let prev = null;

  const flush = () => {
    if (!runsAcc.length) return;
    paras.push(createParagraph({ runs: mergeRuns(runsAcc) }));
    runsAcc = [];
  };

  for (const line of lines) {
    const size = lineSize(line);
    const gap = prev ? prev.y - line.y : 0;
    const lead = size * 1.6;
    const bigGap = prev && gap > lead;
    const sizeJump = prev && Math.abs(size - lineSize(prev)) > Math.max(2, size * 0.25);
    if (prev && (bigGap || sizeJump)) flush();

    if (runsAcc.length) runsAcc.push(createRun(' ')); // join wrapped lines with a space
    for (const run of lineToRuns(line)) runsAcc.push(run);
    prev = { y: line.y, items: line.items };
  }
  flush();
  return paras;
}

function lineToRuns(line) {
  const runs = [];
  let prevItem = null;
  for (const it of line.items) {
    if (prevItem) {
      const gap = it.x - (prevItem.x + prevItem.w);
      if (gap > prevItem.fontSize * 0.25 && !/\s$/.test(runs[runs.length - 1]?.text || '')) {
        runs.push(createRun(' ', markOf(prevItem)));
      }
    }
    runs.push(createRun(it.str, markOf(it)));
    prevItem = it;
  }
  return runs;
}

const markOf = (it) => ({ bold: it.bold, italic: it.italic, fontFamily: it.fontFamily, fontSize: it.fontSize });

function mergeRuns(runs) {
  const out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && sameMarks(last.marks, r.marks)) last.text += r.text;
    else out.push({ text: r.text, marks: { ...r.marks } });
  }
  return out;
}

function sameMarks(a, b) {
  return a.bold === b.bold && a.italic === b.italic && a.fontFamily === b.fontFamily && a.fontSize === b.fontSize;
}

/* ------------------------------- helpers -------------------------------- */
function lineSize(line) {
  return Math.round(median(line.items.map((i) => i.fontSize)));
}
function dominantSize(block) {
  const counts = new Map();
  for (const r of block.runs) counts.set(r.marks.fontSize, (counts.get(r.marks.fontSize) || 0) + r.text.length);
  let best = 16;
  let bestN = -1;
  for (const [size, n] of counts) if (n > bestN) ((bestN = n), (best = size));
  return best;
}
function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
const medianOf = median;

function mapFamily(fam) {
  const f = fam.toLowerCase();
  if (/times|serif|georgia|roman|minion/.test(f) && !/sans/.test(f)) return 'Georgia';
  if (/mono|courier|consol/.test(f)) return 'monospace';
  return 'Inter';
}
