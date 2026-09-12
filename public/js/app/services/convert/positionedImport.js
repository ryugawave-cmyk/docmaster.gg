/**
 * PDF positioned model → POSITIONED Document model (exact-layout transfer).
 *
 * Unlike the flow converters (faithfulBody / aiBody), this does NOT reflow the
 * PDF into paragraphs. It reproduces the page 1:1 the way the PDF editor itself
 * renders it and the way the "exact" DOCX mode builds it (see docx.absoluteBody):
 *
 *   • each page keeps its NATIVE size (width × height in CSS px) and page count,
 *   • the page's text-erased raster becomes the page BACKGROUND (so every non-text
 *     graphic — table borders, shading, lines, logos, photos, signatures — stays
 *     pixel-exact), and
 *   • every text line becomes an absolutely-positioned, INDEPENDENTLY EDITABLE text
 *     box at its exact PDF coordinates, carrying the real font/size/weight/italic/
 *     colour/alignment. The baked glyphs are masked in the raster underneath so the
 *     original never bleeds through.
 *
 * The resulting Document carries `layout:'positioned'`, a per-page `pages[]` (each
 * `{ bg }`), and blocks of type `posbox` with a page-relative `frame:{x,y,w,h}`.
 * `editableHtml`/`documentEditor` render these at their coordinates on fixed sheets
 * (no flow pagination). Coordinates come straight from the PDF's own extraction —
 * nothing is estimated.
 */
import { buildContentModel, normHex } from './model.js';
import { segmentRuns } from './docx.js';
import { maskExtractedText } from './rasterImages.js';
import { detectGraphicRegionsFromPixels } from './graphicRegions.js';
import { createDocument, createRun } from '../../model/documentModel.js';
import { recognizeRegion, isOcrAvailable, OcrUnavailableError } from '../../core/ai/ocr.js';

let boxSeq = 0;
const hexOf = (c) => (c ? `#${String(c).replace(/^#/, '')}` : '#111111');

/** Page-coord rectangle of a run segment (from segmentRuns), used to test whether a
 *  line sits inside a detected diagram region. */
function segFrame(seg) {
  const fs = (seg.parts && seg.parts[0] && seg.parts[0].run && seg.parts[0].run.fontSize) || seg.h || 14;
  return { x: seg.x, y: seg.top, w: Math.max(seg.right - seg.x, 1), h: Math.max(seg.h || fs, 1) };
}

/**
 * @param {object} model editor export model (engine.getExportModel())
 * @param {string} [name]
 * @param {{ ocr?:boolean, onOcrProgress?:(done:number,total:number)=>void,
 *   onOcrUnavailable?:()=>void }} [opts]
 *   `ocr:true` runs on-device OCR over the page rasters to turn text baked into
 *   images/banners/diagrams (not in the PDF text layer) into editable boxes too.
 * @returns {Promise<object>} a positioned Document model
 */
