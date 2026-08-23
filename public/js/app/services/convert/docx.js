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
  else if (mode === 'ai') bodyXml = aiBody(content, opts.aiPages || [], addImage);
  else if (mode === 'layout') bodyXml = faithfulBody(content, addImage);
  else bodyXml = flowBody(content, mode === 'hybrid' ? addImage : null);

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document ${DOC_NS}><w:body>${bodyXml}</w:body></w:document>`;

  return packDocx(documentXml, media, rels);
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
function faithfulBody(content, addImage) {
  const parts = [];
  const pages = reconstructPages(content);
  let drawId = 1;
  const nextDrawId = () => drawId++;

  pages.forEach((pg, pi) => {
    const imgBlocks = [];
    const flow = [];
    for (const b of pg.blocks) {
      if (b.type === 'table') flow.push(tableXml(b));
      else if (b.type === 'image') imgBlocks.push(b);
      else flow.push(styledPara(b));
    }
    // Images as FLOATING, page-anchored drawings at their exact PDF position and
    // size — a logo, barcode, photo or signature stays pinned where it belongs,
    // and two images can sit side by side (impossible with inline paragraphs,
    // which stack). Text/tables remain normal editable flow. All page-relative,
    // so one carrier paragraph per page is enough.
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

/** A styled heading/paragraph, preserving size/weight/italic/colour/alignment,
 *  left indent, and a coloured bar (paragraph shading) when the run sat on one. */
function styledPara(b) {
  const st = b.style || {};
  const shading = shd(st.boxBg);
  const jc = b.align === 'center' ? '<w:jc w:val="center"/>'
    : b.align === 'right' ? '<w:jc w:val="right"/>'
      : b.align === 'justify' ? '<w:jc w:val="both"/>' : '';
  const ind = b.x > 4 && !shading ? `<w:ind w:left="${TW(b.x)}"/>` : '';
  const before = b.type === 'heading' ? 160 : 40;
  const after = b.type === 'heading' ? 80 : 60;
  const rpr = runProps({
    bold: st.bold || b.type === 'heading', italic: st.italic,
    size: SZHP(st.size || 16), color: st.color, font: st.font,
  });
  return `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${after}"/>${shading}${jc}${ind}</w:pPr>`
    + textRuns(b.text, rpr) + '</w:p>';
}

