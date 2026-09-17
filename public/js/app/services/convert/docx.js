/**
 * PDF/document → Word (.docx).
 *
 * A .docx is an OOXML ZIP. We build it by hand (see services/zip.js) from the
 * normalised content model — NEVER by dropping page images in as a fake. Three
 * modes:
 *
 *  • 'editable' — real reading-order paragraphs/headings/bullets, no decorative
 *    images. The result is a normal, easy-to-edit Word document.
 *  • 'layout'   — reconstructs the visual layout with absolutely-positioned VML
 *    text boxes carrying the REAL text (still fully editable) plus discrete
 *    images (logos), so it looks close to the PDF without being an image.
 *  • 'hybrid'   — editable paragraph text PLUS the document's discrete images
 *    kept inline (never the whole page as one image).
 *
 * @typedef {import('./model.js').Block} Block
 */
import { zipBlob, dataURLToBytes } from '../zip.js';
import { xml, normHex, PX_TO_PT, PX_TO_TWIP, PX_TO_EMU, buildContentModel, hasComplexScript } from './model.js';
import { reconstructPages, detectTableRegions, detectListItem } from './reconstruct.js';

const PT = (px) => Math.round(px * PX_TO_PT * 100) / 100; // px → pt (2dp)
const TW = (px) => Math.max(0, Math.round(px * PX_TO_TWIP)); // px → twips
const EMU = (px) => Math.max(1, Math.round(px * PX_TO_EMU));  // px → EMU
const SZHP = (px) => Math.max(8, Math.round(px * PX_TO_PT * 2)); // px font → half-points

/* ------------------------------- lists ---------------------------------- */

// Registry of the numbering-list instances used while building ONE document. Each
// numbered list group gets its OWN numId so it restarts independently (sharing one
// numId is the classic bug where a second list continues 4,5,6…); bullets share a
// single numId (they never renumber). Reset per document via resetLists(); read at
// pack time to emit word/numbering.xml.
const listReg = { defs: [], last: null, bulletNum: 0, numberNum: 0, nextId: 2 };
function resetLists() {
  listReg.defs = []; listReg.last = null;
  listReg.bulletNum = 0; listReg.numberNum = 0; listReg.nextId = 2;
}
/** Ends the current list run so the next numbered item restarts (called when a
 *  table/image/heading/plain paragraph interrupts a list). */
function listBreak() { listReg.last = null; }

/** The `<w:numPr>` for one list item, registering a numbering instance on demand.
 *  numId 1 is the shared bullet list; each contiguous decimal run gets a fresh numId
 *  so it starts from its own first number. */
function listNumPr(list) {
  let numId;
  if (list.kind === 'number') {
    const cont = listReg.last && listReg.last.kind === 'number';
    if (cont && listReg.numberNum) numId = listReg.numberNum;
    else {
      numId = listReg.nextId; listReg.nextId += 1; listReg.numberNum = numId;
      listReg.defs.push({ numId, abstract: 1, start: list.start || 1 });
    }
  } else {
    if (!listReg.bulletNum) { listReg.bulletNum = 1; listReg.defs.push({ numId: 1, abstract: 0 }); }
    numId = listReg.bulletNum;
  }
  listReg.last = { kind: list.kind };
  return `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`;
}

/** word/numbering.xml: a bullet abstract list (id 0) and a decimal one (id 1), each
 *  3 levels, plus one `<w:num>` per registered instance. Multiple `<w:num>` may share
 *  an abstract; each numId numbers independently, so per-group ids restart correctly.
 *  A start ≠ 1 is applied with a level-0 startOverride. */
