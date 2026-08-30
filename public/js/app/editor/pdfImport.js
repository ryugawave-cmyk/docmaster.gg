/**
 * Render a PDF file into page background images for the blank editor.
 *
 * Each PDF page is rasterised (via the shared PDF.js layer) to a JPEG data URL at
 * a crisp scale, plus its CSS-pixel size (@96dpi). The blank editor then shows
 * these as immutable page backgrounds and lets the user compose text/shapes/etc.
 * on top — a single, consistent editing surface for both new and imported PDFs.
 *
 * We ALSO probe each page's text layer (`getTextContent`) so callers can tell a
 * real text PDF apart from a scanned/image-only PDF: the latter has no text
 * layer, so its "text" is pixels that need OCR before it can be edited.
 */
import { getDocument, CSS_UNITS, PDF_DOCUMENT_DEFAULTS, Util, OPS } from '../../workspace/pdf/pdfjs.js';
import { fontPropsFromName } from './fontWeight.js';

const MAX_PAGES = 300;          // safety cap for very large files
const RASTER_SCALE = 1.6;       // render above CSS size for sharpness
const MAX_CANVAS_PX = 4_000_000; // per-page pixel budget (keeps memory sane)

/**
 * @param {File} file
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<{ name:string, pageW:number, pageH:number, textChars:number,
 *   scanned:boolean, pages:{bg:string,w:number,h:number,textChars:number,
 *   texts:ExtractedText[], images:ExtractedImage[]}[] }>}
 *
 * @typedef {{x:number,y:number,w:number,h:number,text:string,fontSize:number,
 *   color:string,boxBg:string,fontFamily:string}} ExtractedText
 * @typedef {{src:string,x:number,y:number,w:number,h:number}} ExtractedImage
 */
export async function renderPdfToPages(file, onProgress) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocument({ data, ...PDF_DOCUMENT_DEFAULTS }).promise;
  const count = Math.min(pdf.numPages, MAX_PAGES);
  const pages = [];
  let pageW = 0, pageH = 0;
  let textChars = 0;

  for (let i = 1; i <= count; i += 1) {
    const page = await pdf.getPage(i);
    const cssVp = page.getViewport({ scale: CSS_UNITS });
    const w = Math.round(cssVp.width), h = Math.round(cssVp.height);
    if (i === 1) { pageW = w; pageH = h; }

    // Raster scale, clamped so a single page canvas can't blow the pixel budget.
    let scale = CSS_UNITS * RASTER_SCALE;
    const area = cssVp.width * cssVp.height * (RASTER_SCALE * RASTER_SCALE);
    if (area > MAX_CANVAS_PX) scale *= Math.sqrt(MAX_CANVAS_PX / area);

    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    // The page's content-stream operator list drives BOTH true text colour and
    // image extraction, so fetch it once and share. Any failure degrades
    // gracefully (no colours / no images) — the page still opens fine.
    let opList = null;
    try { opList = await page.getOperatorList(); } catch { opList = null; }

    // Probe the text layer (how many real characters this page carries) and, when
    // there is text, lift it into editable text-box descriptors laid over the
    // rendered page. Any failure degrades gracefully to "no editable text" — the
    // page still opens as a background image.
    let pageChars = 0;
    let texts = [];
    try {
      const tc = await page.getTextContent();
      for (const it of tc.items) pageChars += (it.str || '').trim().length;
      if (pageChars > 0) {
        const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        // True per-run fill colours read from the page's content stream (see
        // extractFillColors). Falls back to null so extraction degrades to the
        // pixel-sampled colour if the operator list can't be read.
        let colors = null;
        if (opList) { try { colors = extractFillColors(opList); } catch { colors = null; } }
        texts = extractPageTexts(tc, cssVp, px, canvas.width, canvas.height, colors, page);
      }
    } catch { /* no text layer / extraction unsupported */ }
    textChars += pageChars;

    // Recover the page's embedded images (logos, signatures, seals, barcodes,
    // photos) as REAL pictures at their exact position/size, so converters can
    // place them instead of losing them into the flattened raster. Best-effort.
    let images = [];
    if (opList) {
      try {
        const rects = extractImageRects(opList, cssVp);
        if (rects.length) images = await cropImages(page, vp, rects, canvas.width, canvas.height, canvas.width / cssVp.width, w, h, canvas);
      } catch { images = []; }
    }

    pages.push({ bg: canvas.toDataURL('image/jpeg', 0.82), w, h, textChars: pageChars, texts, images });
    page.cleanup?.();
    onProgress?.(i, count);
  }

  try { await pdf.cleanup(); await pdf.destroy(); } catch { /* already gone */ }
  // No extractable text across a document that clearly has page content ⇒ the
  // pages are scanned images (or vector art without a text layer) ⇒ OCR needed.
  const scanned = count > 0 && textChars === 0;
  return { name: file.name, pageW, pageH, pages, textChars, scanned };
}

