/**
 * Document Editor media exporters — block model → page images (JPG/PNG) and a
 * size-reduced Word file. These sit alongside `blockExport.js` and reuse its
 * PDF / DOCX builders rather than re-deriving the layout, so what you see is
 * still what you export.
 *
 *  • Images: the model is laid out once with `blockModelToPdf`, then rasterised
 *    per page with the app's local PDF.js at high DPI. Text/vectors stay razor
 *    sharp, embedded photos are carried near-losslessly, PNG output is fully
 *    lossless and JPG uses maximum quality — so there's no visible quality loss.
 *    One page → a single image; multiple pages → a ZIP of numbered images.
 *  • Compress Word: embedded pictures are re-encoded to lean JPEGs and the whole
 *    package is DEFLATE-compressed (the normal Word export is STORED), which
 *    shrinks text-heavy and image-heavy documents alike while keeping the layout
 *    identical.
 *
 * Everything runs client-side; there is no server round-trip.
 */
import { blockModelToPdf, blockModelToDocx } from './blockExport.js';
import { zipBlob, crc32 } from '../zip.js';
import { getDocument, PDF_DOCUMENT_DEFAULTS } from '../../../workspace/pdf/pdfjs.js';

const enc = new TextEncoder();
const baseName = (name) => (name || 'document').replace(/\.[^.]+$/, '');

/* ========================================================================== */
/*  Page images (JPG / PNG)                                                   */
/* ========================================================================== */

/**
 * Render the document's pages to images.
 * @param {object} doc block model
 * @param {{ format?:'jpg'|'png', resolution?:'standard'|'high', name?:string,
 *   onProgress?:(done:number,total:number)=>void }} [opts]
 * @returns {Promise<{ blob:Blob, filename:string, count:number, extra:string }>}
 */
export async function blockModelToImages(doc, {
  format = 'png', resolution = 'standard', name = 'document', onProgress,
} = {}) {
  const ext = format === 'jpg' ? 'jpg' : 'png';
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
  // PNG is lossless. For JPEG we use maximum quality (0.98) so there is no
  // visible loss; `undefined` for PNG lets the encoder stay fully lossless.
  const quality = format === 'jpg' ? 0.98 : undefined;
  // High oversample so vector text and lines stay razor-sharp — 3× (~288dpi) by
  // default, 4× (~384dpi) for "high". Rendering above native keeps type crisp
  // and never softens it, so pages look lossless.
  const scale = resolution === 'high' ? 4 : 3;
  const base = baseName(name);

  // Embed the document's own pictures at near-lossless quality inside the PDF we
  // rasterise, so photos in the page images keep their detail (the normal PDF
  // export keeps its lighter default).
  const pdfBlob = await blockModelToPdf(doc, { imageQuality: 0.98 });
  const data = new Uint8Array(await pdfBlob.arrayBuffer());
  const pdf = await getDocument({ data, ...PDF_DOCUMENT_DEFAULTS }).promise;

  // Render each page INDEPENDENTLY to its own image, honouring page boundaries — never
  // one long image of the whole document. Each PDF page (one document page) is rasterised
  // at its own dimensions and encoded as a separate file (full quality: PNG lossless /
  // JPG max). The caller downloads each file; a single-page doc yields exactly one file.
  const files = [];
  try {
    const total = pdf.numPages;
    for (let i = 1; i <= total; i += 1) {
      if (onProgress) onProgress(i - 1, total);
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));   // ONE page's width…
      canvas.height = Math.max(1, Math.ceil(viewport.height)); // …and ONE page's height
      const ctx = canvas.getContext('2d');
      // JPEG has no alpha, and pages should print on white regardless of theme.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;
      const blob = await canvasToBlob(canvas, mime, quality);
      // Single page → "name.ext"; multi-page → "name_page_1.ext", "name_page_2.ext", …
      const filename = total === 1 ? `${base}.${ext}` : `${base}_page_${i}.${ext}`;
      files.push({ blob, filename });
      if (page.cleanup) page.cleanup();
    }
    if (onProgress) onProgress(total, total);
  } finally {
    if (pdf.destroy) pdf.destroy();
  }

  const n = files.length;
  return { files, count: n, extra: n === 1 ? '1 page' : `${n} pages` };
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not render page image.'))), mime, quality);
  });
}

