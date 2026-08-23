/**
 * DOCX → Unified Document Model (block/flow) importer.
 *
 * Reads a .docx (a ZIP of OOXML) entirely in the browser and produces the same
 * block model the Document editor edits: headings, paragraphs, lists, tables and
 * inline images with run-level formatting (bold/italic/underline, font, size,
 * colour). Unzipping uses the platform `DecompressionStream` (raw DEFLATE); there
 * is no third-party dependency.
 *
 * Best-effort by design: unknown parts are skipped, never fatal — a document
 * that references features we don't map still imports its text and structure.
 */
import {
  createDocument, createParagraph, createRun, createListBlock,
  createImageBlock, createTableBlock, DEFAULT_MARKS,
} from '../../model/documentModel.js';

const PT_TO_PX = 96 / 72;

/** @param {ArrayBuffer} buf @param {string} [title] */
export async function docxToBlockModel(buf, title = 'Document') {
  const files = await unzip(new Uint8Array(buf));
  const dec = new TextDecoder();
  const documentXml = files.get('word/document.xml');
  if (!documentXml) return createDocument({ title, source: 'docx' });

  const xml = new DOMParser().parseFromString(dec.decode(documentXml), 'application/xml');
  const relsXml = files.get('word/_rels/document.xml.rels');
  const rels = relsXml ? parseRels(dec.decode(relsXml)) : {};
  const numbering = files.get('word/numbering.xml') ? parseNumbering(dec.decode(files.get('word/numbering.xml'))) : {};

  const body = xml.getElementsByTagName('w:body')[0];
  if (!body) return createDocument({ title, source: 'docx' });

  const blocks = [];
  let pendingList = null; // accumulate consecutive list paragraphs

  const flushList = () => { if (pendingList) { blocks.push(pendingList.block); pendingList = null; } };

  for (const node of Array.from(body.children)) {
    const tag = local(node.tagName);
    if (tag === 'p') {
      const listInfo = paragraphListInfo(node, numbering);
      if (listInfo) {
        const runs = readRuns(node, files, rels);
        if (!pendingList || pendingList.ordered !== listInfo.ordered) {
          flushList();
          pendingList = { ordered: listInfo.ordered, block: createListBlock({ ordered: listInfo.ordered, items: [] }) };
          pendingList.block.items = [];
        }
        pendingList.block.items.push({ runs: runs.length ? runs : [createRun('')] });
        continue;
      }
      flushList();
      // A paragraph may itself contain an inline image → emit an image block.
      const imgBlock = readInlineImage(node, files, rels);
      if (imgBlock) { blocks.push(imgBlock); continue; }
      blocks.push(readParagraph(node, files, rels));
    } else if (tag === 'tbl') {
      flushList();
      blocks.push(readTable(node, files, rels));
    }
  }
  flushList();

  return createDocument({
    title,
    source: 'docx',
    blocks: blocks.length ? blocks : [createParagraph()],
  });
}

/* ------------------------------- paragraph -------------------------------- */

function readParagraph(pNode, files, rels) {
  const pPr = child(pNode, 'pPr');
  const styleVal = pPr ? attr(child(pPr, 'pStyle'), 'w:val') : '';
  const tag = /heading\s*1|heading1/i.test(styleVal) ? 'h1'
    : /heading\s*2|heading2/i.test(styleVal) ? 'h2'
    : /heading\s*3|heading3/i.test(styleVal) ? 'h3' : 'p';
  const jc = pPr ? attr(child(pPr, 'jc'), 'w:val') : '';
  const align = jc === 'both' ? 'justify' : (jc === 'center' || jc === 'right' ? jc : 'left');
  const runs = readRuns(pNode, files, rels);
  return createParagraph({ tag, style: { align }, runs: runs.length ? runs : [createRun('')] });
}

function readRuns(container, files, rels) {
  const runs = [];
  for (const r of Array.from(container.getElementsByTagName('w:r'))) {
    const rPr = child(r, 'rPr');
    const marks = readMarks(rPr);
    let text = '';
    for (const t of Array.from(r.children)) {
      const tl = local(t.tagName);
      if (tl === 't') text += t.textContent;
      else if (tl === 'tab') text += '\t';
      else if (tl === 'br') text += '\n';
    }
    if (text) runs.push(createRun(text, marks));
  }
  return runs;
}