/* ------------------------- text-layer extraction ------------------------- */

/**
 * Turn a page's text layer into editable text-box descriptors positioned over
 * the rendered page (coordinates in page px @96dpi, matching the editor model).
 *
 * Each PDF text run becomes one box. Because the SAME glyphs are also baked into
 * the background raster, every box carries a `boxBg` mask colour sampled from the
 * page around the run so the editable box hides the original. A run is only made
 * editable when its surrounding background is uniform enough to mask cleanly —
 * so we never drop a mismatched rectangle over artwork, gradients or photos.
 *
 * @param {{items:any[],styles:Record<string,any>}} tc  page.getTextContent() result
 * @param {{transform:number[],width:number,height:number}} cssVp  viewport @ CSS_UNITS
 * @param {Uint8ClampedArray} px  RGBA pixels of the rendered page canvas
 * @param {number} cw  canvas width in px
 * @param {number} ch  canvas height in px
 * @param {ColorRun[]|null} colors  true fill colours from the content stream
 * @param {any} [page]  PDF.js page proxy — its resolved font objects carry the real
 *   PostScript font name, from which the true weight (bold/semibold/…) is read.
 * @returns {ExtractedText[]}
 */
function extractPageTexts(tc, cssVp, px, cw, ch, colors, page) {
  const out = [];
  const rf = cw / cssVp.width; // canvas px per CSS px
  const fontCache = new Map(); // fontName → { bold, italic, weight } (one lookup per font)
  for (const it of tc.items) {
    if (!it || typeof it.str !== 'string' || !it.transform) continue;
    const str = it.str;
    if (!str.trim()) continue;
    const style = tc.styles?.[it.fontName];
    if (style?.vertical) continue; // vertical text: leave baked in the image

    const tx = Util.transform(cssVp.transform, it.transform);
    if (Math.abs(Math.atan2(tx[1], tx[0])) > 0.02) continue; // rotated: leave baked
    const fontSize = Math.hypot(tx[2], tx[3]);
    if (!(fontSize >= 5) || fontSize > 400) continue; // too tiny to place / implausible

    const width = Math.max((it.width || 0) * CSS_UNITS, fontSize * 0.35);
    const ascent = fontSize * 0.82;      // approx cap/ascent above the baseline
    const left = tx[4];
    const top = tx[5] - ascent;          // tx[5] is the baseline (device y grows down)
    const height = fontSize * 1.08;      // covers ascent + descent
    // Skip runs that fall outside the page — never place a stray box.
    if (left < -4 || top < -4 || left + width > cssVp.width + 4 || top + height > cssVp.height + 4) continue;

    // `sample` may be null when the surround isn't uniform enough to mask cleanly
    // (text hugging a logo/barcode/photo/border). We still KEEP the run — losing
    // real text is far worse than losing a mask. A null sample just means no
    // `boxBg`: dormant imported runs are transparent, so nothing is drawn over the
    // graphic at rest, and an edited run simply carries no mask rectangle (exactly
    // the "never drop a mismatched rectangle" invariant). This is what lets text
    // sitting beside artwork still reach the editor and every converter.
    const sample = sampleRun(px, cw, ch, left * rf, top * rf, width * rf, height * rf, fontSize * rf);

    // Prefer the true fill colour from the content stream; the pixel-sampled
    // colour is only a fallback for runs the operator list didn't resolve.
    const trueColor = matchColor(colors, it.transform[4], it.transform[5], fontSize / CSS_UNITS);

    // Real font weight/style from the embedded font (bold headings must STAY bold in
    // the DOC). Cached per font id so each font is probed once.
    let fp = fontCache.get(it.fontName);
    if (!fp) { fp = getFontProps(page, it.fontName, style); fontCache.set(it.fontName, fp); }

    out.push({
      x: round1(left), y: round1(top), w: round1(width), h: round1(Math.max(height, 8)),
      text: str, fontSize: round1(fontSize),
      color: trueColor || (sample && sample.color) || '#000000',
      boxBg: sample ? sample.bg : '',
      fontFamily: mapFamily(style),
      bold: fp.bold, italic: fp.italic, fontWeight: fp.weight,
    });
    if (out.length >= 2000) break; // pathological-page guard
  }
  return dropWatermarks(out);
}