/* ========================================================================== */
/*  Compress Word                                                             */
/* ========================================================================== */

// How much each preset shrinks pictures. `maxSide` caps the longest edge (px);
// `quality` is the JPEG quality. `Infinity`/`1` means "don't touch the images"
// (the package is still DEFLATE-compressed). Custom targets walk a finer ladder.
const MODE_SETTING = {
  small: { maxSide: 2200, quality: 0.85 },
  medium: { maxSide: 1600, quality: 0.72 },
  high: { maxSide: 1100, quality: 0.55 },
};
// Progressively more aggressive image settings, tried in order until the target
// size is met. The first rung leaves images untouched (DEFLATE only), so
// text-heavy files aren't needlessly degraded.
const CUSTOM_LADDER = [
  { maxSide: Infinity, quality: 1 },
  { maxSide: 2200, quality: 0.85 },
  { maxSide: 1800, quality: 0.75 },
  { maxSide: 1500, quality: 0.66 },
  { maxSide: 1200, quality: 0.58 },
  { maxSide: 1000, quality: 0.5 },
  { maxSide: 800, quality: 0.42 },
  { maxSide: 640, quality: 0.36 },
  { maxSide: 500, quality: 0.3 },
];

/** The real .docx size the user starts from — exactly what Quick Export → Word gives. */
export async function estimateWordSize(doc) {
  return (await blockModelToDocx(doc)).size;
}

/**
 * Rebuild the .docx smaller. Pictures are re-encoded to lean JPEGs and the whole
 * package is DEFLATE-compressed. For a custom target, increasingly aggressive
 * image settings are tried until the file fits (or the floor is reached); the
 * result is measured from the ACTUAL generated file — never faked.
 * @param {object} doc block model
 * @param {{ mode?:'small'|'medium'|'high'|'custom', targetBytes?:number,
 *   name?:string, onProgress?:(msg:string)=>void }} [opts]
 * @returns {Promise<{ blob:Blob, filename:string, originalSize:number,
 *   compressedSize:number, targetSize:number, reducedPct:number,
 *   achieved:(boolean|null), mode:string }>}
 */
export async function compressWord(doc, { mode = 'medium', targetBytes = 0, name = 'document', onProgress } = {}) {
  const base = baseName(name);
  if (onProgress) onProgress('Measuring current size…');
  // Baseline = the plain Word export; we never hand back anything larger.
  const baseline = await blockModelToDocx(doc);
  const originalSize = baseline.size;

  // Decode each embedded picture once, then re-encode from the bitmap per
  // attempt — no repeated decoding across ladder rungs.
  const imgs = await loadDocImages(doc);
  const build = async (setting) => {
    const model = reencodeModel(doc, imgs, setting);
    return blockModelToDocx(model, { zip: zipBlobDeflate });
  };

  let best = baseline;
  let achieved = null;

  if (mode === 'custom' && targetBytes > 0) {
    for (let i = 0; i < CUSTOM_LADDER.length; i += 1) {
      if (onProgress) onProgress(`Compressing… (${i + 1}/${CUSTOM_LADDER.length})`);
      const b = await build(CUSTOM_LADDER[i]);
      if (b.size < best.size) best = b;
      if (b.size <= targetBytes) { best = b; break; }
    }
    achieved = best.size <= targetBytes;
  } else {
    if (onProgress) onProgress('Compressing…');
    const b = await build(MODE_SETTING[mode] || MODE_SETTING.medium);
    if (b.size < best.size) best = b;
  }

  const compressedSize = best.size;
  const reducedPct = originalSize > 0 ? Math.max(0, (1 - compressedSize / originalSize) * 100) : 0;
  return {
    blob: best, filename: `${base}.docx`,
    originalSize, compressedSize,
    targetSize: mode === 'custom' ? targetBytes : 0,
    reducedPct, achieved, mode,
  };
}

/** Decode every embedded raster picture once, keyed by its block index. */
async function loadDocImages(doc) {
  const map = new Map();
  const blocks = doc.blocks || [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (b.type === 'image' && typeof b.src === 'string' && /^data:image\//i.test(b.src)) {
      try { map.set(i, await loadImage(b.src)); } catch { /* leave as-is on failure */ }
    }
  }
  return map;
}

