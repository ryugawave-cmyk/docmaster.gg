/**
 * PPTX (PowerPoint) → Unified Document Model (block/flow) importer.
 *
 * Reads a .pptx (a ZIP of PresentationML XML) entirely in the browser and turns
 * each slide into editable document content, in on-slide vertical order:
 *   • the slide title            → a heading (h2; "Slide N" when untitled)
 *   • body placeholders          → bulleted lists / paragraphs
 *   • tables (a:tbl)             → real editable tables
 *   • pictures (p:pic)           → images (extracted from ppt/media, placed inline)
 *   • charts (c:chart)           → REAL editable charts (the bar/pie/line data is
 *                                  parsed and rebuilt via the Professional Library
 *                                  chart engine — not a flat raster), so a deck's
 *                                  graphs survive the import instead of vanishing.
 * This is the same block model the Document editor edits and every exporter reads.
 *
 * Best-effort by design (mirrors docxImport): unknown parts (SmartArt, grouped
 * vector shapes, speaker notes, animations, EMF/WMF images the browser can't show)
 * are skipped rather than fatal. Slide font SIZES are intentionally NOT carried
 * over — a 40pt title would wreck a document — but bold / italic / underline /
 * colour / font family are preserved and titles map to headings.
 *
 * NOTE ON FIDELITY: this reconstructs CONTENT into a flowing document; it is not a
 * pixel-exact copy of the slide canvas (gradients, effects, precise positioning and
 * unavailable fonts are not reproduced). Charts, tables, images and text survive.
 */
import {
  createDocument, createParagraph, createRun, createListBlock,
  createTableBlock, createImageBlock, normalizeRuns,
} from '../../model/documentModel.js';
import { normalizeChart, renderChartSvg, TYPE_META } from '../../editor/chartRender.js';

const EMU_PER_PX = 9525;            // OOXML EMU per CSS px @96dpi
const CONTENT_W = 640;              // clamp images/charts to the doc's usable width

/** @param {ArrayBuffer} buf @param {string} [title] */
export async function pptxToBlockModel(buf, title = 'Presentation') {
  const files = await unzip(new Uint8Array(buf));
  const dec = new TextDecoder();
  const text = (name) => { const u8 = files.get(name); return u8 ? dec.decode(u8) : null; };
  const parse = (name) => { const t = text(name); return t ? new DOMParser().parseFromString(t, 'application/xml') : null; };

  const slideNames = orderedSlideNames(files, text);
  const slideSize = readSlideSize(parse('ppt/presentation.xml'));
  const blocks = [];
  slideNames.forEach((name, i) => {
    const xml = parse(name);
    if (!xml) return;
    // Per-slide relationships resolve image/chart references (r:embed / r:id).
    const relsName = name.replace(/slides\/([^/]+)$/, 'slides/_rels/$1.rels');
    const rels = text(relsName) ? parseRels(text(relsName)) : {};
    blocks.push(...readSlide(xml, i + 1, { files, parse, rels, slidePath: name, slideSize }));
  });

  return createDocument({ title, source: 'pptx', blocks: blocks.length ? blocks : undefined });
}

/**
 * Slide files in PRESENTATION order (presentation.xml sldIdLst → rels), with a
 * numeric sort of ppt/slides/slideN.xml as a fallback.
 */
function orderedSlideNames(files, text) {
  const presText = text('ppt/presentation.xml');
  const relsText = text('ppt/_rels/presentation.xml.rels');
  if (presText && relsText) {
    const rels = parseRels(relsText);
    const pres = new DOMParser().parseFromString(presText, 'application/xml');
    const ids = Array.from(pres.getElementsByTagName('*')).filter((n) => local(n.tagName) === 'sldId');
    const names = [];
    for (const id of ids) {
      const rid = attr(id, 'r:id');
      const target = rid && rels[rid];
      if (!target) continue;
      const norm = resolveRel('ppt/presentation.xml', target);
      if (files.has(norm)) names.push(norm);
    }
    if (names.length) return names;
  }
  return Array.from(files.keys())
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNum(a) - slideNum(b));
}

const slideNum = (n) => parseInt((/slide(\d+)\.xml$/.exec(n) || [])[1] || '0', 10);

