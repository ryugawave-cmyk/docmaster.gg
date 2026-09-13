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
import { reconstructPages, detectTableRegions } from './reconstruct.js';

const PT = (px) => Math.round(px * PX_TO_PT * 100) / 100; // px → pt (2dp)
const TW = (px) => Math.max(0, Math.round(px * PX_TO_TWIP)); // px → twips
const EMU = (px) => Math.max(1, Math.round(px * PX_TO_EMU));  // px → EMU
const SZHP = (px) => Math.max(8, Math.round(px * PX_TO_PT * 2)); // px font → half-points

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

  let bodyXml;
  if (mode === 'exact') bodyXml = absoluteBody(content, addImage, opts.cleanBg);
  else if (mode === 'ai') bodyXml = aiBody(content, opts.aiPages || [], addImage, opts.inlineImages);
  else if (mode === 'layout') bodyXml = faithfulBody(content, addImage, opts.inlineImages);
  else bodyXml = flowBody(content, mode === 'hybrid' ? addImage : null);

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document ${DOC_NS}><w:body>${bodyXml}</w:body></w:document>`;

  return packDocx(documentXml, media, rels);
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

  const bodyXml = faithfulBody({ pages }, addImage, true);
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document ${DOC_NS}><w:body>${bodyXml}</w:body></w:document>`;
  return packDocx(documentXml, media, rels);
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