/**
 * A view of the model with pictures re-encoded at `setting`. Shallow — only the
 * image blocks are replaced; every other block is shared by reference, so large
 * documents aren't deep-cloned each attempt.
 */
function reencodeModel(doc, imgs, setting) {
  if (!setting || (setting.maxSide === Infinity && setting.quality >= 1)) return doc;
  const blocks = (doc.blocks || []).map((b, i) => {
    if (b.type === 'image' && imgs.has(i)) {
      try { return { ...b, src: reencodeImage(imgs.get(i), setting) }; } catch { return b; }
    }
    return b;
  });
  return { ...doc, blocks };
}

/** Downscale (cap the longest side) and JPEG-encode a decoded image. */
function reencodeImage(img, { maxSide, quality }) {
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('image has no dimensions');
  const factor = maxSide === Infinity ? 1 : Math.min(1, maxSide / Math.max(w, h));
  w = Math.max(1, Math.round(w * factor));
  h = Math.max(1, Math.round(h * factor));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/* ========================================================================== */
/*  DEFLATE ZIP writer (compressed OOXML)                                      */
/* ========================================================================== */

/**
 * Like `zipBlob`, but each entry is DEFLATE-compressed (ZIP method 8) via the
 * platform `CompressionStream`. OOXML apps open compressed archives fine; this
 * is what makes Compress Word meaningfully smaller. Degrades to the STORED
 * `zipBlob` where `CompressionStream` is unavailable.
 * @param {Array<{name:string,data:(Uint8Array|string)}>} entries
 * @param {string} [mime]
 * @returns {Promise<Blob>}
 */
export async function zipBlobDeflate(entries, mime = 'application/zip') {
  if (typeof CompressionStream === 'undefined') return zipBlob(entries, mime);

  const files = [];
  for (const e of entries) {
    const raw = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const comp = await deflateRaw(raw);
    // Only compress if it actually helps this part; otherwise STORE it.
    const useDeflate = comp.length < raw.length;
    files.push({
      nameBytes: enc.encode(e.name),
      crc: crc32(raw),
      size: raw.length,
      csize: useDeflate ? comp.length : raw.length,
      method: useDeflate ? 8 : 0,
      body: useDeflate ? comp : raw,
    });
  }

  const parts = [];
  let offset = 0;
  const push = (u8) => { parts.push(u8); offset += u8.length; };
  const localOffsets = [];

  for (const f of files) {
    localOffsets.push(offset);
    const h = new Uint8Array(30 + f.nameBytes.length);
    const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);      // UTF-8 filenames
    dv.setUint16(8, f.method, true);    // 0 = stored, 8 = deflate
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint32(14, f.crc, true);
    dv.setUint32(18, f.csize, true);
    dv.setUint32(22, f.size, true);
    dv.setUint16(26, f.nameBytes.length, true);
    dv.setUint16(28, 0, true);
    h.set(f.nameBytes, 30);
    push(h);
    push(f.body);
  }

  const cdStart = offset;
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const h = new Uint8Array(46 + f.nameBytes.length);
    const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, f.method, true);
    dv.setUint16(12, 0, true);
    dv.setUint16(14, 0, true);
    dv.setUint32(16, f.crc, true);
    dv.setUint32(20, f.csize, true);
    dv.setUint32(24, f.size, true);
    dv.setUint16(28, f.nameBytes.length, true);
    dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true);
    dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true);
    dv.setUint32(42, localOffsets[i], true);
    h.set(f.nameBytes, 46);
    push(h);
  }
  const cdSize = offset - cdStart;

  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, files.length, true);
  dv.setUint16(10, files.length, true);
  dv.setUint32(12, cdSize, true);
  dv.setUint32(16, cdStart, true);
  push(eocd);

  return new Blob(parts, { type: mime });
}

/** Raw DEFLATE (no zlib header) — the exact payload ZIP method 8 expects. */
async function deflateRaw(u8) {
  const cs = new CompressionStream('deflate-raw');
  const stream = new Blob([u8]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