export async function pdfModelToPositionedDoc(model, name = 'Document', opts = {}) {
  const content = buildContentModel(model, name);

  // Discrete embedded images (XObjects lifted at import — logos, illustrations,
  // photos, seals) per page, in page coordinates. These stay baked in the page
  // raster (pixel-exact size/aspect/position/crop). Their coordinates are used
  // below to keep text that is PART OF an illustration inside the picture instead
  // of lifting it into a duplicate floating text layer (the reported bug — e.g. a
  // "COURT • RECORD • REVIEW" emblem must not become editable boxes over the art).
  const imageRegions = content.pages.map((pg) => (pg.images || [])
    .map((im) => ({ x: im.x || 0, y: im.y || 0, w: im.w || 0, h: im.h || 0 }))
    .filter((im) => im.w > 0 && im.h > 0));

  // Colourful, blocky VECTOR graphic/diagram regions detected from the raster (page
  // coords). A diagram (e.g. the biology cell illustration labelled "CELL • NUCLEUS •
  // ORGANELLES") is drawn as vector shapes, so it isn't an XObject in `imageRegions`;
  // but its labels are PART OF the picture. Text (and OCR) inside these regions is
  // kept BAKED in the raster — never lifted into a separate, re-placed text element —
  // so the image and its embedded labels stay exactly as the PDF drew them.
  let graphicRegions = content.pages.map(() => []);
  try { graphicRegions = await detectGraphicRegions(content.pages); } catch { /* leave empty */ }

  // Reliability cap: a genuine diagram's baked labels are a small MINORITY of a
  // page's text. If the detected regions would swallow a large share of a page's text
  // runs, the detection is over-firing (a busy/"colourful" page) — drop that page's
  // regions so real text stays EDITABLE and heading inference keeps a correct body
  // size. Without this, a colourful document could bake most of its text (unable to
  // edit anything, and the outline loses every heading but the biggest).
  graphicRegions = graphicRegions.map((regs, pi) => {
    if (!regs || !regs.length) return regs || [];
    const segs = segmentRuns(content.pages[pi].runs, { mask: !!content.pages[pi].bg });
    if (!segs.length) return regs;
    const inRegion = segs.reduce((n, s) => n + (regs.some((g) => overlaps(segFrame(s), g, 0.5)) ? 1 : 0), 0);
    return inRegion > segs.length * 0.35 ? [] : regs;
  });

  // Combined "figure" regions per page = embedded XObject images (photo, QR, logo,
  // seal) + detected vector-graphic/diagram regions. Text whose majority sits inside
  // EITHER is PART OF a picture — a photo's "Photo" placeholder, a QR's "QR Code"
  // label, an emblem's caption — so it must stay baked, never lifted into an editable
  // box over the art. Previously only vector graphics were gated, so labels under
  // embedded PHOTOS/QR leaked through as boxes floating on the image (the reported bug).
  const figures = content.pages.map((_, i) => (imageRegions[i] || []).concat(graphicRegions[i] || []));

  // Text-erased backgrounds (one per page) so editable overlay boxes don't double the
  // baked glyphs. Runs INSIDE a figure region are protected: they are part of the
  // illustration and must stay baked, not be erased and re-placed. Best-effort — on
  // failure fall back to the raw raster.
  let cleanBgs = [];
  try { cleanBgs = await maskExtractedText(model, { protect: figures }); } catch { cleanBgs = []; }

  const pages = [];
  const blocks = [];
  // Body-text size is tallied from ALL extracted runs (not just the ones that become
  // boxes) so heading inference stays correct even when some runs are kept baked
  // inside a diagram — otherwise baking body text would skew the modal size and drop
  // real headings from the outline.
  const sizeTally = new Map(); // fontSize(px) → chars, to infer the body text size
  for (const pg of content.pages) {
    for (const r of (pg.runs || [])) {
      const sz = Math.round(r.fontSize || 14);
      sizeTally.set(sz, (sizeTally.get(sz) || 0) + (r.text || '').length);
    }
  }

  content.pages.forEach((pg, pi) => {
    // DORMANT model: keep the ORIGINAL page raster (NOT the text-erased one) as the
    // page background, so the resting view is pixel-identical to the source — exact
    // fonts, weight, spacing and every baked table rule. The editable overlay boxes
    // are hidden until focused (editableHtml adds `doc-posbox--dormant`; app.css hides
    // their text + fill until :focus/reveal), so nothing is re-drawn on top and there
    // is no font-substitution overlap/doubling. Editing a box reveals it and its
    // opaque `fill` masks the original glyph beneath. (cleanBgs kept only as a fallback
    // for a page whose original raster is somehow missing.)
    const bg = pg.bg || (cleanBgs && cleanBgs[pi]) || null;
    pages.push({ bg, width: pg.w, height: pg.h });
    // Mask complex scripts into the raster only when we actually have a raster to
    // keep them in; otherwise emit them as editable boxes too.
    const mask = !!bg;
    const pageGraphics = figures[pi] || []; // XObject images + vector graphics
    const segs = segmentRuns(pg.runs, { mask });
    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si];
      const first = seg.parts[0] && seg.parts[0].run;
      if (!first) continue;
      const fs = first.fontSize || 14;
      // Embedded label: this run sits INSIDE a detected diagram/illustration, so it
      // belongs to the picture. Leave it baked in the raster (protected from erase
      // above) rather than lifting it into a separate, re-positioned text box — that
      // is what shifts labels like "CELL • NUCLEUS • ORGANELLES" off the artwork.
      if (pageGraphics.some((g) => overlaps(segFrame(seg), g, 0.5))) continue;
      let bold = false, text = '';
      const runs = seg.parts.map(({ run, space }) => {
        const t = (space ? ' ' : '') + (run.text || '');
        text += t; if (run.bold) bold = true;
        // Render at the PDF's TRUE px size — no shrink. In the dormant model the overlay
        // is shown only while its own box is being edited, so there is no neighbouring
        // overlay to collide with. Matching the real size means revealing a field does
        // NOT change its apparent size (only the font face differs from the baked glyph).
        const sz = Math.max(5, Math.round(run.fontSize || fs));
        // The DOC model's weight is binary (bold or not), so a run the PDF marks as
        // MEDIUM (500) would otherwise flatten to regular and read lighter than the
        // baked original. Treat medium-and-up as bold so weighted form labels stay
        // heavy. (run.bold already covers semibold 600+; this adds the 500 case.
        // Regular 400 fonts are untouched — no blanket bolding.)
        const heavy = !!run.bold || (run.fontWeight || 0) >= 500;
        return createRun(t, {
          bold: heavy, italic: !!run.italic, underline: !!run.underline,
          fontFamily: run.fontFamily || 'Inter', fontSize: sz, color: hexOf(run.color),
        });
      });
      // Box extent: the segment's real span, padded a little so text isn't clipped,
      // and at least one line tall. Page-relative — the editor adds the page offset.
      const w = Math.round(Math.max(seg.right - seg.x, fs * 0.5) + fs * 0.6);
      // Hug the line's real height (seg.h ≈ fontSize·1.08). This box's opaque mask
      // fill is painted over the raster when the box is revealed, so anything taller
      // than the line reaches DOWN over the top of the next baked line and clips it
      // ("the line below sinks when I click this one"). Keep it just tall enough.
      const h = Math.round(Math.max(seg.h || 0, fs * 1.15));
      // A posbox is ONE PDF line. The editor's substitute font is a little wider than
      // the PDF's, so a multi-word line in a NARROW box (a label/value inside a table
      // cell) would wrap to a 2nd visual line that lands on the baked line below it —
      // the bilingual label overlapping its Hindi. Keep such boxes single-line; wide
      // boxes (paragraphs) still wrap normally. Overflow on a narrow box just extends
      // slightly into its own cell's whitespace, which is far less jarring than a wrap.
      const nowrap = w < pg.w * 0.5;
      blocks.push({
        id: `pos-${(++boxSeq).toString(36)}`,
        type: 'posbox',
        page: pi,
        frame: { x: Math.round(seg.x), y: Math.round(seg.top), w, h },
        style: { align: first.align || 'left' },
        nowrap,
        runs: runs.length ? runs : [createRun('')],
        // Opaque mask fill (sampled page colour; white fallback). In the dormant model
        // the box is invisible at rest, so this fill is only shown when the box is
        // focused/edited — where it covers the original glyph baked beneath so the
        // editable text replaces it cleanly.
        fill: seg.bg || '#ffffff',
        // scratch data (removed below): heading inference + the original PDF text
        // extent (`_tw`), used to width-fit the substitute font so a revealed box
        // does not look smaller than the baked glyph it covers.
        _size: Math.round(fs), _bold: bold, _len: text.trim().length,
        _tw: Math.round(Math.max(0, seg.right - seg.x)),
      });
    }
  });

  // Match each revealed overlay's apparent size to the baked original (fixes "text
  // shrinks when I click it"). The dormant model masks the baked glyph and re-draws
  // the line in a substitute font, which is usually a little NARROWER than the PDF's
  // embedded font, so a revealed line looks smaller than the page image it replaced.
  fitBoxFontToWidth(blocks);

  // Transparent-box masking: make each overlay box show ONLY its text over the page
  // image (no opaque rectangle hiding the artwork). Where the line's surround is
  // uniform (paper, table cell, a diagram's flat fill) the baked glyph is ERASED from
  // the raster and the box is made TRANSPARENT, so the real background shows through
  // and only the editable text is visible. Where the surround is artwork (a photo /
  // coloured shape) the glyph can't be erased without smearing, so the box keeps an
  // opaque sampled fill to avoid doubling. Fail-safe: if the canvas is unavailable the
  // boxes keep their importer fill (opaque but correct — no doubling).
  // NOTE: maskPositionedBoxes (which erased baked glyphs + made boxes transparent for
  // the old "always re-drawn" model) is intentionally NOT called — the dormant model
  // keeps the original raster intact and hides the overlay until edit, so there is
  // nothing to erase and the boxes keep their opaque `fill` for reveal-time masking.

  // OCR pass: text baked into banners/diagrams/logos isn't in the PDF text layer, so
  // it isn't a box yet ("can't edit image text"). When enabled and an engine is
  // installed, read it off the page raster and add editable boxes at its position,
  // masked with the sampled background and coloured with the sampled ink.
  // Merge XObject images with detected vector-graphic regions: OCR must not recreate
  // text that lives inside EITHER kind of picture (it stays baked as part of the art).
  const ocrFigures = imageRegions.map((imgs, i) => imgs.concat(graphicRegions[i] || []));
  if (opts.ocr && isOcrAvailable()) {
    try { await recoverBakedText(pages, blocks, ocrFigures, opts.onOcrProgress); }
    catch (e) {
      if (e instanceof OcrUnavailableError) opts.onOcrUnavailable && opts.onOcrUnavailable();
      else console.warn('[positioned OCR]', e);
    }
  }

  // Tag heading-like boxes (short lines set in a notably larger/bolder font than the
  // body) with a heading level so the left OUTLINE lists them and the box reads as a
  // heading — without changing its exact position/size. Runs AFTER OCR so recovered
  // banner titles can be headings too. Body size = the run size covering most chars.
  let bodySize = 14, most = -1;
  for (const [sz, chars] of sizeTally) if (chars > most) { most = chars; bodySize = sz; }
  for (const b of blocks) {
    const ratio = (b._size || 14) / (bodySize || 14);
    let level = 0;
    if (b._len && b._len <= 120) {
      if (ratio >= 1.7) level = 1;
      else if (ratio >= 1.3) level = 2;
      else if (ratio >= 1.12 || (b._bold && ratio >= 1.02)) level = 3;
    }
    if (level) b.heading = level;
    delete b._size; delete b._bold; delete b._len; delete b._tw;
  }

  // Uniform page size for the editor's sheets: use the first page's native size
  // (PDF pages are almost always uniform); falls back to the model's default.
  const first = content.pages[0];
  const pageW = (first && first.w) || content.PW || 794;
  const pageH = (first && first.h) || content.PH || 1123;

  const doc = createDocument({
    title: name,
    source: 'pdf',
    page: { width: Math.round(pageW), height: Math.round(pageH), margin: 0 },
    blocks: blocks.length ? blocks : undefined,
  });
  doc.layout = 'positioned';
  doc.pages = pages;
  return doc;
}