/**
 * Drop decorative watermark / margin-band text — a longish string repeated many
 * times across a page (e.g. an "STAFF SELECTION COMMISSION" side border, a
 * "CONFIDENTIAL" tile). It is not content: kept, it floods the conversion and
 * scrambles reading order. Frequency-based so it stays GENERIC — no per-document
 * strings. Real content (unique lines, short repeated values like "NA"/"50") is
 * untouched: a match needs BOTH a long string (≥8 chars) AND many repeats (≥5).
 * @param {ExtractedText[]} runs
 * @returns {ExtractedText[]}
 */
function dropWatermarks(runs) {
  const norm = (t) => t.trim().toLowerCase().replace(/\s+/g, ' ');
  // A whole band returned as ONE run: a word-phrase (≥2 words, ≥6 chars) repeated
  // back-to-back ≥3 times. Catches "STAFF SELECTION COMMISSION STAFF SELECTION …"
  // which the duplicate-run count below misses (it's a single item, not 5 items).
  const isBand = (t) => {
    const words = norm(t).split(' ').filter(Boolean);
    if (words.length < 4) return false;
    for (let unit = 1; unit <= Math.floor(words.length / 3); unit += 1) {
      const phrase = words.slice(0, unit).join(' ');
      // Single-word band ("CONFIDENTIAL"×N): long word, ≥4×, so "NA NA NA" is kept.
      const minLen = unit === 1 ? 8 : 6;
      const minReps = unit === 1 ? 4 : 3;
      if (phrase.length < minLen) continue;
      let reps = 0;
      while ((reps + 1) * unit <= words.length
        && words.slice(reps * unit, (reps + 1) * unit).join(' ') === phrase) reps += 1;
      if (reps >= minReps) return true;
    }
    return false;
  };
  const freq = new Map();
  for (const r of runs) {
    const k = norm(r.text);
    if (k.length >= 8) freq.set(k, (freq.get(k) || 0) + 1);
  }
  return runs.filter((r) => {
    if (isBand(r.text)) return false;
    const k = norm(r.text);
    return !(k.length >= 8 && (freq.get(k) || 0) >= 5);
  });
}

/* --------------------------- true text colour ---------------------------- */

/**
 * @typedef {{x:number,y:number,color:string}} ColorRun
 *   A text-showing operation's baseline origin (in PDF user-space points) and
 *   the exact fill colour in force at that point.
 */

/**
 * Read the exact fill colour of every text-showing operation from a page's
 * content stream, so imported runs keep their ORIGINAL colour instead of a
 * colour guessed from anti-aliased pixels (which drifts black text toward the
 * blue/orange of nearby links, form-field tints or JPEG fringing).
 *
 * We walk the operator list maintaining the graphics state (CTM + fill colour,
 * saved/restored by q/Q) and the text matrices, and record one entry per show
 * operation. PDF.js normalises device colour operators (gray/RGB/CMYK) to
 * `setFillRGBColor` with 0–255 bytes; pattern fills (`setFillColorN`) are left
 * unresolved so those runs fall back to the sampled colour.
 *
 * @param {{fnArray:number[],argsArray:any[]}} opList  page.getOperatorList() result
 * @returns {ColorRun[]}
 */