/** Emit a detected grid as a real Word table (editable cells, borders, spans). */
function tableXml(tbl) {
  const n = tbl.cols.length;
  const grid = tbl.cols.map((w) => `<w:gridCol w:w="${TW(w)}"/>`).join('');
  const totalTw = tbl.cols.reduce((s, w) => s + TW(w), 0);
  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`;
  const borders = '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')
    + '</w:tblBorders>';
  const cellMar = '<w:tblCellMar><w:top w:w="30" w:type="dxa"/><w:left w:w="80" w:type="dxa"/>'
    + '<w:bottom w:w="30" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar>';
  const ind = tbl.left > 4 ? `<w:tblInd w:w="${TW(tbl.left)}" w:type="dxa"/>` : '';
  const tblPr = '<w:tblPr>'
    + `<w:tblW w:w="${totalTw}" w:type="dxa"/>${ind}<w:tblLayout w:type="fixed"/>`
    + borders + cellMar + '</w:tblPr>';

  const rows = tbl.rows.map((cells) => {
    let covered = 0;
    const tcs = cells.map((c) => { covered += c.span; return cellXml(c, tbl.cols); }).join('');
    let pad = '';
    if (covered < n) {
      const wsum = sumCols(tbl.cols, covered, n - covered);
      pad = `<w:tc><w:tcPr><w:tcW w:w="${wsum}" w:type="dxa"/>`
        + (n - covered > 1 ? `<w:gridSpan w:val="${n - covered}"/>` : '')
        + '<w:vAlign w:val="center"/></w:tcPr><w:p/></w:tc>';
    }
    return `<w:tr>${tcs}${pad}</w:tr>`;
  }).join('');

  return `<w:tbl>${tblPr}<w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`
    + '<w:p><w:pPr><w:spacing w:after="60"/></w:pPr></w:p>';
}

function cellXml(c, cols) {
  const wsum = sumCols(cols, c.colStart, c.span);
  const st = c.style || {};
  const jc = c.align === 'center' ? '<w:jc w:val="center"/>'
    : c.align === 'right' ? '<w:jc w:val="right"/>' : '';
  const rpr = runProps({
    bold: st.bold, italic: st.italic, size: SZHP(st.size || 14),
    color: st.color, font: st.font,
  });
  const para = `<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>${jc}</w:pPr>`
    + (c.text ? textRuns(c.text, rpr) : '') + '</w:p>';
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
function aiBody(content, aiPages, addImage) {
  const parts = [];
  const pages = content.pages;
  const MPX = 48;

  pages.forEach((pg, pi) => {
    const ap = aiPages[pi];
    const innerW = Math.max(120, (pg.w || 800) - MPX * 2);

    // Interleave the page's images into the SAME reading-order stream as the text
    // and tables (by vertical position), placed inline rather than floating at
    // absolute coordinates — reflowed text/tables no longer match the PDF's exact
    // heights, so a floating image would drift and overlap. Inline keeps order and
    // avoids collisions, at the cost of pixel-exact placement (that's Exact mode).
    const blocks = (ap && Array.isArray(ap.blocks)) ? ap.blocks.slice() : [];
    const imgs = (pg.images || []).map((im) => ({
      kind: 'image', src: im.src, w: im.w, h: im.h, x: im.x || 0, y: im.y || 0,
    }));
    const stream = blocks.concat(imgs)
      .sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0));

    for (const b of stream) {
      if (b && b.kind === 'table') parts.push(tableXml(aiTableToTbl(b, innerW)));
      else if (b && b.kind === 'paragraph') parts.push(styledPara(aiParaToBlock(b)));
      else if (b && b.kind === 'image') parts.push(inlineImageParagraph(b, addImage));
    }
    if (!stream.length) parts.push('<w:p/>');

    const secW = TW(pg.w), secH = TW(pg.h);
    const sectPr = `<w:sectPr><w:pgSz w:w="${secW}" w:h="${secH}"/>`
      + '<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>';
    if (pi < pages.length - 1) parts.push(`<w:p><w:pPr>${sectPr}</w:pPr></w:p>`);
    else parts.push(sectPr);
  });

  if (!pages.length) {
    parts.push('<w:p><w:r><w:t>Empty document.</w:t></w:r></w:p>');
    parts.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>');
  }
  return parts.join('');
}

function clampSpan(n) { const v = parseInt(n, 10); return !(v >= 1) ? 1 : Math.min(v, 10); }

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
      out.push({ text: (c && c.text != null) ? String(c.text) : '', span, colStart, align, style });
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
        anchors.push(anchor(seg.x, seg.top, w, h, z++, lineTextboxGraphic(w, h, seg)));
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
        anchors.push(anchor(seg.x, seg.top, w, h, z++, lineTextboxGraphic(w, h, seg)));
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
function segmentRuns(runs, { mask }) {
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

/** An editable text box holding ONE line-segment: the segment's words emitted as
 *  separate styled runs in a single paragraph, so per-word bold/colour/size survive
 *  while the whole line edits as a unit. `seg.bg` (6-hex, no #) fills the box to
 *  mask the same text baked into the page raster beneath it; empty → transparent. */
function lineTextboxGraphic(w, h, seg) {
  const W = EMU(w), H = EMU(h);
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
  const hex = normHex(seg.bg);
  const fill = hex ? `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>` : '<a:noFill/>';
  const para = `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>${jc}</w:pPr>${runsXml}</w:p>`;
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

function packDocx(documentXml, media, rels) {
  const hasImg = media.length > 0;
  const usesPng = media.some((m) => m.ext === 'png');
  const usesJpg = media.some((m) => m.ext === 'jpg');

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    (usesPng ? '<Default Extension="png" ContentType="image/png"/>' : '') +
    (usesJpg ? '<Default Extension="jpg" ContentType="image/jpeg"/>' : '') +
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

  return zipBlob(entries, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}