/* ------------------------------ width-fit overlay ------------------------------
 * Keep a revealed box the same apparent size as the baked page image it covers.
 *
 * In the dormant model the page raster keeps the ORIGINAL glyphs; a box is hidden
 * until clicked, then it paints its sampled fill over the baked glyph and re-draws
 * the line in a substitute font (Arial/Inter). That substitute is usually a little
 * NARROWER than the PDF's embedded font, so revealing a field visibly shrinks it.
 *
 * For each box, measure the re-drawn text and, if it is narrower than the original
 * PDF run (`_tw`), scale the font up until it spans the same width — so revealing a
 * field does not change its size. ENLARGE-ONLY (never shrinks a line below its
 * current size, so this can't introduce a NEW shrink) and CAPPED (a mis-measure or
 * a letter-spaced heading can't balloon). Browser-only (canvas measureText); any
 * failure (e.g. Node) leaves every size untouched. */
export const FIT_MIN = 1.03; // ignore sub-3% gaps (measurement noise; not worth a reflow)
export const FIT_MAX = 1.22; // cap growth so tracking / a mis-measure can't balloon a line
export function fitBoxFontToWidth(blocks) {
  let ctx;
  try { ctx = document.createElement('canvas').getContext('2d'); } catch { return; }
  if (!ctx || typeof ctx.measureText !== 'function') return;
  for (const b of blocks) {
    const tw = b._tw; // original PDF text extent, px
    const runs = b.runs || [];
    if (!tw || tw < 4 || !runs.length) continue;
    const text = runs.map((r) => r.text || '').join('');
    if (text.replace(/\s/g, '').length < 2) continue; // too little to measure reliably
    const m0 = runs[0].marks || {};
    const fs = m0.fontSize || 14;
    const family = m0.fontFamily || 'Arial, Helvetica, sans-serif';
    // Measure with the SAME face/weight/style the editor renders (editableHtml), so
    // the measured width matches what the user will actually see on reveal.
    ctx.font = `${m0.italic ? 'italic ' : ''}${m0.bold ? '700' : '400'} ${fs}px ${family}`;
    const measured = ctx.measureText(text).width;
    if (!(measured > 0) || measured >= tw) continue; // substitute already ≥ original: don't shrink
    const scale = Math.min(tw / measured, FIT_MAX);
    if (scale < FIT_MIN) continue;
    for (const r of runs) {
      const cur = (r.marks && r.marks.fontSize) || fs;
      if (r.marks) r.marks.fontSize = Math.max(5, Math.round(cur * scale));
    }
    // Deliberately DON'T grow frame.h: the box height also sizes the opaque mask
    // fill, and a taller fill reaches down over the next baked line and clips it.
    // line-height:1 + overflow:visible means the enlarged glyph still shows in full.
  }
}