function extractFillColors(opList) {
  const { fnArray, argsArray } = opList;
  const runs = [];

  const ID = [1, 0, 0, 1, 0, 0];
  let ctm = ID.slice();
  let fill = [0, 0, 0];            // PDF default fill colour is black
  const gsStack = [];
  let tm = ID.slice(), tlm = ID.slice();
  let fontSize = 0, charSp = 0, wordSp = 0, hScale = 1, leading = 0;

  const moveLine = (tx, ty) => { tlm = Util.transform(tlm, [1, 0, 0, 1, tx, ty]); tm = tlm.slice(); };
  const show = (glyphs) => {
    const trm = Util.transform(ctm, tm);
    runs.push({ x: trm[4], y: trm[5], color: fill ? hex(fill) : null });
    if (Array.isArray(glyphs) && fontSize) {
      let tx = 0;
      for (const g of glyphs) {
        if (typeof g === 'number') { tx -= (g / 1000) * fontSize * hScale; continue; }
        const w = ((g && g.width) || 0) / 1000 * fontSize;
        tx += (w + charSp + (g && g.unicode === ' ' ? wordSp : 0)) * hScale;
      }
      tm = Util.transform(tm, [1, 0, 0, 1, tx, 0]);
    }
    if (runs.length >= 20000) throw new Error('too many runs'); // pathological guard
  };

  for (let i = 0; i < fnArray.length; i += 1) {
    const a = argsArray[i];
    switch (fnArray[i]) {
      case OPS.save: gsStack.push({ ctm: ctm.slice(), fill: fill ? fill.slice() : null }); break;
      case OPS.restore: { const s = gsStack.pop(); if (s) { ctm = s.ctm; fill = s.fill; } break; }
      case OPS.transform: ctm = Util.transform(ctm, a); break;
      case OPS.setFillRGBColor: fill = [a[0], a[1], a[2]]; break;
      case OPS.setFillGray: fill = [a[0] * 255, a[0] * 255, a[0] * 255]; break;
      case OPS.setFillCMYKColor: fill = cmykToRgb(a[0], a[1], a[2], a[3]); break;
      case OPS.setFillColor: case OPS.setFillColorN: fill = null; break; // unresolved space/pattern
      case OPS.beginText: tm = ID.slice(); tlm = ID.slice(); break;
      case OPS.setTextMatrix: tm = a.slice(0, 6); tlm = a.slice(0, 6); break;
      case OPS.setLeading: leading = a[0]; break;
      case OPS.setFont: fontSize = a[1]; break;
      case OPS.setCharSpacing: charSp = a[0]; break;
      case OPS.setWordSpacing: wordSp = a[0]; break;
      case OPS.setHScale: hScale = a[0] / 100; break;
      case OPS.moveText: moveLine(a[0], a[1]); break;
      case OPS.setLeadingMoveText: leading = -a[1]; moveLine(a[0], a[1]); break;
      case OPS.nextLine: moveLine(0, -leading); break;
      case OPS.showText: show(a[0]); break;
      case OPS.nextLineShowText: moveLine(0, -leading); show(a[0]); break;
      case OPS.nextLineSetSpacingShowText: wordSp = a[0]; charSp = a[1]; moveLine(0, -leading); show(a[2]); break;
      default: break;
    }
  }
  return runs;
}

/**
 * Nearest text-show origin to a run's baseline, matched on the same line (small
 * dy) and closest along it (dx). Returns its colour hex, or null when nothing
 * resolved is close enough (caller then keeps the sampled fallback).
 * @param {ColorRun[]|null} colors
 * @param {number} ox  run origin x (PDF points)
 * @param {number} oy  run origin y (PDF points)
 * @param {number} fs  run font size (PDF points)
 */
function matchColor(colors, ox, oy, fs) {
  if (!colors || !colors.length) return null;
  const yTol = Math.max(2, fs * 0.6);
  let best = null, bestScore = Infinity;
  for (const c of colors) {
    if (!c.color) continue;
    const dy = Math.abs(c.y - oy);
    if (dy > yTol) continue;
    const score = Math.abs(c.x - ox) + dy * 4;
    if (score < bestScore) { bestScore = score; best = c; }
  }
  // Accept only a reasonably close match along the line (guards against picking
  // an unrelated run when this glyph's own show op wasn't captured).
  return best && bestScore <= Math.max(24, fs * 12) ? best.color : null;
}

function cmykToRgb(c, m, y, k) {
  return [255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)];
}

/* --------------------------- embedded images ----------------------------- */

/**
 * Locate every embedded image the page draws — its exact rectangle in page CSS
 * px (@96dpi, the editor/model coordinate space). Read straight from the content
 * stream's paint operators, walking the CTM (saved/restored by q/Q), so we get
 * the true position and size of each XObject/inline/stencil image regardless of
 * how it was encoded. An image is drawn in the unit square [0,1]², so its device
 * rectangle is that square mapped through (viewport ∘ CTM).
 *
 * @param {{fnArray:number[],argsArray:any[]}} opList  page.getOperatorList() result
 * @param {{transform:number[]}} cssVp  viewport @ CSS_UNITS
 * @returns {{x:number,y:number,w:number,h:number}[]}  page-px rectangles
 */