function readMarks(rPr) {
  if (!rPr) return {};
  const m = {};
  if (child(rPr, 'b') && attr(child(rPr, 'b'), 'w:val') !== 'false' && attr(child(rPr, 'b'), 'w:val') !== '0') m.bold = true;
  if (child(rPr, 'i') && attr(child(rPr, 'i'), 'w:val') !== 'false' && attr(child(rPr, 'i'), 'w:val') !== '0') m.italic = true;
  const u = child(rPr, 'u');
  if (u && attr(u, 'w:val') && attr(u, 'w:val') !== 'none') m.underline = true;
  const sz = attr(child(rPr, 'sz'), 'w:val');
  if (sz) m.fontSize = Math.round((parseInt(sz, 10) / 2) * PT_TO_PX);
  const color = attr(child(rPr, 'color'), 'w:val');
  if (color && color !== 'auto') m.color = `#${color.replace(/^#/, '')}`;
  const font = child(rPr, 'rFonts');
  if (font) { const f = attr(font, 'w:ascii') || attr(font, 'w:hAnsi'); if (f) m.fontFamily = f; }
  return m;
}

/* --------------------------------- lists ---------------------------------- */

function paragraphListInfo(pNode, numbering) {
  const pPr = child(pNode, 'pPr');
  if (!pPr) return null;
  const numPr = child(pPr, 'numPr');
  if (!numPr) return null;
  const numId = attr(child(numPr, 'numId'), 'w:val');
  const ordered = numId != null ? !!numbering[numId] : false;
  return { ordered };
}

/** numId → ordered(boolean): true when its level-0 format is not "bullet". */
function parseNumbering(text) {
  const map = {};
  try {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    const abstractFmt = {};
    for (const an of Array.from(xml.getElementsByTagName('w:abstractNum'))) {
      const id = attr(an, 'w:abstractNumId');
      const lvl = Array.from(an.getElementsByTagName('w:lvl')).find((l) => attr(l, 'w:ilvl') === '0') || an.getElementsByTagName('w:lvl')[0];
      const fmt = lvl ? attr(child(lvl, 'numFmt'), 'w:val') : 'bullet';
      abstractFmt[id] = fmt;
    }
    for (const num of Array.from(xml.getElementsByTagName('w:num'))) {
      const numId = attr(num, 'w:numId');
      const aId = attr(child(num, 'abstractNumId'), 'w:val');
      map[numId] = abstractFmt[aId] !== 'bullet';
    }
  } catch { /* leave empty → everything treated as unordered */ }
  return map;
}

/* --------------------------------- tables --------------------------------- */

function readTable(tbl, files, rels) {
  const rows = [];
  const rowWidths = []; // per row: [{ w, span }] from each cell's <w:tcW>
  for (const tr of childrenOf(tbl, 'tr')) {
    const cells = [];
    const widths = [];
    for (const tc of childrenOf(tr, 'tc')) {
      const runs = [];
      for (const p of childrenOf(tc, 'p')) runs.push(...readRuns(p, files, rels));
      const cell = { runs: runs.length ? runs : [createRun('')] };
      const tcPr = child(tc, 'tcPr');
      // Horizontal cell merge (w:gridSpan) → colSpan, so a header spanning several
      // grid columns keeps the same footprint as its columns (and the grid stays
      // aligned). Without this the cell would occupy one column and shift the row.
      const span = parseInt(attr(child(tcPr, 'gridSpan'), 'w:val') || '0', 10) || 1;
      if (span > 1) cell.colSpan = span;
      widths.push({ w: parseFloat(attr(child(tcPr, 'tcW'), 'w:w') || '0') || 0, span });
      cells.push(cell);
    }
    if (cells.length) { rows.push(cells); rowWidths.push(widths); }
  }
  if (!rows.length) return createTableBlock(1, 1);

  // Column widths: prefer a *non-uniform* <w:tblGrid>; else derive them from the
  // row with the most cells' per-cell <w:tcW> (distributed across gridSpans).
  // Preserving Word's real proportions matters: a text-heavy column left too
  // narrow wraps into a cell taller than a whole page, which then can't be kept
  // on one page and gets split at the boundary. A uniform/absent grid is treated
  // as "no widths" (autofit) so block.cols stays unset and the editor sizes
  // columns to CONTENT (see .doc-table:not(:has(colgroup)) → table-layout:auto),
  // exactly like Word/Google Docs — again keeping rows their real, short height.
  const grid = child(tbl, 'tblGrid');
  const gridWs = grid ? childrenOf(grid, 'gridCol').map((gc) => parseFloat(attr(gc, 'w:w') || '0') || 0) : [];
  const cols = toFractions(gridWs) || colsFromCellWidths(rowWidths);

  const gridCols = cols ? cols.length : Math.max(...rows.map((r) => r.reduce((n, c) => n + (c.colSpan || 1), 0)));
  const block = createTableBlock(rows.length, gridCols);
  block.rows = rows;
  if (cols) block.cols = cols;
  return block;
}