/* -------------------------- local-background sampling --------------------------
 * Fill in a mask colour for boxes the importer couldn't sample (text near borders/
 * graphics), by reading the page raster just above/below each line. Browser-only
 * (canvas); any failure leaves the boxes unfilled (no worse than before). */

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

/**
 * Make every positioned text box show ONLY its text over the page image — no opaque
 * rectangle covering the artwork behind it.
 *
 * For each box, sample the page colour AROUND the line and judge whether that surround
 * is UNIFORM:
 *   • UNIFORM (plain paper, table cell, banded header, the flat fill of a diagram) —
 *     ERASE the baked glyph from the raster (paint the footprint with the sampled
 *     colour) and make the box TRANSPARENT (`fill=''`). With the glyph gone there is
 *     nothing to double, and a transparent box lets the real page background show
 *     through, so only the editable text is visible — exactly what the user wants.
 *   • NON-uniform (text over a photo / coloured shape) — we must NOT paint the raster
 *     (it would smear the graphic), so the baked glyph stays; keep an OPAQUE box fill
 *     (the sampled colour) as the only safe way to hide it and avoid doubling.
 *
 * Any page whose raster we changed is re-encoded once. If a box can't be sampled
 * (rare) it keeps whatever fill it already had (safe). Browser-only; on failure the
 * caller leaves boxes with their importer fill (opaque but correct — no doubling).
 */