function extractImageRects(opList, cssVp) {
  const { fnArray, argsArray } = opList;
  const ID = [1, 0, 0, 1, 0, 0];
  let ctm = ID.slice();
  const stack = [];
  const vp = cssVp.transform;
  const rects = [];
  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i];
    if (fn === OPS.save) { stack.push(ctm.slice()); continue; }
    if (fn === OPS.restore) { const s = stack.pop(); if (s) ctm = s; continue; }
    if (fn === OPS.transform) { ctm = Util.transform(ctm, argsArray[i]); continue; }
    if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      const m = Util.transform(vp, ctm); // unit square → device (page CSS px)
      const xs = [], ys = [];
      for (const [ux, uy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        xs.push(m[0] * ux + m[2] * uy + m[4]);
        ys.push(m[1] * ux + m[3] * uy + m[5]);
      }
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      if (rects.length >= 200) break; // pathological-page guard
    }
  }
  return rects;
}

/**
 * Crop each located image out of the page as a PNG (lossless, alpha-preserving).
 * Pixels are read from a SECOND render onto a transparent canvas, so an image
 * that was transparent in the PDF stays transparent in the DOCX rather than
 * picking up a white box. Returns page-px positioned image descriptors.
 *
 * @param {any} page  PDF.js page proxy (already rendered once for the raster)
 * @param {object} vp  the same scaled viewport used for the raster canvas
 * @param {{x:number,y:number,w:number,h:number}[]} rects  page-px rectangles
 * @param {number} cw  canvas width in px
 * @param {number} ch  canvas height in px
 * @param {number} rf  canvas px per page (CSS) px
 * @param {number} pageW  page width in CSS px
 * @param {number} pageH  page height in CSS px
 * @param {HTMLCanvasElement} baseCanvas  the opaque (white-bg) page render, used
 *   as a fallback when the transparent crop comes out empty
 * @returns {Promise<ExtractedImage[]>}
 */
async function cropImages(page, vp, rects, cw, ch, rf, pageW, pageH, baseCanvas) {
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d'); // alpha:true (default) → transparent backdrop
  await page.render({ canvasContext: ctx, viewport: vp, background: 'rgba(0,0,0,0)' }).promise;

  const out = [];
  const seen = new Set();
  const pageArea = pageW * pageH;
  for (const r of rects) {
    if (r.w < 3 || r.h < 3) continue;                     // too small to be a real picture
    if (r.w * r.h > pageArea * 0.92) continue;            // full-page image = the page itself
    const x = Math.max(0, Math.round(r.x * rf));
    const y = Math.max(0, Math.round(r.y * rf));
    const w = Math.min(cw - x, Math.round(r.w * rf));
    const h = Math.min(ch - y, Math.round(r.h * rf));
    if (w < 3 || h < 3) continue;
    const key = `${x},${y},${w},${h}`;
    if (seen.has(key)) continue;                          // same image painted twice
    seen.add(key);
    const crop = document.createElement('canvas');
    crop.width = w; crop.height = h;
    const cctx = crop.getContext('2d');
    cctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
    // A 1-bit image MASK (e.g. some barcodes) can paint nothing onto a transparent
    // backdrop, leaving an empty crop → the image would silently vanish. When that
    // happens, fall back to the opaque page render so we still capture it (on white).
    if (baseCanvas && isBlankCrop(cctx, w, h)) {
      cctx.clearRect(0, 0, w, h);
      cctx.drawImage(baseCanvas, x, y, w, h, 0, 0, w, h);
    }
    out.push({ src: crop.toDataURL('image/png'), x: round1(r.x), y: round1(r.y), w: round1(r.w), h: round1(r.h) });
    if (out.length >= 50) break; // sanity cap
  }
  return out;
}

/** True when a crop is effectively empty (every sampled pixel fully transparent). */
function isBlankCrop(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.length; i += 16) if (d[i] >= 8) return false; // sample every 4th px's alpha
  return true;
}