/**
 * One slide → an array of blocks: a heading for the title (or "Slide N" when the
 * slide is untitled but has content), then its shapes (paragraphs/lists/tables/
 * images/charts) in top-to-bottom order. An empty slide contributes nothing.
 */
function readSlide(xml, index, ctx) {
  const tree = deepFirstByLocal(xml, 'spTree'); // p:sld > p:cSld > p:spTree
  if (!tree) return [];

  let titleRuns = null;
  const body = []; // { top:number, block } — sorted by vertical slide position

  for (const shape of Array.from(tree.children)) {
    const ln = local(shape.tagName);
    const top = shapeTop(shape);
    if (ln === 'sp') {
      const txBody = firstByLocal(shape, 'txBody');
      if (!txBody) continue;
      const paras = childrenByLocal(txBody, 'p');
      const ph = placeholderEl(shape);
      const phType = ph ? attr(ph, 'type') : null;
      if (isTitlePh(phType) && titleRuns == null) {
        const runs = paras.flatMap(paraRuns).filter((r) => r.text);
        if (runs.length) titleRuns = normalizeRuns(runs);
      } else {
        // Content/body placeholders are bulleted by default in PowerPoint; a
        // plain text box (no placeholder) or a subtitle is not — so a deck built
        // from free-floating text boxes imports as prose, not a wall of bullets.
        const bulletDefault = !!ph && phType !== 'subTitle';
        for (const b of paragraphsToBlocks(paras, bulletDefault)) body.push({ top, block: b });
      }
    } else if (ln === 'graphicFrame') {
      const tbl = deepFirstByLocal(shape, 'tbl');
      if (tbl) { body.push({ top, block: readTable(tbl) }); continue; }
      const chart = readChart(shape, ctx);
      if (chart) body.push({ top, block: chart });
    } else if (ln === 'pic') {
      const img = readPicture(shape, ctx);
      if (img) body.push({ top, block: img });
    }
    // grpSp / other shapes are skipped (best-effort content import).
  }

  if (titleRuns == null && !body.length) return [];
  body.sort((a, b) => a.top - b.top);
  const heading = createParagraph({ tag: 'h2', runs: titleRuns || [createRun(`Slide ${index}`)] });
  return [heading, ...body.map((e) => e.block)];
}

/** A shape's top (EMU) for vertical ordering; shapes with no xfrm sink to the end. */
function shapeTop(shape) {
  const off = deepFirstByLocal(shape, 'off');
  const y = off && parseInt(attr(off, 'y'), 10);
  return Number.isFinite(y) ? y : Number.MAX_SAFE_INTEGER;
}

/* -------------------------------- text ------------------------------------ */

/** Shape paragraphs → paragraph/list blocks (consecutive bullets grouped). */
function paragraphsToBlocks(paras, assumeBullet) {
  const out = [];
  let listItems = null;
  const flush = () => { if (listItems && listItems.length) out.push(createListBlock({ ordered: false, items: listItems })); listItems = null; };
  for (const p of paras) {
    const runs = paraRuns(p);
    if (!runs.some((r) => r.text && r.text.trim())) { flush(); continue; }
    if (isBulleted(p, assumeBullet)) (listItems = listItems || []).push({ runs: normalizeRuns(runs) });
    else { flush(); out.push(createParagraph({ runs: normalizeRuns(runs) })); }
  }
  flush();
  return out;
}

/** Whether an `<a:p>` renders as a bullet. Explicit markup wins; else placeholder default. */
function isBulleted(p, assumeBullet) {
  const pPr = firstByLocal(p, 'pPr');
  if (!pPr) return assumeBullet;
  if (firstByLocal(pPr, 'buNone')) return false;
  if (firstByLocal(pPr, 'buChar') || firstByLocal(pPr, 'buAutoNum')) return true;
  return assumeBullet;
}

/** All runs of an `<a:p>` → model runs. `<a:br>` → a space; `<a:fld>` text included. */
function paraRuns(p) {
  const runs = [];
  for (const node of Array.from(p.children)) {
    const ln = local(node.tagName);
    if (ln === 'r' || ln === 'fld') {
      const t = childrenByLocal(node, 't').map((x) => x.textContent).join('');
      if (!t) continue;
      runs.push(createRun(t, marksFromRPr(firstByLocal(node, 'rPr'))));
    } else if (ln === 'br') {
      if (runs.length) runs[runs.length - 1].text += ' ';
    }
  }
  return runs;
}