function buildNumberingXml(defs) {
  const bulletChars = ['•', '◦', '▪']; // • ◦ ▪
  const lvl = (i, fmt, text) =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>`
    + `<w:lvlText w:val="${xml(text)}"/><w:lvlJc w:val="left"/>`
    + `<w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
  const bulletAbs = '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>'
    + [0, 1, 2].map((i) => lvl(i, 'bullet', bulletChars[i])).join('') + '</w:abstractNum>';
  const decimalAbs = '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>'
    + [0, 1, 2].map((i) => lvl(i, 'decimal', `%${i + 1}.`)).join('') + '</w:abstractNum>';
  const nums = defs.map((d) => {
    const over = (d.start && d.start !== 1)
      ? `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="${d.start}"/></w:lvlOverride>` : '';
    return `<w:num w:numId="${d.numId}"><w:abstractNumId w:val="${d.abstract}"/>${over}</w:num>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + bulletAbs + decimalAbs + nums + '</w:numbering>';
}

const DOC_NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'xmlns:o="urn:schemas-microsoft-com:office:office"',
  'xmlns:w10="urn:schemas-microsoft-com:office:word"',
  // Markup Compatibility + the wps prefix so Exact-mode text boxes can be emitted
  // as <mc:AlternateContent>: a wps Choice (modern DrawingML text box, used by
  // Word 2010+, LibreOffice and Google Docs) with a legacy VML <mc:Fallback> that
  // Word-2007-era readers — and some Word text-editing paths — use instead.
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
].join(' ');

/**
 * @param {object} model editor export model (from engine.getExportModel())
 * @param {{ mode?:'editable'|'layout'|'hybrid', name?:string }} [opts]
 * @returns {Blob}
 */
export function modelToDocx(model, opts = {}) {
  const content = buildContentModel(model, opts.name);
  // Images cropped out of the page raster (logos, photo, seals) that the editor
  // baked into the background at import — merged in so the faithful layout can
  // place them as real, editable Word images. See services/convert/rasterImages.js.
  if (opts.extraImages) {
    opts.extraImages.forEach((imgs, i) => {
      if (content.pages[i] && Array.isArray(imgs)) content.pages[i].images.push(...imgs);
    });
  }
  const mode = opts.mode || 'editable';
  const media = []; // { name, bytes, ext }
  const rels = [];  // { id, target }

  const addImage = (src) => {
    const bytes = dataURLToBytes(src);
    const ext = /^data:image\/png/i.test(src) ? 'png' : 'jpg';
    const idx = media.length + 1;
    const name = `image${idx}.${ext}`;
    media.push({ name, bytes, ext });
    const id = `rId${100 + idx}`;
    rels.push({ id, target: `media/${name}` });
    return id;
  };

  resetLists();
  let bodyXml;
  if (mode === 'exact') bodyXml = absoluteBody(content, addImage, opts.cleanBg);
  else if (mode === 'layout') bodyXml = faithfulBody(content, addImage, opts.inlineImages);
  else bodyXml = flowBody(content, mode === 'hybrid' ? addImage : null);

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document ${DOC_NS}><w:body>${bodyXml}</w:body></w:document>`;

  const numbering = listReg.defs.length ? buildNumberingXml(listReg.defs) : null;
  return packDocx(documentXml, media, rels, [], numbering);
}

/**
 * Export a DOCUMENT-editor POSITIONED (exact-layout) model — the one the PDF→Doc
 * "Transfer to Doc" builds (services/convert/positionedImport.js) — to a .docx that
 * looks like the original page instead of a flat, stacked column.
 *
 * The model is different from the PDF-editor content model: `doc.layout==='positioned'`,
 * `doc.pages=[{bg,width,height}]` (per-page raster) and `doc.blocks` are `posbox`
 * blocks ({page, frame:{x,y,w,h}, style, fill, runs:[{text,marks}]}) — already ONE
 * box per line. Each page is the full-page raster picture (borders/shading/seals/
 * photo) with every line laid on top.
 *
 * The overlay lines are POSITIONED TEXT FRAMES (`w:framePr`), NOT floating text boxes.
 * A frame is a real body paragraph anchored to absolute page coordinates: you click
 * it and type like normal text — no shape to select first, no double-click-to-edit,
 * and no object border/handles. (Floating text boxes looked identical but Word treats
 * them as drawing objects — single click selects the box, which is the "it treats it
 * as a selection not editing" complaint.)
 *
 * To avoid any VISIBLE box, the baked glyph is ERASED from the page raster at export
 * (each line's sampled `fill` painted over its area) so the frames can be fully
 * TRANSPARENT — no `w:shd` fill and no border, so nothing shows around the text and
 * there is no doubling. If the raster can't be edited (no canvas, e.g. Node), it
 * falls back to opaque `w:shd`-filled frames over the original raster (a faint box in
 * off-white areas, but never doubled text).
 */
export async function positionedModelToDocx(doc) {
  const pages = doc.pages || [];
  const media = [];
  const rels = [];
  const addImage = (src) => {
    const bytes = dataURLToBytes(src);
    const ext = /^data:image\/png/i.test(src) ? 'png' : 'jpg';
    const idx = media.length + 1;
    const name = `image${idx}.${ext}`;
    media.push({ name, bytes, ext });
    const id = `rId${100 + idx}`;
    rels.push({ id, target: `media/${name}` });
    return id;
  };

  const boxesByPage = new Map();
  for (const b of doc.blocks || []) {
    if (!b || b.type !== 'posbox') continue;
    const pi = b.page || 0;
    if (!boxesByPage.has(pi)) boxesByPage.set(pi, []);
    boxesByPage.get(pi).push(b);
  }

  const parts = [];
  let z = 1;
  const fallbackW = (doc.page && doc.page.width) || 794;
  const fallbackH = (doc.page && doc.page.height) || 1123;

  const list = pages.length ? pages : [{ width: fallbackW, height: fallbackH }];
  // Erase the baked text so the overlay frames can be transparent (no visible box).
  // One cleaned raster per page, or null for that page → keep the opaque-mask fallback.
  const cleanBg = await erasePositionedText(list, boxesByPage);

  list.forEach((pg, pi) => {
    const w = pg.width || fallbackW;
    const h = pg.height || fallbackH;
    const erased = cleanBg && cleanBg[pi];
    const bgSrc = erased || pg.bg;
    const pageParts = [];
    // Page raster BEHIND the text (all the graphics: borders, shading, seal, photo).
    if (bgSrc) {
      const bgId = addImage(bgSrc);
      pageParts.push(`<w:p><w:r>${anchor(0, 0, w, h, z++, pictureGraphic(w, h, bgId, z), true)}</w:r></w:p>`);
    }
    // Each line → a positioned, inline-editable text frame. Transparent when the
    // raster was erased under it; otherwise opaque-shaded to mask the baked glyph.
    for (const box of (boxesByPage.get(pi) || [])) {
      const p = framedParagraph(box, !erased);
      if (p) pageParts.push(p);
    }
    const sectPr = `<w:sectPr><w:pgSz w:w="${TW(w)}" w:h="${TW(h)}"/>`
      + '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>';
    if (!pageParts.length) pageParts.push('<w:p><w:r><w:t/></w:r></w:p>');
    if (pi < list.length - 1) {
      parts.push(pageParts.join(''));
      parts.push(`<w:p><w:pPr>${sectPr}</w:pPr></w:p>`); // ends section → page break
    } else {
      parts.push(pageParts.join(''));
      parts.push(sectPr);
    }
  });

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document ${DOC_NS}><w:body>${parts.join('')}</w:body></w:document>`;
  // Re-import sidecar: the ORIGINAL positioned model (dormant boxes + original,
  // non-erased page rasters). Re-opening in the Document editor restores this
  // verbatim — a pixel-perfect round-trip (no font-substitution/overlap), instead of
  // rebuilding lossily from the OOXML frames. GZIPPED to keep the file small (the
  // model's base64 rasters lose their ~33% base64 overhead under DEFLATE). Falls back
  // to no sidecar if compression is unavailable. Word/LibreOffice ignore this part.
  let extraParts = [];
  try {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, model: doc }));
    extraParts = [{ name: 'docmaster/model.json.gz', ext: 'gz', data: await gzipBytes(bytes) }];
  } catch { extraParts = []; } // never let the sidecar fail the export
  return packDocx(documentXml, media, rels, extraParts);
}

/**
 * Export a DOCUMENT-editor POSITIONED model as a NORMAL, fully-editable Word
 * document — standard paragraphs (`w:p`) / runs (`w:r`) and genuine tables
 * (`w:tbl`), NOT absolutely-positioned text frames or drawing objects. Word,
 * Google Docs and LibreOffice all let you click and type in these directly, so no
 * ordinary line ends up trapped inside an editable box/shape the way the frame
 * ("exact") export leaves it.
 *
 * How: each `posbox` line is fed (per page) as a positioned text run to the
 * geometry reconstruction (`reconstructPages` in services/convert/reconstruct.js)
 * that groups runs into reading-order headings/paragraphs and detects aligned
 * grids as real tables — the SAME machine that powers the PDF exporter's editable
 * "layout" mode. A line's sampled `fill` is carried as `boxBg` so coloured header
 * bars / table-header cells reappear as native paragraph / cell shading.
 *
 * Trade-off (deliberate, per product direction): the decorative full-page raster
 * baked in at import (page borders, shading, logos) is DROPPED — we favour a clean,
 * editable, Word-compatible document over pixel-exact appearance. Callers that need
 * the pixel-perfect positioned layout use `positionedModelToDocx` instead.
 */
export function positionedModelToEditableDocx(doc) {
  const media = [];
  const rels = [];
  const addImage = (src) => {
    const bytes = dataURLToBytes(src);
    const ext = /^data:image\/png/i.test(src) ? 'png' : 'jpg';
    const idx = media.length + 1;
    const name = `image${idx}.${ext}`;
    media.push({ name, bytes, ext });
    const id = `rId${100 + idx}`;
    rels.push({ id, target: `media/${name}` });
    return id;
  };

  const fallbackW = (doc.page && doc.page.width) || 794;
  const fallbackH = (doc.page && doc.page.height) || 1123;
  const srcPages = (doc.pages && doc.pages.length) ? doc.pages : [{ width: fallbackW, height: fallbackH }];
  const pages = srcPages.map((pg, i) => ({
    index: i, w: pg.width || fallbackW, h: pg.height || fallbackH, runs: [], images: [],
  }));

  for (const b of doc.blocks || []) {
    if (!b || b.type !== 'posbox') continue;
    const pi = pages[b.page || 0] ? (b.page || 0) : 0;
    const f = b.frame || {};
    const text = (b.runs || []).map((r) => (r && r.text) || '').join('');
    if (!text.trim()) continue;
    // Use the marks of the first non-empty run for the whole line — the reconstruction
    // (like the PDF path) carries ONE style per line, so a line's dominant style wins.
    const lead = (b.runs || []).find((r) => r && r.text && String(r.text).trim()) || (b.runs && b.runs[0]) || {};
    const m = lead.marks || {};
    pages[pi].runs.push({
      text,
      x: f.x || 0, y: f.y || 0, w: f.w || 0,
      h: f.h || Math.max(1, Math.round((m.fontSize || 14) * 1.2)),
      fontSize: m.fontSize || 14,
      bold: !!m.bold, italic: !!m.italic,
      color: normHex(m.color) || undefined,
      fontFamily: m.fontFamily,
      align: (b.style && b.style.align) || 'left',
      boxBg: normHex(b.fill) || '',
    });
  }

  resetLists();
  const bodyXml = faithfulBody({ pages }, addImage, true);
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document ${DOC_NS}><w:body>${bodyXml}</w:body></w:document>`;
  const numbering = listReg.defs.length ? buildNumberingXml(listReg.defs) : null;
  return packDocx(documentXml, media, rels, [], numbering);
}

/** GZIP a byte array via the platform CompressionStream (browser + Node 18+). */
async function gzipBytes(u8) {
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter();
  w.write(u8); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/** Paint each line's sampled `fill` over ONLY its glyph rows in the page raster, so
 *  the export's overlay frames can be transparent (no visible box, no doubling) while
 *  the table grid lines survive. Returns an array of cleaned data-URLs (one per page,
 *  null where nothing could be cleaned) or null when there's no canvas (Node) — caller
 *  then keeps the opaque-mask fallback.
 *
 *  Erasing the FULL frame rectangle whited out the horizontal cell rules sitting just
 *  above/below the text (the "faint/broken borders" report). Instead, detect the tight
 *  band of rows that actually contain glyph ink and erase only that — the rules, which
 *  live in the padding rows outside the ink band, stay intact. */
async function erasePositionedText(pages, boxesByPage) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const out = [];
  let any = false;
  for (let pi = 0; pi < pages.length; pi += 1) {
    const pg = pages[pi];
    const boxes = boxesByPage.get(pi) || [];
    if (!pg.bg || !boxes.length) { out[pi] = null; continue; }
    try {
      const img = await loadImage(pg.bg);
      const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const scale = W / (pg.width || W);
      const data = ctx.getImageData(0, 0, W, H).data;
      for (const box of boxes) {
        const fill = normHex(box.fill);
        if (!fill) continue;
        const f = box.frame || {};
        const x = Math.round((f.x || 0) * scale);
        const w = Math.round((f.w || 0) * scale);
        const band = inkBand(data, W, H, f, scale, hexLuma(fill));
        ctx.fillStyle = `#${fill}`;
        if (band) ctx.fillRect(x, band.top, w, band.h);         // glyph rows only → keep the rules
        else ctx.fillRect(x, Math.round((f.y || 0) * scale), w, Math.round((f.h || 0) * scale)); // no ink found → full frame
      }
      out[pi] = canvas.toDataURL('image/jpeg', 0.92);
      any = true;
    } catch { out[pi] = null; }
  }
  return any ? out : null;
}

/** Luminance (0..255) of a 6-hex colour. */
function hexLuma(hex) {
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** The tight vertical band (raster px) of the TALLEST contiguous run of glyph-ink rows
 *  inside a frame (a row is ink when >=3% of the width differs from the box's
 *  background), padded 1px for anti-aliasing. Using the tallest contiguous run (not
 *  the first..last ink row) means a thin cell rule sitting a few px above/below the
 *  text — a separate short run — is NOT swept into the band, so the eraser spares it.
 *  null when the frame has no ink. */
export function inkBand(data, W, H, f, scale, bgLum) {
  const x0 = Math.max(0, Math.round(f.x * scale)), y0 = Math.max(0, Math.round(f.y * scale));
  const x1 = Math.min(W, Math.round((f.x + f.w) * scale)), y1 = Math.min(H, Math.round((f.y + f.h) * scale));
  const wpx = x1 - x0;
  if (wpx < 2 || y1 - y0 < 2) return null;
  const lum = (x, y) => { const i = (y * W + x) * 4; return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; };
  const minInk = Math.max(2, Math.round(wpx * 0.03));
  let bestTop = -1, bestLen = 0, curStart = -1;
  for (let y = y0; y < y1; y += 1) {
    let n = 0;
    for (let x = x0; x < x1; x += 1) if (Math.abs(lum(x, y) - bgLum) > 60) { n += 1; if (n >= minInk) break; }
    if (n >= minInk) {
      if (curStart < 0) curStart = y;
      if (y - curStart + 1 > bestLen) { bestLen = y - curStart + 1; bestTop = curStart; }
    } else curStart = -1;
  }
  if (bestLen <= 0) return null;
  const top = Math.max(y0, bestTop - 1), bot = Math.min(y1 - 1, bestTop + bestLen - 1 + 1);
  return { top, h: bot - top + 1 };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

/** One `posbox` line → a positioned text frame paragraph: absolute page coordinates
 *  via `w:framePr` (so it's placed exactly, yet edits like normal body text). With
 *  `mask` it is shaded with the box's sampled `fill` to hide the raster glyph beneath
 *  (used only when the raster wasn't erased); otherwise it is fully transparent — no
 *  fill, no border — so nothing shows around the text. Returns '' for an empty box. */
function framedParagraph(box, mask) {
  const f = box.frame || {};
  const runsXml = (box.runs || [])
    .filter((r) => r && r.text != null && String(r.text).length)
    .map((r) => {
      const m = r.marks || {};
      const rpr = runProps({
        bold: m.bold, italic: m.italic, size: SZHP(m.fontSize || 14),
        color: normHex(m.color) || '111111', font: m.fontFamily,
      });
      return '<w:r>' + rpr + `<w:t xml:space="preserve">${xml(String(r.text))}</w:t></w:r>`;
    }).join('');
  if (!runsXml) return '';
  const align = box.style && box.style.align;
  const jc = align === 'center' ? '<w:jc w:val="center"/>' : align === 'right' ? '<w:jc w:val="right"/>' : '';
  const fill = mask ? normHex(box.fill) : '';
  const shd = fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : '';
  // hRule="exact" keeps the frame the line's height; wrap="none" lets frames overlap
  // freely (form fields sit close together) instead of shoving each other around.
  const framePr = `<w:framePr w:w="${TW(f.w || 0)}" w:h="${TW(f.h || 0)}" w:hRule="exact" w:wrap="none"`
    + ` w:vAnchor="page" w:hAnchor="page" w:x="${TW(f.x || 0)}" w:y="${TW(f.y || 0)}" w:hSpace="0" w:vSpace="0"/>`;
  return `<w:p><w:pPr>${framePr}${shd}<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>${jc}</w:pPr>${runsXml}</w:p>`;
}

/* --------------------------- editable / hybrid --------------------------- */

function runProps({ bold, italic, underline, size, color, font }) {
  return '<w:rPr>' +
    `<w:rFonts w:ascii="${xml(font || 'Calibri')}" w:hAnsi="${xml(font || 'Calibri')}"/>` +
    (bold ? '<w:b/>' : '') + (italic ? '<w:i/>' : '') +
    (color ? `<w:color w:val="${xml(color)}"/>` : '') +
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` +
    (underline ? '<w:u w:val="single"/>' : '') + // schema order: u sits after sz
    '</w:rPr>';
}

function textRuns(text, rpr) {
  // Preserve explicit line breaks within a block.
  return String(text).split('\n').map((line, i) =>
    '<w:r>' + rpr + (i ? '<w:br/>' : '') + `<w:t xml:space="preserve">${xml(line)}</w:t></w:r>`
  ).join('');
}

// A fill-in blank in a form is a run of underscores (e.g. "Name: ______"). PDFs draw
// them as underscore GLYPHS sitting on the text baseline, so anything typed there
// lands on the same baseline and collides with the underscores/border. The correct,
// editable Word representation is a run of blank spaces with UNDERLINE formatting: the
// underline draws the line just below the baseline, so text typed into the field sits
// naturally ABOVE it. We add a leading space as left padding inside the field.
const FIELD_BLANK_RE = /_{3,}/g;
/** Emit `text` as runs, converting underscore fill-in blanks to underlined spaces so
 *  the field is an editable, non-overlapping fill line. `marks` is the base run style. */
function fieldRuns(text, marks) {
  const s = String(text == null ? '' : text);
  if (!/_{3,}/.test(s)) return textRuns(s, runProps(marks));
  const base = runProps(marks);
  const under = runProps({ ...marks, underline: true });
  let out = '';
  let last = 0;
  s.replace(FIELD_BLANK_RE, (m, idx) => {
    if (idx > last) out += textRuns(s.slice(last, idx), base);
    // ' ' left pad + one blank space per underscore (kept editable; underline stroke
    // replaces the glyphs so typed text no longer sits on top of them).
    out += '<w:r>' + under + `<w:t xml:space="preserve">${xml(' ' + ' '.repeat(m.length))}</w:t></w:r>`;
    last = idx + m.length;
    return m;
  });
  if (last < s.length) out += textRuns(s.slice(last), base);
  return out;
}

/** Flow the reading-order blocks as normal Word paragraphs. */
function flowBody(content, addImage) {
  const out = [];
  const H = { 1: 36, 2: 30, 3: 26 }; // heading half-point sizes (18/15/13pt)

  for (const b of content.blocks) {
    if (b.type === 'heading') {
      const sz = H[b.level] || 26;
      out.push('<w:p><w:pPr><w:spacing w:before="240" w:after="120"/><w:keepNext/></w:pPr>' +
        textRuns(b.text, runProps({ bold: true, size: sz, color: '1f2937' })) + '</w:p>');
    } else if (b.type === 'bullet') {
      // Real, editable Word bullet list (numbering-driven marker + indent) instead of
      // a literal "•\t" typed into the text.
      const np = listNumPr({ kind: 'bullet' });
      out.push('<w:p><w:pPr>' + np + '<w:spacing w:after="80"/></w:pPr>' +
        textRuns(b.text, runProps({ size: 22 })) + '</w:p>');
    } else {
      out.push('<w:p><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr>' +
        textRuns(b.text, runProps({ size: 22 })) + '</w:p>');
    }
  }

  // Hybrid: append the document's discrete images (logos, photos), inline and
  // centred — never the page-background raster.
  if (addImage) {
    for (const p of content.pages) {
      for (const im of p.images) {
        out.push(inlineImageParagraph(im, addImage));
      }
    }
  }

  if (!out.length) {
    out.push('<w:p><w:r>' + runProps({ size: 22 }) +
      '<w:t xml:space="preserve">No extractable text was found in this document.</w:t></w:r></w:p>');
  }
  // Body-level section (default A4-ish; Word will fit content).
  out.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>');
  return out.join('');
}

function inlineImageParagraph(im, addImage) {
  const id = addImage(im.src);
  const wEmu = Math.round((im.w || 200) * 9525);
  const hEmu = Math.round((im.h || 200) * 9525);
  return '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="160"/></w:pPr>' +
    '<w:r><w:pict>' +
    `<v:shape style="width:${PT(im.w || 200)}pt;height:${PT(im.h || 200)}pt" o:spt="75" type="#_x0000_t75">` +
    `<v:imagedata r:id="${id}"/></v:shape>` +
    '</w:pict></w:r></w:p>';
}

/* ------------------ editable reconstruction (tables/flow) ---------------- */

/**
 * Rebuild the page as NATIVE, fully-editable Word objects: detected grids become
 * real `<w:tbl>` tables (editable cells), coloured heading bars and shaded cells
 * are reproduced with paragraph/cell shading (`<w:shd>`), images are inline
 * pictures, and the rest is styled headings/paragraphs. Everything here — unlike
 * the absolute floating text boxes — is directly editable in Word AND Google Docs
 * (which lets you type in paragraphs and table cells, but not in floating boxes).
 * The trade-off is flow-based layout rather than pixel-exact positioning.
 */
function faithfulBody(content, addImage, inlineImages = false) {
  const parts = [];
  const pages = reconstructPages(content);
  let drawId = 1;
  const nextDrawId = () => drawId++;

  const MARGIN_PX = 24; // matches the section's 360-twip top margin below

  pages.forEach((pg, pi) => {
    const imgBlocks = [];
    const flow = [];
    let lastWasTable = false;
    // Reproduce the PDF's VERTICAL RHYTHM: each flow block is spaced from the bottom
    // of the previous one by the real pixel gap, so blank lines / section breaks in
    // the source reappear instead of everything collapsing to a uniform tight stack.
    let prevBottom = MARGIN_PX;
    const gapBefore = (b) => Math.max(0, (b._y || 0) - prevBottom);
    const advance = (b) => { prevBottom = Math.max(prevBottom, b._bottom || b._y || prevBottom); };
    for (const b of pg.blocks) {
      if (b.type === 'table') {
        const before = gapBefore(b);
        if (lastWasTable) flow.push(TABLE_SEP); // keep adjacent tables from merging
        else if (before > 4) flow.push(spacerPara(before)); // tables can't carry before-spacing
        listBreak(); // a table ends any running numbered list
        flow.push(tableXml(b, addImage));
        advance(b);
        lastWasTable = true;
      } else if (b.type === 'image') {
        // Inline mode (used when the target is the flowing Document editor): emit the
        // picture INLINE at its reading-order position so it pushes content down.
        // Floated at absolute PDF coordinates it would overlap the reflowed text,
        // because the flow editor does not preserve the PDF's y positions.
        if (inlineImages) {
          const before = gapBefore(b);
          listBreak();
          if (before > 4) flow.push(spacerPara(before));
          flow.push(inlineImagePara(b, addImage, pg.w));
          advance(b);
          lastWasTable = false;
        } else imgBlocks.push(b); // floating: doesn't take part in the flow's rhythm
      }
      else { flow.push(styledPara(b, addImage, gapBefore(b))); advance(b); lastWasTable = false; }
    }
    if (lastWasTable) flow.push(TABLE_SEP); // required paragraph after a trailing table
    // Images as FLOATING, page-anchored drawings at their exact PDF position and
    // size — a logo, barcode, photo or signature stays pinned where it belongs,
    // and two images can sit side by side (impossible with inline paragraphs,
    // which stack). Text/tables remain normal editable flow. All page-relative,
    // so one carrier paragraph per page is enough. (Skipped in inline mode above.)
    if (imgBlocks.length) {
      const anchors = imgBlocks.map((b) => {
        const rId = addImage(b.src);
        const id = nextDrawId();
        return anchor(b.x, b.y, b.w, b.h, id, pictureGraphic(b.w, b.h, rId, id));
      }).join('');
      parts.push(`<w:p><w:r>${anchors}</w:r></w:p>`);
    }
    for (const f of flow) parts.push(f);
    listBreak(); // list numbering never continues across a page/section boundary
    const secW = TW(pg.w), secH = TW(pg.h);
    const sectPr = `<w:sectPr><w:pgSz w:w="${secW}" w:h="${secH}"/>`
      + '<w:pgMar w:top="360" w:right="360" w:bottom="360" w:left="360" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>';
    if (pi < pages.length - 1) parts.push(`<w:p><w:pPr>${sectPr}</w:pPr></w:p>`);
    else parts.push(sectPr);
  });

  if (!pages.length) {
    parts.push('<w:p><w:r><w:t>Empty document.</w:t></w:r></w:p>');
    parts.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>');
  }
  return parts.join('');
}

/** Shading element for a paragraph/cell, unless the colour is near-white (which
 *  is a normal background and shouldn't be painted). */
function shd(color) {
  const h = normHex(color);
  if (!h) return '';
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  if (r > 236 && g > 236 && b > 236) return '';
  return `<w:shd w:val="clear" w:color="auto" w:fill="${h}"/>`;
}

let cropUid = 900000; // docPr ids for inline cropped-script images (unique per doc)

/** One inline image run: a complex-script segment rasterised from the page (see
 *  aiWordConvert) so it renders correctly where editable Unicode would scramble. */
function inlineImageRun(im, addImage) {
  if (!addImage || !im || !im.src) return '';
  const rId = addImage(im.src);
  const w = EMU(im.w || 20), h = EMU(im.h || 12);
  const id = cropUid++;
  return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
    + `<wp:extent cx="${w}" cy="${h}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
    + `<wp:docPr id="${id}" name="crop${id}"/><wp:cNvGraphicFramePr/>`
    + `<a:graphic xmlns:a="${A_NS}">${pictureGraphic(im.w || 20, im.h || 12, rId, id)}</a:graphic>`
    + '</wp:inline></w:drawing></w:r>';
}

/** A whole page image emitted INLINE as its own centered paragraph, clamped to the
 *  page's content width so a large figure never overflows the margins. Keeps the
 *  picture in reading-order flow (no absolute float → no overlap with reflowed text).
 *  Used for the "open in Document editor" handoff; the downloadable Word keeps floats. */
function inlineImagePara(b, addImage, pageW) {
  const maxW = Math.max(48, (pageW || 794) - 96); // leave room for the page margins
  let w = b.w || 200, h = b.h || 150;
  if (w > maxW) { h = Math.round(h * (maxW / w)); w = maxW; }
  return '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="40" w:after="40"/></w:pPr>'
    + inlineImageRun({ src: b.src, w, h }, addImage)
    + '</w:p>';
}

/** Render content lines (see reconstruct.runsToContentLines) as a paragraph body:
 *  lines stack via <w:br/>; tokens within a line are inline (image runs or text).
 *  `marks` is the base run style; text tokens go through fieldRuns so form fill-in
 *  blanks become underlined (editable, non-overlapping) fields. */
function renderContent(lines, marks, addImage) {
  const rpr = runProps(marks);
  return (lines || []).map((toks, i) => {
    const br = i ? `<w:r>${rpr}<w:br/></w:r>` : '';
    const body = (toks || []).map((t) => (t.img
      ? inlineImageRun(t.img, addImage)
      : fieldRuns(t.text, marks))).join('');
    return br + body;
  }).join('');
}

/** A styled heading/paragraph, preserving size/weight/italic/colour/alignment,
 *  left indent, and a coloured bar (paragraph shading) when the run sat on one.
 *  `b.lines` (image/text tokens) take precedence over the plain `b.text`. */
function styledPara(b, addImage, beforePx = null) {
  const st = b.style || {};
  const shading = shd(st.boxBg);
  const jc = b.align === 'center' ? '<w:jc w:val="center"/>'
    : b.align === 'right' ? '<w:jc w:val="right"/>'
      : b.align === 'justify' ? '<w:jc w:val="both"/>' : '';
  // When the caller measured the real gap above this block (faithful/layout mode),
  // use it verbatim so the PDF's vertical spacing is preserved; otherwise fall back
  // to the old fixed heading/body spacing (AI-region paragraphs, which have no y).
  const before = beforePx == null ? (b.type === 'heading' ? 80 : 20) : TW(beforePx);
  const after = beforePx == null ? (b.type === 'heading' ? 40 : 20) : 0;
  const marks = {
    bold: st.bold || b.type === 'heading', italic: st.italic,
    size: SZHP(st.size || 16), color: st.color, font: st.font,
  };
  const body = (b.lines && b.lines.length) ? renderContent(b.lines, marks, addImage) : fieldRuns(b.text, marks);
  // Real, editable Word list item: `<w:numPr>` drives the marker + indent (no manual
  // `w:ind`), so numbers renumber and bullets stay bullets when the user edits.
  if (b.list && b.list.kind) {
    const np = listNumPr(b.list);
    return `<w:p><w:pPr>${np}${shading}<w:spacing w:before="${before}" w:after="${after}"/>${jc}</w:pPr>`
      + body + '</w:p>';
  }
  listBreak(); // a non-list paragraph/heading ends any running numbered list
  // A left indent only makes sense for left/justified text; for centred or right
  // text the x-indent would fight `jc` and shove the line off-position (the reported
  // "misses coordination" bug), so let the alignment place it instead.
  const centeredOrRight = b.align === 'center' || b.align === 'right';
  const ind = b.x > 4 && !shading && !centeredOrRight ? `<w:ind w:left="${TW(b.x)}"/>` : '';
  return `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${after}"/>${shading}${jc}${ind}</w:pPr>`
    + body + '</w:p>';
}

/** An empty paragraph of an EXACT pixel height — used to reproduce a large vertical
 *  gap before a block (e.g. a table) that can't carry `w:spacing w:before`. */
function spacerPara(px) {
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${Math.max(1, TW(px))}" w:lineRule="exact"/></w:pPr></w:p>`;
}

/** Emit a detected grid as a real Word table (editable cells, borders, spans). */
function tableXml(tbl, addImage) {
  const n = tbl.cols.length;
  const grid = tbl.cols.map((w) => `<w:gridCol w:w="${TW(w)}"/>`).join('');
  const totalTw = tbl.cols.reduce((s, w) => s + TW(w), 0);
  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`;
  const borders = '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')
    + '</w:tblBorders>';
  const cellMar = '<w:tblCellMar><w:top w:w="8" w:type="dxa"/><w:left w:w="80" w:type="dxa"/>'
    + '<w:bottom w:w="8" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar>';
  const ind = tbl.left > 4 ? `<w:tblInd w:w="${TW(tbl.left)}" w:type="dxa"/>` : '';
  const tblPr = '<w:tblPr>'
    + `<w:tblW w:w="${totalTw}" w:type="dxa"/>${ind}<w:tblLayout w:type="fixed"/>`
    + borders + cellMar + '</w:tblPr>';

  const rows = tbl.rows.map((cells) => {
    let covered = 0;
    const tcs = cells.map((c) => { covered += c.span; return cellXml(c, tbl.cols, addImage); }).join('');
    let pad = '';
    if (covered < n) {
      const wsum = sumCols(tbl.cols, covered, n - covered);
      pad = `<w:tc><w:tcPr><w:tcW w:w="${wsum}" w:type="dxa"/>`
        + (n - covered > 1 ? `<w:gridSpan w:val="${n - covered}"/>` : '')
        + '<w:vAlign w:val="center"/></w:tcPr><w:p/></w:tc>';
    }
    return `<w:tr>${tcs}${pad}</w:tr>`;
  }).join('');

  // No trailing paragraph here — callers insert a minimal separator ONLY where OOXML
  // needs one (between two adjacent tables, or after a final table). An unconditional
  // empty paragraph after every table bloated pages and spawned blank pages in Word.
  return `<w:tbl>${tblPr}<w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
}

// Minimal paragraph that keeps two tables from merging / caps a trailing table,
// with near-zero height so it doesn't inflate the page.
const TABLE_SEP = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="60" w:lineRule="exact"/></w:pPr></w:p>';

function cellXml(c, cols, addImage) {
  const wsum = sumCols(cols, c.colStart, c.span);
  const st = c.style || {};
  const jc = c.align === 'center' ? '<w:jc w:val="center"/>'
    : c.align === 'right' ? '<w:jc w:val="right"/>' : '';
  const marks = {
    bold: st.bold, italic: st.italic, size: SZHP(st.size || 14),
    color: st.color, font: st.font,
  };
  const body = (c.lines && c.lines.length) ? renderContent(c.lines, marks, addImage)
    : (c.text ? fieldRuns(c.text, marks) : '');
  const para = `<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>${jc}</w:pPr>`
    + body + '</w:p>';
  const span = c.span > 1 ? `<w:gridSpan w:val="${c.span}"/>` : '';
  return `<w:tc><w:tcPr><w:tcW w:w="${wsum}" w:type="dxa"/>${span}${shd(st.boxBg)}<w:vAlign w:val="center"/></w:tcPr>${para}</w:tc>`;
}

function sumCols(cols, start, span) {
  let s = 0;
  for (let i = start; i < start + span && i < cols.length; i += 1) s += TW(cols[i]);
  return s;
}

/* --------------------- position-faithful (absolute) ---------------------- */

const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const WPS_NS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';

/**
 * Reproduce the PDF page EXACTLY, using absolute positioning. Two cases:
 *
 *  • Imported PDF page (has a background raster): the raster carries every graphic
 *    the model doesn't hold as data — coloured bars, box fills, borders, seals,
 *    signatures, the watermark — so we lay the raster down as a full-page picture
 *    and overlay each text run as a page-anchored, editable text box FILLED with
 *    its sampled `boxBg` colour, which masks the glyph baked into the raster. The
 *    page therefore looks pixel-identical to the PDF, yet the text stays editable.
 *    (This is exactly how the on-screen editor renders imported pages.)
 *
 *  • Blank-editor page (no raster): nothing is baked, so reconstruct vector-side —
 *    editable text boxes, discrete images, and drawn cell borders for detected
 *    grids, all at absolute coordinates.
 *
 * Either way nothing flows; coordinates/sizes/fonts/colours map straight from the
 * PDF. One zero-margin Word section per page, sized to the PDF page. DrawingML
 * (wp:anchor) is used, not legacy VML, for reliable positioning in Word/LibreOffice.
 */
function absoluteBody(content, addImage, cleanBg) {
  const parts = [];
  const pages = content.pages;
  let z = 1;

  pages.forEach((pg, pi) => {
    const anchors = [];  // floating drawings only (raster bg, images, table borders)
    const framed = [];   // positioned TEXT FRAMES — body paragraphs, no box outline
    // Prefer the text-erased raster (see rasterImages.maskExtractedText): with the
    // baked glyphs already painted out, the overlay frames can be fully transparent
    // (nothing shows around the text). Falls back to the original background.
    const bgSrc = (cleanBg && cleanBg[pi]) || pg.bg;
    const hasRaster = !!bgSrc;
    const erased = !!(cleanBg && cleanBg[pi]); // glyphs already removed → transparent frames

    if (hasRaster) {
      // Full-page background raster (all graphics), then editable text on top.
      // The raster already carries every picture (logo/signature/photo/QR) exactly,
      // so we do NOT overlay recovered images here: recovery is best-effort and a
      // mis-detected region (e.g. a pale form-field box) would drop a blank crop
      // over real text. Exact = raster + editable text, nothing covering it.
      const bgId = addImage(bgSrc);
      anchors.push(anchor(0, 0, pg.w, pg.h, z++, pictureGraphic(pg.w, pg.h, bgId, z), true));
      // Overlay the text as LINE-SEGMENT positioned FRAMES (whole phrases/lines),
      // not one per glyph, so the result is genuinely editable (you type into
      // sentences). Frames carry no shape outline, so no grey box is drawn around
      // each line. When the raster wasn't erased, the frame is shaded with its
      // sampled background to mask the baked glyph. Complex-script runs are excluded
      // and left baked in the raster (an editable overlay would scramble matras).
      for (const seg of segmentRuns(pg.runs, { mask: true })) {
        const fs = seg.parts[0].run.fontSize || 14;
        const w = Math.max(seg.right - seg.x, fs * 0.5);
        const h = Math.max(seg.h || 0, fs * 1.3);
        framed.push(framedSeg(seg, w, h, erased));
      }
    } else {
      // 1) Table cell borders first (drawn behind text/images).
      for (const region of detectTableRegions(pg.runs, pg.w)) {
        for (const row of region.rows) {
          for (const col of region.cols) {
            anchors.push(anchor(col.x, row.y, col.w, row.h, z++, borderRectGraphic(col.w, row.h)));
          }
        }
      }
      // 2) Discrete images at their exact box.
      for (const im of pg.images) {
        const rId = addImage(im.src);
        anchors.push(anchor(im.x, im.y, im.w, im.h, z++, pictureGraphic(im.w, im.h, rId, z)));
      }
      // 3) Text as positioned frames (no raster to mask → always transparent).
      for (const seg of segmentRuns(pg.runs, { mask: false })) {
        const fs = seg.parts[0].run.fontSize || 14;
        const w = (seg.right - seg.x) + fs * 1.4;
        const h = Math.max(seg.h || 0, fs * 1.25) + 2;
        framed.push(framedSeg(seg, w, h, true));
      }
    }

    const secW = TW(pg.w), secH = TW(pg.h);
    const sectPr = `<w:sectPr><w:pgSz w:w="${secW}" w:h="${secH}"/>`
      + '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>';
    // One carrier paragraph holds all floating drawings (page-relative offsets → order
    // is only z-order); the positioned text frames follow as their own paragraphs.
    if (anchors.length) parts.push(`<w:p><w:r>${anchors.join('')}</w:r></w:p>`);
    for (const f of framed) parts.push(f);
    if (!anchors.length && !framed.length) parts.push('<w:p/>');
    if (pi < pages.length - 1) parts.push(`<w:p><w:pPr>${sectPr}</w:pPr></w:p>`); // section break → new page
    else parts.push(sectPr);
  });

  if (!pages.length) {
    parts.push('<w:p><w:r><w:t>Empty document.</w:t></w:r></w:p>');
    parts.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>');
  }
  return parts.join('');
}

/**
 * Group a page's runs into LINE SEGMENTS for the editable overlay: contiguous runs
 * that share a baseline AND (when masking) the same sampled background, with no
 * column-width gap between them. Each segment becomes ONE editable text box holding
 * its words as separate styled runs — so bold/colour/size variation within a line
 * is preserved, yet the whole phrase edits as a unit (fixing the per-glyph mosaic).
 *
 * A segment never spans a column gap (>~1.2 em) or a background-colour change, so
 * its boxBg mask stays tight over a single uniform region. With `mask:true`,
 * complex-script runs are dropped (kept baked in the raster — see hasComplexScript).
 *
 * @returns {{x:number, top:number, right:number, h:number, bg:string,
 *   parts:{run:object, space:boolean}[]}[]}
 */
export function segmentRuns(runs, { mask }) {
  const usable = (runs || []).filter((r) =>
    String(r && r.text != null ? r.text : '').length && !(mask && hasComplexScript(r.text)));
  const sorted = usable.slice().sort((a, b) => a.y - b.y || a.x - b.x);

  // Group into baseline lines.
  const lines = [];
  for (const r of sorted) {
    const last = lines[lines.length - 1];
    const tol = Math.min(r.h || 0, last ? last.h : (r.h || 0)) * 0.6;
    if (last && Math.abs(r.y - last.y) <= tol) {
      last.parts.push(r);
      last.h = Math.max(last.h, r.h || 0);
      last.y = (last.y * (last.parts.length - 1) + r.y) / last.parts.length;
    } else {
      lines.push({ y: r.y, h: r.h || 0, parts: [r] });
    }
  }

  // Split each line into contiguous, same-background segments.
  const segments = [];
  for (const ln of lines) {
    ln.parts.sort((a, b) => a.x - b.x);
    let seg = null;
    for (const r of ln.parts) {
      const fs = r.fontSize || 14;
      const bg = mask ? (normHex(r.boxBg) || '') : '';
      if (seg && seg.bg === bg) {
        const gap = r.x - seg.right;
        if (gap <= fs * 1.2) {
          // A real inter-word space is ≥ ~0.15 em; a tighter gap is a glyph split.
          const space = gap > fs * 0.15;
          seg.parts.push({ run: r, space });
          seg.right = Math.max(seg.right, r.x + (r.w || 0));
          seg.h = Math.max(seg.h, r.h || 0);
          seg.top = Math.min(seg.top, r.y);
          continue;
        }
      }
      if (seg) segments.push(seg);
      seg = { x: r.x, top: r.y, right: r.x + (r.w || 0), h: r.h || 0, bg, parts: [{ run: r, space: false }] };
    }
    if (seg) segments.push(seg);
  }
  return segments;
}

/** Wrap a graphic in a page-anchored floating drawing at (x,y) sized w×h (px).
 *  `behind=true` sends it behind the text layer (used for the page raster). */
function anchor(x, y, w, h, id, graphicData, behind = false) {
  const X = EMU(Math.max(0, x)), Y = EMU(Math.max(0, y)), W = EMU(w), H = EMU(h);
  return '<w:drawing>'
    + `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" `
    + `behindDoc="${behind ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>`
    + `<wp:positionH relativeFrom="page"><wp:posOffset>${X}</wp:posOffset></wp:positionH>`
    + `<wp:positionV relativeFrom="page"><wp:posOffset>${Y}</wp:posOffset></wp:positionV>`
    + `<wp:extent cx="${W}" cy="${H}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>`
    + `<wp:docPr id="${id}" name="obj${id}"/><wp:cNvGraphicFramePr/>`
    + `<a:graphic xmlns:a="${A_NS}">${graphicData}</a:graphic>`
    + '</wp:anchor></w:drawing>';
}

/** One line-segment's words as separate styled runs (per-word bold/colour/size
 *  survive while the whole line edits as a unit). Shared by the positioned frame. */
function segRunsXml(seg) {
  return seg.parts.map(({ run, space }) => {
    const rpr = runProps({
      bold: run.bold, italic: run.italic, underline: run.underline,
      size: SZHP(run.fontSize || 14), color: run.color, font: run.fontFamily,
    });
    const t = (space ? ' ' : '') + String(run.text == null ? '' : run.text).replace(/\n/g, ' ');
    return '<w:r>' + rpr + `<w:t xml:space="preserve">${xml(t)}</w:t></w:r>`;
  }).join('');
}

/**
 * Exact-mode text overlay for ONE line-segment as a POSITIONED TEXT FRAME
 * (`w:framePr`) rather than a floating text-box shape. A frame is a real body
 * paragraph pinned to absolute page coordinates: it edits like normal text and —
 * crucially — carries NO shape outline, so no reader draws the grey "debug"
 * rectangle around every line that text boxes produce. Click to type; a selection
 * outline shows only while selected/editing.
 *
 * `transparent` (the raster's glyphs were erased, the normal Exact path) → no fill,
 * no border: nothing shows around the text. Otherwise the frame is shaded with the
 * segment's sampled background to mask the glyph still baked into the raster beneath
 * (a faint fill in off-white areas, but never a box outline and never doubled text).
 * `wrap="none"` lets frames overlap freely; `hRule="exact"` keeps the line height.
 */
function framedSeg(seg, w, h, transparent) {
  const first = seg.parts[0].run;
  const jc = first.align === 'center' ? '<w:jc w:val="center"/>'
    : first.align === 'right' ? '<w:jc w:val="right"/>' : '';
  const fill = transparent ? '' : normHex(seg.bg);
  const shd = fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : '';
  const framePr = `<w:framePr w:w="${TW(w)}" w:h="${TW(h)}" w:hRule="exact" w:wrap="none"`
    + ` w:vAnchor="page" w:hAnchor="page" w:x="${TW(Math.max(0, seg.x))}" w:y="${TW(Math.max(0, seg.top))}"`
    + ' w:hSpace="0" w:vSpace="0"/>';
  return `<w:p><w:pPr>${framePr}${shd}<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>${jc}</w:pPr>`
    + segRunsXml(seg) + '</w:p>';
}

/** A no-fill, thin-outline rectangle used to draw a table cell's borders. */
function borderRectGraphic(w, h) {
  const W = EMU(w), H = EMU(h);
  return `<a:graphicData uri="${WPS_NS}"><wps:wsp xmlns:wps="${WPS_NS}"><wps:cNvSpPr/>`
    + `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${W}" cy="${H}"/></a:xfrm>`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>'
    + '<a:ln w="6350" cap="flat"><a:solidFill><a:srgbClr val="808080"/></a:solidFill></a:ln>'
    + '</wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData>';
}

/** An absolutely-positioned picture. */
function pictureGraphic(w, h, rId, id) {
  const W = EMU(w), H = EMU(h);
  return `<a:graphicData uri="${PIC_NS}"><pic:pic xmlns:pic="${PIC_NS}">`
    + `<pic:nvPicPr><pic:cNvPr id="${id}" name="pic${id}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${W}" cy="${H}"/></a:xfrm>`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData>';
}

/* ------------------------------ packaging -------------------------------- */

function packDocx(documentXml, media, rels, extraParts = [], numbering = null) {
  const hasImg = media.length > 0;
  const usesPng = media.some((m) => m.ext === 'png');
  const usesJpg = media.some((m) => m.ext === 'jpg');
  // Content types for any extra-part extensions (our sidecar: gz / json).
  const EXTRA_MIME = { json: 'application/json', gz: 'application/gzip' };
  const extraDefaults = [...new Set(extraParts.map((p) => p.ext).filter((e) => EXTRA_MIME[e]))]
    .map((e) => `<Default Extension="${e}" ContentType="${EXTRA_MIME[e]}"/>`).join('');

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    (usesPng ? '<Default Extension="png" ContentType="image/png"/>' : '') +
    (usesJpg ? '<Default Extension="jpg" ContentType="image/jpeg"/>' : '') +
    extraDefaults +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    (numbering ? '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' : '') +
    '</Types>';

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const entries = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'word/document.xml', data: documentXml },
  ];

  // document.xml.rels is needed when there are images AND/OR a numbering part.
  if (hasImg || numbering) {
    const numRel = numbering
      ? '<Relationship Id="rId990" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
      : '';
    const docRels =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels.map((r) => `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${r.target}"/>`).join('') +
      numRel +
      '</Relationships>';
    entries.push({ name: 'word/_rels/document.xml.rels', data: docRels });
    for (const m of media) entries.push({ name: `word/media/${m.name}`, data: m.bytes });
    if (numbering) entries.push({ name: 'word/numbering.xml', data: numbering });
  }
  // Non-standard extra parts (our re-import sidecar). Word/LibreOffice ignore parts
  // they don't reference; a Default content type keeps the package OPC-valid.
  for (const p of extraParts) entries.push({ name: p.name, data: p.data });

  return zipBlob(entries, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}