async function maskPositionedBoxes(pages, blocks) {
  const byPage = new Map();
  for (const b of blocks) {
    if (b.type !== 'posbox') continue;
    if (!byPage.has(b.page)) byPage.set(b.page, []);
    byPage.get(b.page).push(b);
  }
  if (!byPage.size) return;
  for (const [pi, boxes] of byPage) {
    const pg = pages[pi];
    if (!pg || !pg.bg) continue;
    const img = await loadImg(pg.bg);
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    if (!W || !H) continue;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.drawImage(img, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;
    const scale = W / (pg.width || W);
    let erased = 0;
    for (const b of boxes) {
      // Read the background from the pixels BEHIND the text (between the glyphs on the
      // line), skipping the ink — that is the true colour the box sits on, so a label
      // on a diagram's flat fill reads as uniform even when the ellipse/border above or
      // below it varies. Fall back to the above/below band sampler if the line is too
      // dense to sample behind.
      const textHex = normHex((b.runs && b.runs[0] && b.runs[0].marks && b.runs[0].marks.color) || '');
      let { hex, uniform } = sampleBehindText(data, W, H, b.frame, scale, textHex);
      if (!hex) ({ hex, uniform } = sampleBoxBg(data, W, H, b.frame, scale));
      if (!hex) continue; // couldn't sample → keep the box's existing fill (safe)
      if (uniform) {
        // Erase the baked glyph, then make the box transparent so the page image
        // shows through and only the text is drawn. +1px slack so no anti-aliased
        // glyph edge survives around the erased rectangle (matches rasterImages).
        const f = b.frame;
        ctx.fillStyle = `#${hex}`;
        ctx.fillRect(
          Math.round(f.x * scale) - 1, Math.round(f.y * scale) - 1,
          Math.round(f.w * scale) + 2, Math.round(f.h * scale) + 2,
        );
        b.fill = '';
        erased += 1;
      } else {
        // Over artwork we can't erase safely — keep an opaque mask so nothing doubles.
        b.fill = hex;
      }
    }
    // Re-encode the cleaned raster so the erased glyphs are gone behind the overlay.
    if (erased) pg.bg = canvas.toDataURL('image/jpeg', 0.92);
  }
}

/** Background colour BEHIND a text line (the pixels between the glyphs) + whether it
 *  is UNIFORM. Samples the box interior, skips pixels close to the text colour (the
 *  glyph ink), and takes the MEDIAN of the rest — so it reads the true colour the box
 *  sits on, unaffected by artwork above/below the line. A label on a diagram's flat
 *  fill is uniform here (erase → transparent) even if an ellipse edge runs above it;
 *  text over a photo varies (stays opaque-masked). Returns { hex:'', uniform:false }
 *  when too few background pixels are found (e.g. a very dense line) so the caller can
 *  fall back to the band sampler. */
function sampleBehindText(data, W, H, f, scale, textHex) {
  const tc = (textHex && /^[0-9a-f]{6}$/i.test(textHex))
    ? [parseInt(textHex.slice(0, 2), 16), parseInt(textHex.slice(2, 4), 16), parseInt(textHex.slice(4, 6), 16)]
    : null;
  const x0 = Math.max(0, Math.round(f.x * scale)), y0 = Math.max(0, Math.round(f.y * scale));
  const x1 = Math.min(W, Math.round((f.x + f.w) * scale)), y1 = Math.min(H, Math.round((f.y + f.h) * scale));
  if (x1 - x0 < 3 || y1 - y0 < 3) return { hex: '', uniform: false };
  const sx = Math.max(1, Math.floor((x1 - x0) / 60)), sy = Math.max(1, Math.floor((y1 - y0) / 16));
  const rs = [], gs = [], bs = [];
  for (let y = y0; y < y1; y += sy) {
    for (let x = x0; x < x1; x += sx) {
      const i = (y * W + x) * 4, R = data[i], G = data[i + 1], B = data[i + 2];
      // Skip the glyph ink (pixels close to the text colour) so only the background
      // behind the text is measured.
      if (tc && Math.abs(R - tc[0]) + Math.abs(G - tc[1]) + Math.abs(B - tc[2]) < 90) continue;
      rs.push(R); gs.push(G); bs.push(B);
    }
  }
  if (rs.length < 6) return { hex: '', uniform: false }; // too few bg pixels → let caller fall back
  const med = (a) => { const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
  const h = (v) => Math.round(v).toString(16).padStart(2, '0');
  const mr = med(rs), mg = med(gs), mb = med(bs);
  let near = 0;
  for (let i = 0; i < rs.length; i += 1) {
    if (Math.abs(rs[i] - mr) + Math.abs(gs[i] - mg) + Math.abs(bs[i] - mb) <= 44) near += 1;
  }
  return { hex: h(mr) + h(mg) + h(mb), uniform: near / rs.length >= 0.75 };
}

/** Background colour AROUND a text line PLUS whether that surround is UNIFORM enough
 *  to safely paint over (erase the glyph). Samples a band just above and below the
 *  line: the MEDIAN gives the fill (robust to the odd glyph/border pixel), while the
 *  spread of the median-nearest samples judges uniformity — a plain cell/paper/banner
 *  is flat (small spread → uniform), text over a photo or straddling a border varies
 *  (large spread → not uniform, don't paint). Returns { hex:'', uniform:false } when
 *  nothing was in bounds. */
function sampleBoxBg(data, W, H, f, scale) {
  const rs = [], gs = [], bs = [];
  for (let k = 0; k <= 8; k += 1) {
    const cx = f.x + f.w * (k / 8);
    for (const cy of [f.y - f.h * 0.35, f.y - f.h * 0.15, f.y + f.h * 1.15, f.y + f.h * 1.35]) {
      const x = Math.round(cx * scale), y = Math.round(cy * scale);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 4;
      rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    }
  }
  if (!rs.length) return { hex: '', uniform: false };
  const med = (a) => { const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
  const h = (v) => Math.round(v).toString(16).padStart(2, '0');
  const mr = med(rs), mg = med(gs), mb = med(bs);
  // Uniform when most samples sit close to the median colour (chroma distance small).
  // A handful of stray glyph/border pixels are tolerated (2/3 of samples must agree).
  let near = 0;
  for (let i = 0; i < rs.length; i += 1) {
    if (Math.abs(rs[i] - mr) + Math.abs(gs[i] - mg) + Math.abs(bs[i] - mb) <= 40) near += 1;
  }
  const uniform = near / rs.length >= 0.67;
  return { hex: h(mr) + h(mg) + h(mb), uniform };
}

/** Background colour AROUND a text line: the MEDIAN of a band just above and below
 *  it (no brightness assumption, so it works for white cells AND dark banners).
 *  Median is robust to the odd glyph/border pixel. Returns a 6-hex or '' if empty. */
function sampleBg(data, W, H, f, scale) {
  const rs = [], gs = [], bs = [];
  for (let k = 0; k <= 8; k += 1) {
    const cx = f.x + f.w * (k / 8);
    for (const cy of [f.y - f.h * 0.35, f.y - f.h * 0.15, f.y + f.h * 1.15, f.y + f.h * 1.35]) {
      const x = Math.round(cx * scale), y = Math.round(cy * scale);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 4;
      rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    }
  }
  if (!rs.length) return '';
  const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  const h = (v) => Math.round(v).toString(16).padStart(2, '0');
  return h(med(rs)) + h(med(gs)) + h(med(bs));
}

/** Ink colour of a line: the average of pixels INSIDE the box that differ most from
 *  the background — so white-on-blue recovers white, black-on-white recovers black.
 *  Falls back to the background's contrast when nothing stands out. */
function sampleInk(data, W, H, f, scale, bgHex) {
  const bg = [parseInt(bgHex.slice(0, 2), 16), parseInt(bgHex.slice(2, 4), 16), parseInt(bgHex.slice(4, 6), 16)];
  const x0 = Math.max(0, Math.round(f.x * scale)), y0 = Math.max(0, Math.round(f.y * scale));
  const x1 = Math.min(W, Math.round((f.x + f.w) * scale)), y1 = Math.min(H, Math.round((f.y + f.h) * scale));
  const sx = Math.max(1, Math.floor((x1 - x0) / 60)), sy = Math.max(1, Math.floor((y1 - y0) / 14));
  let R = 0, G = 0, B = 0, n = 0;
  for (let y = y0; y < y1; y += sy) {
    for (let x = x0; x < x1; x += sx) {
      const i = (y * W + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
      if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 140) { R += r; G += g; B += b; n += 1; }
    }
  }
  const h = (v) => Math.round(v).toString(16).padStart(2, '0');
  if (n) return h(R / n) + h(G / n) + h(B / n);
  return (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) < 128 ? 'ffffff' : '111111';
}

/* ------------------------- vector-graphic region detection ---------------------
 * Find COLOURFUL, BLOCKY illustration/diagram regions on each page from its raster,
 * so text (and OCR) inside them stays baked as part of the picture. The gate is
 * deliberately narrow — a region qualifies only when it is a sizeable block (not the
 * whole page, not a thin bar/rule) that is genuinely COLOURFUL (saturated pixels from
 * drawn shapes). That is what separates a diagram (green/blue/red/purple shapes) from
 * black-on-white body text and grey/black table grids, which stay fully editable.
 * Browser-only; any failure yields no regions (→ unchanged behaviour). */

async function detectGraphicRegions(pages) {
  const out = pages.map(() => []);
  if (typeof document === 'undefined') return out;
  for (let pi = 0; pi < pages.length; pi += 1) {
    const pg = pages[pi];
    if (!pg || !pg.bg) continue;
    try { out[pi] = await detectPageGraphics(pg); } catch { out[pi] = []; }
  }
  return out;
}

async function detectPageGraphics(pg) {
  const img = await loadImg(pg.bg);
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  if (!W || !H) return [];
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.drawImage(img, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;
  return detectGraphicRegionsFromPixels(data, W, H, pg.w || pg.width || W);
}

/* --------------------------------- OCR pass ------------------------------------
 * Recover text that lives in the page raster (banners, diagram/chart labels, logos)
 * — content with no PDF text layer — as editable positioned boxes. We OCR the SAME
 * (text-erased) raster the page shows, so text-layer content isn't re-read; anything
 * that still overlaps an existing box is dropped as a duplicate. Browser-only. */

const overlaps = (a, f, thresh) => {
  const areaA = a.w * a.h, areaF = f.w * f.h;
  const minArea = Math.min(areaA, areaF); if (minArea <= 0) return false;
  const ix = Math.max(0, Math.min(a.x + a.w, f.x + f.w) - Math.max(a.x, f.x));
  const iy = Math.max(0, Math.min(a.y + a.h, f.y + f.h) - Math.max(a.y, f.y));
  return (ix * iy) / minArea > thresh; // intersection over the SMALLER box
};

/** Relative luminance (0–255) of a 6-hex colour, or null if not a hex. */
const lumOf = (hex) => {
  if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return 0.299 * parseInt(hex.slice(0, 2), 16) + 0.587 * parseInt(hex.slice(2, 4), 16) + 0.114 * parseInt(hex.slice(4, 6), 16);
};

async function recoverBakedText(pages, blocks, figureRegions, onProgress) {
  // Existing text-layer box frames per page — so OCR never duplicates editable text.
  const existing = new Map();
  for (const b of blocks) {
    if (b.type !== 'posbox') continue;
    if (!existing.has(b.page)) existing.set(b.page, []);
    existing.get(b.page).push(b.frame);
  }
  const total = pages.length;
  for (let pi = 0; pi < total; pi += 1) {
    if (onProgress) onProgress(pi, total);
    const pg = pages[pi];
    if (!pg || !pg.bg) continue;
    // Illustrations/diagrams on this page whose baked text is PART OF the picture
    // (embedded XObjects + detected vector-graphic regions). A near-full-page image is
    // a SCANNED page instead — its baked text is the only text there, so OCR must
    // still recover it; keep only the smaller figures here.
    const pageArea = Math.max(1, (pg.width || 0) * (pg.height || 0));
    const figures = ((figureRegions && figureRegions[pi]) || [])
      .filter((im) => (im.w * im.h) / pageArea < 0.85);
    // Recognise the page (throws OcrUnavailableError if no engine is installed — the
    // caller turns that into a friendly note) and load the raster for colour sampling.
    const [res, img] = await Promise.all([
      recognizeRegion({ dataURL: pg.bg, width: pg.width, height: pg.height }),
      loadImg(pg.bg),
    ]);
    const lines = (res && res.lines) || [];
    if (!lines.length) continue;
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    if (!W || !H) continue;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.drawImage(img, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;
    const scale = W / (pg.width || W);
    const frames = existing.get(pi) || [];
    for (const ln of lines) {
      if (!ln.bbox) continue;
      const conf = ln.confidence == null ? 1 : ln.confidence;
      if (conf < 0.55) continue;                          // drop garbage (diagram strokes, noise)
      const txt = String(ln.text || '').trim();
      if (!/[A-Za-z0-9]/.test(txt)) continue;             // must carry a real word/number
      const x = ln.bbox.x0 / scale, y = ln.bbox.y0 / scale;
      const w = (ln.bbox.x1 - ln.bbox.x0) / scale, hh = (ln.bbox.y1 - ln.bbox.y0) / scale;
      if (hh < 6 || w < 4 || hh > (pg.height || 1e9) * 0.5) continue;
      const frame = { x: Math.round(x), y: Math.round(y), w: Math.round(w + hh * 0.4), h: Math.round(hh) };
      // Skip if it substantially overlaps ANY existing box (relative to the SMALLER
      // of the two, so a wide OCR line over a tight text box — or vice versa — is
      // still caught): that text is already editable; a second box would double it.
      if (frames.some((f) => overlaps(frame, f, 0.3))) continue;
      // Text lying INSIDE a discrete illustration is part of that artwork, not the
      // document's real text: leave it baked in the picture rather than stamping a
      // second, floating editable box (with an opaque fill) over the image. A line
      // counts as "inside" when the majority of IT overlaps a figure, so a caption
      // sitting just below/beside an image is still recovered as editable text.
      if (figures.some((im) => overlaps(frame, im, 0.5))) continue;
      const { fill, color } = sampleOcrStyle(data, W, H, frame, scale);
      // Drop mis-sampled boxes whose fill and ink are near-identical: the text would
      // render invisibly and the opaque fill shows as a stray mark on a dark area.
      if (lumOf(fill) != null && Math.abs(lumOf(fill) - lumOf(color)) < 40) continue;
      const fs = Math.max(8, Math.round(hh * 0.72));
      const box = {
        id: `ocr-${(++boxSeq).toString(36)}`, type: 'posbox', page: pi, ocr: true,
        frame, style: { align: 'left' },
        runs: [createRun(txt, { fontSize: fs, color: hexOf(color) })],
        fill: fill || '',
        _size: fs, _bold: false, _len: txt.length, // for heading inference
      };
      blocks.push(box);
      frames.push(frame); // avoid double-adding overlapping OCR lines on this page
    }
  }
}

/** Fill (banner background) + ink (text colour) for a recovered OCR line, using the
 *  brightness-agnostic samplers — so a white-on-blue banner recovers as white text
 *  over a blue mask (matching the original), not dark text on a white box. */
function sampleOcrStyle(data, W, H, f, scale) {
  const fill = sampleBg(data, W, H, f, scale) || 'ffffff';
  const color = sampleInk(data, W, H, f, scale, fill);
  return { fill, color };
}