function runProps({ bold, italic, size, color, font }) {
  return '<w:rPr>' +
    `<w:rFonts w:ascii="${xml(font || 'Calibri')}" w:hAnsi="${xml(font || 'Calibri')}"/>` +
    (bold ? '<w:b/>' : '') + (italic ? '<w:i/>' : '') +
    (color ? `<w:color w:val="${xml(color)}"/>` : '') +
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` +
    '</w:rPr>';
}

function textRuns(text, rpr) {
  // Preserve explicit line breaks within a block.
  return String(text).split('\n').map((line, i) =>
    '<w:r>' + rpr + (i ? '<w:br/>' : '') + `<w:t xml:space="preserve">${xml(line)}</w:t></w:r>`
  ).join('');
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
      out.push('<w:p><w:pPr><w:spacing w:after="80"/><w:ind w:left="360" w:hanging="360"/></w:pPr>' +
        textRuns('•\t' + b.text, runProps({ size: 22 })) + '</w:p>');
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

  pages.forEach((pg, pi) => {
    const imgBlocks = [];
    const flow = [];
    let lastWasTable = false;
    for (const b of pg.blocks) {
      if (b.type === 'table') {
        if (lastWasTable) flow.push(TABLE_SEP); // keep adjacent tables from merging
        flow.push(tableXml(b, addImage));
        lastWasTable = true;
      } else if (b.type === 'image') {
        // Inline mode (used when the target is the flowing Document editor): emit the
        // picture INLINE at its reading-order position so it pushes content down.
        // Floated at absolute PDF coordinates it would overlap the reflowed text,
        // because the flow editor does not preserve the PDF's y positions.
        if (inlineImages) { flow.push(inlineImagePara(b, addImage, pg.w)); lastWasTable = false; }
        else imgBlocks.push(b);
      }
      else { flow.push(styledPara(b, addImage)); lastWasTable = false; }
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
 *  lines stack via <w:br/>; tokens within a line are inline (image runs or text). */
function renderContent(lines, rpr, addImage) {
  return (lines || []).map((toks, i) => {
    const br = i ? `<w:r>${rpr}<w:br/></w:r>` : '';
    const body = (toks || []).map((t) => (t.img
      ? inlineImageRun(t.img, addImage)
      : textRuns(t.text, rpr))).join('');
    return br + body;
  }).join('');
}

/** A styled heading/paragraph, preserving size/weight/italic/colour/alignment,
 *  left indent, and a coloured bar (paragraph shading) when the run sat on one.
 *  `b.lines` (image/text tokens) take precedence over the plain `b.text`. */
function styledPara(b, addImage) {
  const st = b.style || {};
  const shading = shd(st.boxBg);
  const jc = b.align === 'center' ? '<w:jc w:val="center"/>'
    : b.align === 'right' ? '<w:jc w:val="right"/>'
      : b.align === 'justify' ? '<w:jc w:val="both"/>' : '';
  const ind = b.x > 4 && !shading ? `<w:ind w:left="${TW(b.x)}"/>` : '';
  const before = b.type === 'heading' ? 80 : 20;
  const after = b.type === 'heading' ? 40 : 20;
  const rpr = runProps({
    bold: st.bold || b.type === 'heading', italic: st.italic,
    size: SZHP(st.size || 16), color: st.color, font: st.font,
  });
  const body = (b.lines && b.lines.length) ? renderContent(b.lines, rpr, addImage) : textRuns(b.text, rpr);
  return `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${after}"/>${shading}${jc}${ind}</w:pPr>`
    + body + '</w:p>';
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
  const rpr = runProps({
    bold: st.bold, italic: st.italic, size: SZHP(st.size || 14),
    color: st.color, font: st.font,
  });
  const body = (c.lines && c.lines.length) ? renderContent(c.lines, rpr, addImage)
    : (c.text ? textRuns(c.text, rpr) : '');
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

/* --------------------------- AI-layout rebuild --------------------------- */

/**
 * Build the document from the AI-layout blocks (see services/convert/aiLayout.js
 * + aiWordConvert.js). Each `aiPages[i]` is `{ blocks: [...] }` where a block is
 * `{kind:'table', rows:[[{text,colSpan}]]}` or `{kind:'paragraph', text, heading}`.
 * The layout model already decided what is a table vs paragraph and in what
 * order, and the cell/paragraph text came from the PDF — so here we just emit
 * fully-editable Word objects (real `<w:tbl>` + styled paragraphs), reusing the
 * same helpers as the `layout` mode. The page's embedded images ride as floating
 * anchored pictures at their own positions.
 */
function aiBody(content, aiPages, addImage, inlineImages = false) {
  const parts = [];
  const pages = content.pages;
  const MPX = 24; // page margin (px) — tight, so the rebuilt flow tracks the PDF
  let drawId = 1;

  pages.forEach((pg, pi) => {
    const ap = aiPages[pi];
    const innerW = Math.max(120, (pg.w || 800) - MPX * 2);
    const innerH = Math.max(120, (pg.h || 1100) - MPX * 2);

    // Text and tables flow (editable) in reading order.
    const blocks = ((ap && Array.isArray(ap.blocks)) ? ap.blocks.slice() : []);

    // Split the page's images by role:
    //  • WIDE figures (a banner/diagram/chart spanning most of the column, with no
    //    text beside them) flow INLINE, interleaved into the text/table stream at
    //    their PDF y-position — so they take their own space in reading order and can
    //    never float over the heading/paragraph/table beneath (the reported bug).
    //  • NARROW side-images (a form's photo/signature/QR pinned in a margin column,
    //    with text alongside) stay FLOATING at their exact PDF coordinates, so they
    //    keep sitting beside their section instead of forcing a full-width line break.
    const imgs = (pg.images || []);
    const floatImgs = [], stream = blocks.slice();
    for (const im of imgs) {
      // `inlineImages` (Document-editor handoff): flow EVERY picture in reading order
      // so none can float over the reflowed text. Otherwise only WIDE figures inline
      // and narrow side-images stay pinned beside their section.
      if (inlineImages || (im.w || 0) >= innerW * 0.5) stream.push({ kind: 'image', y: im.y || 0, x: im.x || 0, im });
      else floatImgs.push(im);
    }
    stream.sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0));

    if (floatImgs.length) {
      const anchors = floatImgs.map((im) => {
        const [dw, dh] = fitImage(im, innerW, innerH); // never larger than the page
        const rId = addImage(im.src);
        const id = drawId++;
        return anchor(im.x || 0, im.y || 0, dw, dh, id, pictureGraphic(dw, dh, rId, id));
      }).join('');
      parts.push(`<w:p><w:r>${anchors}</w:r></w:p>`);
    }

    let lastWasTable = false;
    for (const b of stream) {
      // `geom` blocks come from the geometry recovery (aiLayout.reconstructLeftovers)
      // and are already in reconstruct-native shape, so they go straight to the
      // shared table/paragraph builders; the AI-region blocks are converted first.
      if (b && b.kind === 'table') {
        if (lastWasTable) parts.push(TABLE_SEP); // keep adjacent tables from merging
        parts.push(tableXml(b.geom ? fitCols(b, innerW) : aiTableToTbl(b, innerW), addImage));
        lastWasTable = true;
      } else if (b && b.kind === 'paragraph') {
        parts.push(styledPara(b.geom ? b : aiParaToBlock(b), addImage));
        lastWasTable = false;
      } else if (b && b.kind === 'image') {
        // Inline, centred picture — sized to fit the printable width with aspect
        // ratio preserved (never enlarged), so it reserves its own vertical space and
        // the following heading/paragraph/table flow below it.
        const [dw, dh] = fitImage(b.im, innerW, innerH);
        const rId = addImage(b.im.src);
        const id = drawId++;
        parts.push('<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="80" w:after="80"/></w:pPr>'
          + `<w:r>${inlineDrawing(dw, dh, rId, id)}</w:r></w:p>`);
        lastWasTable = false;
      }
    }
    if (!stream.length && !floatImgs.length) parts.push('<w:p/>');

    const secW = TW(pg.w), secH = TW(pg.h);
    const mar = TW(MPX);
    const sectPr = `<w:sectPr><w:pgSz w:w="${secW}" w:h="${secH}"/>`
      + `<w:pgMar w:top="${mar}" w:right="${mar}" w:bottom="${mar}" w:left="${mar}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
    // The section-carrier paragraph (mid-doc) doubles as the required paragraph after
    // a trailing table; at the very end (body-level sectPr) add one only if needed.
    if (pi < pages.length - 1) parts.push(`<w:p><w:pPr>${sectPr}</w:pPr></w:p>`);
    else { if (lastWasTable) parts.push('<w:p/>'); parts.push(sectPr); }
  });

  if (!pages.length) {
    parts.push('<w:p><w:r><w:t>Empty document.</w:t></w:r></w:p>');
    parts.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>');
  }
  return parts.join('');
}

function clampSpan(n) { const v = parseInt(n, 10); return !(v >= 1) ? 1 : Math.min(v, 10); }

/** A geometry-recovered table carries the PDF's own pixel column widths, which can
 *  be as wide as the whole page and overflow the AI layout's page margins. Scale the
 *  columns down to the printable width (and drop the left indent) so the rebuilt form
 *  fits the page instead of running off the right edge. */
function fitCols(tbl, innerW) {
  const sum = (tbl.cols || []).reduce((s, w) => s + (w || 0), 0);
  if (!sum || sum <= innerW) return tbl;
  const k = innerW / sum;
  return { ...tbl, left: 0, cols: tbl.cols.map((w) => Math.max(24, Math.round((w || 0) * k))) };
}

/** aiLayout `table` block (rows = array of arrays of {text,colSpan}) → tableXml shape. */
function aiTableToTbl(b, innerW) {
  const rows = Array.isArray(b.rows) ? b.rows : [];
  let ncol = 1;
  for (const cells of rows) {
    let sum = 0;
    for (const c of (cells || [])) sum += clampSpan(c && c.colSpan);
    if (sum > ncol) ncol = sum;
  }
  const colW = Math.max(24, Math.floor(innerW / ncol));
  const cols = new Array(ncol).fill(colW);
  const outRows = rows.map((cells) => {
    let colStart = 0;
    const out = [];
    for (const c of (cells || [])) {
      if (colStart >= ncol) break;
      const span = Math.min(clampSpan(c && c.colSpan), ncol - colStart);
      // Keep the cell's REAL styling (size/weight/colour/font) and alignment from
      // the PDF runs; fall back to a plain body cell only when the cell was empty.
      const style = (c && c.style) ? c.style : { bold: false, size: 14 };
      const align = (c && c.align) ? c.align : 'left';
      out.push({ text: (c && c.text != null) ? String(c.text) : '', lines: c && c.lines, span, colStart, align, style });
      colStart += span;
    }
    return out;
  }).filter((r) => r.length);
  return { cols, left: 0, rows: outRows };
}

/** aiLayout `paragraph` block → styledPara block. Honour the PDF's real font
 *  size, weight, colour, family and alignment rather than snapping every title to
 *  a fixed giant heading size — that reconstruction is what made small centred
 *  headers balloon into left-aligned H1s. A `title` region only adds heading
 *  spacing (and bold, if the source wasn't already), never an invented size. */
function aiParaToBlock(b) {
  const isHeading = b.heading === 1 || b.heading === 2 || b.heading === 3;
  const st = b.style || {};
  return {
    type: isHeading ? 'heading' : 'paragraph',
    text: b.text != null ? String(b.text) : '',
    lines: b.lines,
    align: b.align || 'left', x: 0,
    style: {
      bold: st.bold || isHeading,
      italic: !!st.italic,
      size: st.size || 16,
      color: st.color,
      font: st.font,
      // Carry the sampled fill so styledPara shades coloured bars/banners (shd()
      // skips near-white, so plain body text on white is never painted).
      boxBg: st.boxBg || '',
    },
  };
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
    const anchors = [];
    // Prefer the text-erased raster (see rasterImages.maskExtractedText): with the
    // baked glyphs already painted out, Google Docs can't bleed the original text
    // through the editable overlay boxes. Falls back to the original background.
    const bgSrc = (cleanBg && cleanBg[pi]) || pg.bg;
    const hasRaster = !!bgSrc;

    if (hasRaster) {
      // Full-page background raster (all graphics), then masked editable text.
      // The raster already carries every picture (logo/signature/photo/QR) exactly,
      // so we do NOT overlay recovered images here: recovery is best-effort and a
      // mis-detected region (e.g. a pale form-field box) would drop a blank crop
      // over real text. Exact = raster + editable text, nothing covering it.
      const bgId = addImage(bgSrc);
      anchors.push(anchor(0, 0, pg.w, pg.h, z++, pictureGraphic(pg.w, pg.h, bgId, z), true));
      // Pass 2 — "make editable": overlay the text as LINE-SEGMENT boxes (whole
      // phrases/lines), not one box per glyph, so the result is genuinely editable
      // (you type into sentences, not fragments). Each segment box is filled with
      // its sampled background so the baked glyphs underneath stay masked. Complex-
      // script runs are excluded from segments and left baked in the raster (an
      // editable overlay would scramble their matras/conjuncts — see hasComplexScript;
      // rasterImages.maskExtractedText keeps the matching runs in the raster).
      for (const seg of segmentRuns(pg.runs, { mask: true })) {
        const fs = seg.parts[0].run.fontSize || 14;
        // Keep the mask box tight to the segment's real extent so its fill can't
        // bleed onto an adjacent border/seal/graphic in the raster underneath.
        // spAutoFit (in lineTextboxGraphic) then grows it just enough to fit text.
        const w = Math.max(seg.right - seg.x, fs * 0.5);
        const h = Math.max(seg.h || 0, fs * 1.3);
        anchors.push(textboxAnchor(seg.x, seg.top, w, h, z++, seg));
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
      // 3) Text as line-segment editable text boxes (whole phrases), on top.
      for (const seg of segmentRuns(pg.runs, { mask: false })) {
        const fs = seg.parts[0].run.fontSize || 14;
        const w = (seg.right - seg.x) + fs * 1.4;
        const h = Math.max(seg.h || 0, fs * 1.25) + 2;
        anchors.push(textboxAnchor(seg.x, seg.top, w, h, z++, seg));
      }
    }

    const secW = TW(pg.w), secH = TW(pg.h);
    const sectPr = `<w:sectPr><w:pgSz w:w="${secW}" w:h="${secH}"/>`
      + '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>';
    // All anchors ride one paragraph's run; page-relative offsets mean sequence
    // affects only z-order, never position.
    const run = anchors.length ? `<w:r>${anchors.join('')}</w:r>` : '<w:r><w:t/></w:r>';
    if (pi < pages.length - 1) {
      parts.push(`<w:p>${run}</w:p>`);
      parts.push(`<w:p><w:pPr>${sectPr}</w:pPr></w:p>`); // ends section → page break
    } else {
      parts.push(`<w:p>${run}</w:p>`);
      parts.push(sectPr);
    }
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

/** The txbxContent paragraph for one line-segment: its words emitted as separate
 *  styled runs in a single paragraph, so per-word bold/colour/size survive while
 *  the whole line edits as a unit. Shared by the DrawingML (wps) box and its VML
 *  fallback so both readers get identical text. */
function segParagraph(seg) {
  const first = seg.parts[0].run;
  const jc = first.align === 'center' ? '<w:jc w:val="center"/>'
    : first.align === 'right' ? '<w:jc w:val="right"/>' : '';
  const runsXml = seg.parts.map(({ run, space }) => {
    const rpr = runProps({
      bold: run.bold, italic: run.italic, size: SZHP(run.fontSize || 14),
      color: run.color, font: run.fontFamily,
    });
    const t = (space ? ' ' : '') + String(run.text == null ? '' : run.text).replace(/\n/g, ' ');
    return '<w:r>' + rpr + `<w:t xml:space="preserve">${xml(t)}</w:t></w:r>`;
  }).join('');
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>${jc}</w:pPr>${runsXml}</w:p>`;
}

/**
 * An editable text-box overlay for ONE line-segment, wrapped so BOTH the modern
 * DrawingML text box and a legacy VML text box are available and Word gets a
 * genuine, double-click-editable box:
 *   • <mc:Choice Requires="wps"> — the DrawingML/wps box (Word 2010+, LibreOffice,
 *     Google Docs). Positioning/masking identical to before.
 *   • <mc:Fallback> — a VML <v:rect>/<v:textbox> at the same page coordinates, for
 *     readers that don't understand wps (older Word, some editing paths).
 * The `id` drives both z-order (relativeHeight / VML z-index).
 */
function textboxAnchor(x, y, w, h, id, seg) {
  return '<mc:AlternateContent>'
    + `<mc:Choice Requires="wps">${anchor(x, y, w, h, id, lineTextboxGraphic(w, h, seg))}</mc:Choice>`
    + `<mc:Fallback>${vmlTextbox(x, y, w, h, id, seg)}</mc:Fallback>`
    + '</mc:AlternateContent>';
}

/** Legacy VML text box (fallback for the wps box). <v:rect> is a built-in VML
 *  shape (no <v:shapetype> needed) placed at absolute page coordinates in points;
 *  `seg.bg` fills it to mask the raster glyphs beneath, empty → unfilled. */
function vmlTextbox(x, y, w, h, id, seg) {
  const para = segParagraph(seg);
  const hex = normHex(seg.bg);
  const fillAttr = hex ? ` fillcolor="#${hex}"` : ' filled="f"';
  const style = 'position:absolute;'
    + `margin-left:${PT(Math.max(0, x))}pt;margin-top:${PT(Math.max(0, y))}pt;`
    + `width:${PT(w)}pt;height:${PT(h)}pt;z-index:${id};`
    + 'mso-position-horizontal-relative:page;mso-position-vertical-relative:page';
  return '<w:pict>'
    + `<v:rect id="obj${id}" o:spid="_x0000_s${1000 + id}" style="${style}"${fillAttr} stroked="f">`
    // inset 0 + fit-shape-to-text mirrors the wps box's zero insets + spAutoFit.
    + '<v:textbox inset="0,0,0,0" style="mso-fit-shape-to-text:t">'
    + `<w:txbxContent>${para}</w:txbxContent>`
    + '</v:textbox></v:rect></w:pict>';
}

/** An editable text box holding ONE line-segment: the segment's words emitted as
 *  separate styled runs in a single paragraph, so per-word bold/colour/size survive
 *  while the whole line edits as a unit. `seg.bg` (6-hex, no #) fills the box to
 *  mask the same text baked into the page raster beneath it; empty → transparent. */
function lineTextboxGraphic(w, h, seg) {
  const W = EMU(w), H = EMU(h);
  const para = segParagraph(seg);
  const hex = normHex(seg.bg);
  const fill = hex ? `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>` : '<a:noFill/>';
  return `<a:graphicData uri="${WPS_NS}"><wps:wsp xmlns:wps="${WPS_NS}"><wps:cNvSpPr txBox="1"/>`
    + `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${W}" cy="${H}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}<a:ln><a:noFill/></a:ln></wps:spPr>`
    + `<wps:txbx><w:txbxContent>${para}</w:txbxContent></wps:txbx>`
    // spAutoFit: the shape resizes to fit its single line of text, so Word AND
    // LibreOffice never clip it (no red "text overflow" marker) and the mask fill
    // hugs the text instead of over-painting neighbouring borders/graphics.
    + '<wps:bodyPr rot="0" vert="horz" wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" '
    + 'anchor="t" anchorCtr="0"><a:spAutoFit/></wps:bodyPr></wps:wsp></a:graphicData>';
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

/**
 * Display size (px) for an image, shrunk to fit within maxW×maxH while preserving
 * its aspect ratio. Only ever scales DOWN (k ≤ 1) — a small PDF image is never
 * blown up — so images can't become "arbitrarily huge" and never overflow the page.
 * @returns {[number, number]} clamped [width, height] in px
 */
function fitImage(im, maxW, maxH) {
  let w = im && im.w > 0 ? im.w : maxW;
  let h = im && im.h > 0 ? im.h : w; // no height → assume square
  const k = Math.min(1, maxW / w, maxH / h);
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

/** An INLINE picture: flows in the text stream, so it reserves its own space and
 *  can never overlap surrounding paragraphs, headings or tables. noChangeAspect
 *  locks the aspect ratio when the user later resizes it in Word. */
function inlineDrawing(w, h, rId, id) {
  const W = EMU(w), H = EMU(h);
  return '<w:drawing>'
    + '<wp:inline distT="0" distB="0" distL="0" distR="0">'
    + `<wp:extent cx="${W}" cy="${H}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
    + `<wp:docPr id="${id}" name="pic${id}"/>`
    + `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${A_NS}" noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + `<a:graphic xmlns:a="${A_NS}">${pictureGraphic(w, h, rId, id)}</a:graphic>`
    + '</wp:inline></w:drawing>';
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

function packDocx(documentXml, media, rels, extraParts = []) {
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

  if (hasImg) {
    const docRels =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels.map((r) => `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${r.target}"/>`).join('') +
      '</Relationships>';
    entries.push({ name: 'word/_rels/document.xml.rels', data: docRels });
    for (const m of media) entries.push({ name: `word/media/${m.name}`, data: m.bytes });
  }
  // Non-standard extra parts (our re-import sidecar). Word/LibreOffice ignore parts
  // they don't reference; a Default content type keeps the package OPC-valid.
  for (const p of extraParts) entries.push({ name: p.name, data: p.data });

  return zipBlob(entries, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}