/**
 * Sample a run's background (mask) colour and glyph (text) colour from the
 * rendered page pixels. Background comes from points JUST OUTSIDE the run box
 * (the surrounding whitespace); text colour is the in-box pixel furthest from
 * that background. Returns `null` when the surrounding background is not uniform
 * enough to mask the run cleanly. Coordinates are in canvas px.
 */
function sampleRun(px, W, H, x, y, w, h, fontPx) {
  const m = Math.max(2, Math.min(Math.round(fontPx * 0.3), 8));
  const cols = [];
  for (const sx of [x, x + w * 0.25, x + w * 0.5, x + w * 0.75, x + w]) {
    push(cols, colorAt(px, W, H, sx, y - m));
    push(cols, colorAt(px, W, H, sx, y + h + m));
  }
  for (const sy of [y, y + h * 0.5, y + h]) {
    push(cols, colorAt(px, W, H, x - m, sy));
    push(cols, colorAt(px, W, H, x + w + m, sy));
  }
  if (cols.length < 6) return null;

  const bg = modeColor(cols);
  let near = 0;
  for (const c of cols) if (dist(c, bg) <= 40) near += 1;
  if (near / cols.length < 0.6) return null; // non-uniform surround → don't mask

  const inside = [];
  const stepX = Math.max(1, Math.round(w / 24));
  const stepY = Math.max(1, Math.round(h / 8));
  for (let sy = y + 1; sy < y + h - 1; sy += stepY) {
    for (let sx = x + 1; sx < x + w - 1; sx += stepX) {
      const c = colorAt(px, W, H, sx, sy);
      if (c && dist(c, bg) > 60) inside.push(c);
    }
  }
  const color = inside.length ? modeColor(inside) : (luma(bg) > 140 ? [17, 24, 39] : [245, 245, 245]);
  return { bg: hex(bg), color: hex(color) };
}

function push(arr, c) { if (c) arr.push(c); }
function colorAt(px, W, H, x, y) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return null;
  const i = (y * W + x) * 4;
  return [px[i], px[i + 1], px[i + 2]];
}
/** Dominant colour of a sample set (averaged within the largest 16-level bucket). */
function modeColor(cols) {
  const buckets = new Map();
  for (const c of cols) {
    const key = `${c[0] >> 4},${c[1] >> 4},${c[2] >> 4}`;
    let b = buckets.get(key);
    if (!b) { b = { n: 0, r: 0, g: 0, bl: 0 }; buckets.set(key, b); }
    b.n += 1; b.r += c[0]; b.g += c[1]; b.bl += c[2];
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.bl / best.n)];
}
function dist(a, b) { return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]); }
function luma(c) { return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]; }
function hex(c) { return `#${c.map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('')}`; }
function round1(n) { return Math.round(n * 10) / 10; }
/** Map PDF.js's font-family hint to a safe, always-available CSS stack. */
function mapFamily(style) {
  const f = (style?.fontFamily || '').toLowerCase();
  if (f.includes('mono')) return '"Courier New", Courier, monospace';
  if (f.includes('serif') && !f.includes('sans')) return 'Georgia, "Times New Roman", serif';
  return 'Arial, Helvetica, sans-serif';
}

/**
 * Resolve a run's true weight/italic from the page's embedded font. PDF.js exposes
 * the translated font on `page.commonObjs` under the text item's `fontName`; its
 * `.name` is the original PostScript name (e.g. "ABCDEF+Arial-BoldMT") and it may
 * also carry explicit `bold`/`italic`/`black` flags. We hand both to the shared,
 * dependency-free inferrer (fontWeight.js) so the weight logic is unit-testable.
 * Any failure (font not yet resolved) degrades to regular/upright.
 * @returns {{bold:boolean, italic:boolean, weight:number}}
 */
function getFontProps(page, fontName, style) {
  let name = '';
  const flags = {};
  try {
    const objs = page && page.commonObjs;
    const f = objs && (!objs.has || objs.has(fontName)) ? objs.get(fontName) : null;
    if (f) {
      name = f.name || f.loadedName || '';
      if (typeof f.bold === 'boolean') flags.bold = f.bold;
      if (typeof f.italic === 'boolean') flags.italic = f.italic;
      if (flags.bold == null && f.black === true) flags.bold = true;
    }
  } catch { /* font object not resolved — fall back to the family hint below */ }
  return fontPropsFromName(name, style?.fontFamily, flags);
}