/** `<a:rPr>` → editor marks (font SIZE omitted; see file header). */
function marksFromRPr(rPr) {
  if (!rPr) return {};
  const marks = {};
  if (attr(rPr, 'b') === '1') marks.bold = true;
  if (attr(rPr, 'i') === '1') marks.italic = true;
  const u = attr(rPr, 'u');
  if (u && u !== 'none') marks.underline = true;
  const s = attr(rPr, 'strike');
  if (s && s !== 'noStrike') marks.strike = true;
  const hex = solidFillHex(rPr);
  if (hex) marks.color = hex;
  const latin = firstByLocal(rPr, 'latin');
  const face = latin && attr(latin, 'typeface');
  if (face && !/^\+/.test(face)) marks.fontFamily = face;
  return marks;
}

/* -------------------------------- tables ---------------------------------- */

/** A DrawingML `<a:tbl>` → an editable table block (gridSpan/rowSpan, merge cells). */
function readTable(tbl) {
  const rows = [];
  for (const tr of childrenByLocal(tbl, 'tr')) {
    const cells = [];
    for (const tc of childrenByLocal(tr, 'tc')) {
      if (attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1') continue;
      const txBody = firstByLocal(tc, 'txBody');
      const paras = txBody ? childrenByLocal(txBody, 'p') : [];
      const cellRuns = [];
      paras.forEach((p, i) => { if (i) cellRuns.push(createRun(' ')); cellRuns.push(...paraRuns(p)); });
      const cell = { runs: normalizeRuns(cellRuns) };
      const cs = parseInt(attr(tc, 'gridSpan') || '1', 10);
      const rs = parseInt(attr(tc, 'rowSpan') || '1', 10);
      if (cs > 1) cell.colSpan = cs;
      if (rs > 1) cell.rowSpan = rs;
      cells.push(cell);
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return createParagraph();
  const cols = Math.max(...rows.map((r) => r.reduce((n, c) => n + (c.colSpan || 1), 0)));
  const block = createTableBlock(rows.length, cols);
  block.rows = rows;
  return block;
}

/* -------------------------------- pictures -------------------------------- */

/** A `<p:pic>` → an inline image block (the media extracted as a data URL). */
function readPicture(shape, ctx) {
  // Full-slide background rasters (a whole-slide image with the text drawn in
  // overlay boxes ON TOP — how "exact-layout" decks are built) must NOT be
  // flowed inline: sitting at y=0 and ~a page tall, one would sort above every
  // shape and bury all the real text below it. Treat it as a background: skip it
  // so the overlay text imports as ordered, editable content.
  if (isSlideBackground(shape, ctx.slideSize)) return null;
  const blip = deepFirstByLocal(shape, 'blip');
  const rid = blip && (attr(blip, 'r:embed') || attr(blip, 'r:link'));
  const target = rid && ctx.rels[rid];
  if (!target) return null;
  const path = resolveRel(ctx.slidePath, target);
  const bytes = ctx.files.get(path);
  if (!bytes) return null;
  const ext = (path.split('.').pop() || '').toLowerCase();
  const mime = IMG_MIME[ext];
  if (!mime) return null; // e.g. emf/wmf — the browser can't display these
  const { w } = shapeExtPx(shape);
  const width = w ? Math.min(w, CONTENT_W) : undefined;
  const src = `data:${mime};base64,${base64(bytes)}`;
  return createImageBlock({ src, width, align: 'center' });
}

const IMG_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff',
};

/* --------------------------------- charts --------------------------------- */

/** A chart `<p:graphicFrame>` → an editable chart figure (image + data-chart spec),
 *  rebuilt from the chart's data via the Professional Library chart engine. */
function readChart(shape, ctx) {
  const ref = deepFirstByLocal(shape, 'chart'); // c:chart in a:graphic/a:graphicData
  const rid = ref && attr(ref, 'r:id');
  const target = rid && ctx.rels[rid];
  if (!target) return null;
  const chartXml = ctx.parse(resolveRel(ctx.slidePath, target));
  if (!chartXml) return null;

  const { w, h } = shapeExtPx(shape);
  const width = Math.max(240, Math.min(w || 480, CONTENT_W));
  const height = Math.max(160, Math.round(width * ((h && w) ? h / w : 0.66)));
  const spec = chartSpecFromXml(chartXml, width, height);
  if (!spec) return null;

  const svg = renderChartSvg(spec, { width: spec.width, height: spec.height });
  const block = createImageBlock({ src: `data:image/svg+xml,${encodeURIComponent(svg)}`, width: spec.width, align: 'center' });
  block.chart = spec; // keeps it a REAL editable chart after save/reload
  return block;
}

/** Parse a chart part (chartN.xml) into a normalized chart spec, or null. */
function chartSpecFromXml(xml, width, height) {
  const plot = deepFirstByLocal(xml, 'plotArea');
  if (!plot) return null;
  let typeEl = null, kind = null;
  for (const c of Array.from(plot.children)) {
    const ln = local(c.tagName);
    if (/Chart$/.test(ln)) { typeEl = c; kind = ln; break; }
  }
  if (!typeEl) return null;

  const type = mapChartType(kind, typeEl);
  const sers = childrenByLocal(typeEl, 'ser');
  let categories = [];
  const series = [];
  let pointColors = [];
  for (const ser of sers) {
    const name = refText(firstByLocal(ser, 'tx'));
    const cats = seriesValues(firstByLocal(ser, 'cat')).labels;
    const vals = seriesValues(firstByLocal(ser, 'val')).numbers;
    if (cats.length && !categories.length) categories = cats;
    series.push({ name: name || `Series ${series.length + 1}`, values: vals, color: solidFillHex(firstByLocal(ser, 'spPr')) || null });
    if (!pointColors.length) pointColors = dataPointColors(ser);
  }
  if (!series.length || !series.some((s) => s.values.length)) return null;

  const titleEl = deepFirstByLocal(xml, 'title');
  const title = titleEl ? refText(firstByLocal(titleEl, 'tx') || titleEl) : '';
  return normalizeChart({ type, title, categories, series, colors: pointColors, width, height });
}

/** OOXML chart element name → Professional-Library chart type id. */
function mapChartType(kind, typeEl) {
  switch (kind) {
    case 'barChart': case 'bar3DChart': return childVal(typeEl, 'barDir') === 'bar' ? 'bar' : 'column';
    case 'pieChart': case 'ofPieChart': return 'pie';
    case 'pie3DChart': return 'pie3d';
    case 'doughnutChart': return 'doughnut';
    case 'lineChart': case 'line3DChart': return 'line';
    case 'areaChart': case 'area3DChart': return 'area';
    case 'scatterChart': return TYPE_META.scatter ? 'scatter' : 'line';
    default: return 'column';
  }
}

/** `<c:cat>` / `<c:val>` → { labels:string[], numbers:number[] } in point order. */
function seriesValues(container) {
  const labels = []; const numbers = [];
  if (!container) return { labels, numbers };
  const pts = Array.from(container.getElementsByTagName('*'))
    .filter((n) => local(n.tagName) === 'pt')
    .map((pt) => ({ idx: parseInt(attr(pt, 'idx') || '0', 10), v: (firstByLocal(pt, 'v') || {}).textContent || '' }))
    .sort((a, b) => a.idx - b.idx);
  for (const r of pts) {
    labels.push(r.v);
    const n = parseFloat(r.v);
    numbers.push(Number.isFinite(n) ? n : null);
  }
  return { labels, numbers };
}

/** Per-point (pie/doughnut) colours from `<c:dPt>` in index order. */
function dataPointColors(ser) {
  const dpts = childrenByLocal(ser, 'dPt')
    .map((d) => ({ idx: parseInt(childVal(d, 'idx') || '0', 10), hex: solidFillHex(firstByLocal(d, 'spPr')) }))
    .filter((d) => d.hex)
    .sort((a, b) => a.idx - b.idx);
  return dpts.map((d) => d.hex);
}

/** Text from a `<c:tx>` (string cache/ref, rich text, or a bare `<c:v>`). */
function refText(el) {
  if (!el) return '';
  const pv = seriesValues(el);
  if (pv.labels.length) return pv.labels.filter(Boolean).join(' ');
  const ts = Array.from(el.getElementsByTagName('*')).filter((n) => local(n.tagName) === 't');
  if (ts.length) return ts.map((t) => t.textContent).join('');
  const v = deepFirstByLocal(el, 'v');
  return v ? v.textContent : '';
}

/* ------------------------------- XML helpers ------------------------------- */
const local = (t) => (t || '').replace(/^.*:/, '');
function attr(node, name) {
  if (!node) return null;
  return node.getAttribute(name) || node.getAttribute(local(name));
}
const childVal = (parent, name) => attr(firstByLocal(parent, name), 'val');
const childrenByLocal = (node, name) =>
  (node ? Array.from(node.children).filter((n) => local(n.tagName) === name) : []);
function firstByLocal(node, name) {
  if (!node) return null;
  for (const c of Array.from(node.children)) if (local(c.tagName) === name) return c;
  return null;
}
function deepFirstByLocal(root, name) {
  if (!root) return null;
  for (const n of Array.from(root.getElementsByTagName('*'))) if (local(n.tagName) === name) return n;
  return null;
}
function placeholderEl(sp) {
  return deepFirstByLocal(firstByLocal(sp, 'nvSpPr'), 'ph');
}
const isTitlePh = (t) => t === 'title' || t === 'ctrTitle';

/** First `<a:solidFill><a:srgbClr val>` under a node → '#rrggbb' (or null). */
function solidFillHex(node) {
  const fill = node && firstByLocal(node, 'solidFill');
  const srgb = fill && firstByLocal(fill, 'srgbClr');
  const val = srgb && attr(srgb, 'val');
  return val && /^[0-9a-f]{6}$/i.test(val) ? `#${val.toLowerCase()}` : null;
}

/** The slide canvas size (EMU) from presentation.xml `<p:sldSz>`, or null. */
function readSlideSize(pres) {
  const sz = pres && deepFirstByLocal(pres, 'sldSz');
  const cx = sz && parseInt(attr(sz, 'cx'), 10);
  const cy = sz && parseInt(attr(sz, 'cy'), 10);
  return (Number.isFinite(cx) && Number.isFinite(cy)) ? { cx, cy } : null;
}

/** A shape's placement frame from `<a:off x y>` + `<a:ext cx cy>` in EMU. */
function shapeFrameEmu(shape) {
  const off = deepFirstByLocal(shape, 'off');
  const ext = deepFirstByLocal(shape, 'ext');
  const num = (node, name) => (node ? parseInt(attr(node, name), 10) : NaN);
  return { x: num(off, 'x'), y: num(off, 'y'), cx: num(ext, 'cx'), cy: num(ext, 'cy') };
}

/**
 * Whether a shape effectively covers the entire slide anchored at (near) the
 * origin — i.e. a full-slide background raster rather than a content image.
 */
function isSlideBackground(shape, slideSize) {
  if (!slideSize) return false;
  const { x, y, cx, cy } = shapeFrameEmu(shape);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return false;
  const coversW = cx >= slideSize.cx * 0.95;
  const coversH = cy >= slideSize.cy * 0.95;
  const nearOriginX = !Number.isFinite(x) || x <= slideSize.cx * 0.05;
  const nearOriginY = !Number.isFinite(y) || y <= slideSize.cy * 0.05;
  return coversW && coversH && nearOriginX && nearOriginY;
}

/** A shape's frame size from `<a:ext cx cy>` → { w, h } in CSS px (or {}). */
function shapeExtPx(shape) {
  const ext = deepFirstByLocal(shape, 'ext');
  if (!ext) return {};
  const cx = parseInt(attr(ext, 'cx'), 10);
  const cy = parseInt(attr(ext, 'cy'), 10);
  return { w: Number.isFinite(cx) ? Math.round(cx / EMU_PER_PX) : 0, h: Number.isFinite(cy) ? Math.round(cy / EMU_PER_PX) : 0 };
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

/** Resolve a rel Target (e.g. "../media/image1.png") against a part path. */
function resolveRel(basePath, target) {
  if (/^https?:/i.test(target)) return target;
  if (target.startsWith('/')) return target.replace(/^\/+/, '');
  const parts = `${basePath.replace(/\/[^/]*$/, '')}/${target}`.split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

/** Binary → base64 (chunked so a large image can't blow the call stack). */
function base64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

/* --------------------------------- unzip ---------------------------------- */
// Self-contained, lenient ZIP reader (no CRC verification) so odd-but-valid
// real-world .pptx files still import. Mirrors docxImport.js.
async function unzip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive');
  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true);

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