const childrenOf = (node, name) => Array.from(node.children).filter((n) => local(n.tagName) === name);

/** Normalise column widths to fractions summing to 1 — but only when they are
 *  meaningfully non-uniform. Equal widths mean an autofit table, so we return
 *  null and let content-based auto layout size the columns instead. */
function toFractions(ws) {
  if (!ws.length) return null;
  const sum = ws.reduce((a, b) => a + b, 0);
  const min = Math.min(...ws), max = Math.max(...ws);
  if (sum <= 0 || min <= 0 || max / min < 1.12) return null;
  return ws.map((w) => w / sum);
}

/** Build column widths from the widest row's per-cell <w:tcW>, expanding each
 *  gridSpan cell evenly across the columns it covers. */
function colsFromCellWidths(rowWidths) {
  let best = null;
  for (const widths of rowWidths) {
    const nCols = widths.reduce((n, x) => n + x.span, 0);
    if (widths.every((x) => x.w > 0) && (!best || nCols > best.nCols)) best = { widths, nCols };
  }
  if (!best) return null;
  const ws = [];
  for (const { w, span } of best.widths) for (let k = 0; k < span; k += 1) ws.push(w / span);
  return toFractions(ws);
}

/* --------------------------------- images --------------------------------- */

function readInlineImage(pNode, files, rels) {
  const blip = pNode.getElementsByTagName('a:blip')[0];
  if (!blip) return null;
  const embed = blip.getAttribute('r:embed') || blip.getAttribute('embed');
  const target = embed && rels[embed];
  if (!target) return null;
  const path = `word/${target.replace(/^\.\//, '')}`;
  const bytes = files.get(path) || files.get(target);
  if (!bytes) return null;
  const ext = (path.split('.').pop() || 'png').toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  const ext_node = pNode.getElementsByTagName('wp:extent')[0];
  const width = ext_node ? Math.round(parseInt(ext_node.getAttribute('cx') || '0', 10) / 9525) : null;
  return createImageBlock({ src: `data:image/${mime};base64,${base64(bytes)}`, width: width || undefined });
}

/* ------------------------------ OOXML helpers ----------------------------- */

const local = (t) => (t || '').replace(/^.*:/, '');
function child(node, name) {
  if (!node) return null;
  for (const c of Array.from(node.children)) if (local(c.tagName) === name) return c;
  return null;
}
function attr(node, name) {
  if (!node) return null;
  return node.getAttribute(name) || node.getAttribute(local(name));
}
function parseRels(text) {
  const map = {};
  try {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    for (const r of Array.from(xml.getElementsByTagName('Relationship'))) {
      map[r.getAttribute('Id')] = r.getAttribute('Target');
    }
  } catch { /* ignore */ }
  return map;
}
function base64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/* --------------------------------- unzip ---------------------------------- */

/**
 * Minimal ZIP reader → Map(name → Uint8Array). Walks the central directory and
 * inflates DEFLATE (method 8) entries via `DecompressionStream`; STORED (method
 * 0) entries are copied as-is.
 */
async function unzip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // Locate End Of Central Directory (search backwards for its signature).
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive');
  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true); // central directory offset

  const out = new Map();
  for (let n = 0; n < count; n += 1) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) break;
    const method = dv.getUint16(ptr + 10, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const localOff = dv.getUint32(ptr + 42, true);
    const name = new TextDecoder().decode(u8.subarray(ptr + 46, ptr + 46 + nameLen));

    // Jump to the local header to find where the data actually begins.
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = u8.subarray(dataStart, dataStart + compSize);

    if (method === 0) out.set(name, comp.slice());
    else if (method === 8) out.set(name, await inflateRaw(comp));

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await stream.arrayBuffer());
}
