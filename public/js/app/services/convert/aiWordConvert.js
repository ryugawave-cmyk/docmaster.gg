/**
 * AI PDF → Word (client-side, no API).
 *
 * The "AI Layout" export path. For each page:
 *   1. render → the page raster is analysed by the DocLayNet YOLOv10 model
 *      (in a Worker, on WebGPU/WASM) → regions (table/text/title/figure).
 *   2. the PDF's OWN extracted text runs are dropped into those regions by the
 *      accuracy engine (aiLayout.js) → ordered blocks (real tables + paragraphs).
 *   3. the blocks become an editable .docx (docx.js `ai` mode).
 *
 * All on-device — the model runs in the user's browser; nothing is uploaded.
 * The layout model only decides WHERE the tables/paragraphs are (the hard part);
 * the exact text + cell contents come from the PDF, so characters are never
 * guessed. Pages are processed one at a time with progress.
 */
import { buildContentModel, hasComplexScript } from './model.js';
import { modelToDocx } from './docx.js';
import { buildBlocksFromRegions } from './aiLayout.js';
import { dataURLToBytes } from '../zip.js';
import { createWorker } from '../../core/workers/pool.js';

const WORKER_URL = '/js/app/core/onnx/layout.worker.js';

export async function convertToWordAI(model, opts = {}) {
  const content = buildContentModel(model, opts.name);
  const total = content.pages.length;
  if (!total) throw new Error('This document has no pages.');
  const report = (done, msg) => { if (opts.onProgress) opts.onProgress(done, total, msg); };

  report(0, 'Starting AI layout…');
  const worker = createWorker({ url: WORKER_URL });
  const aiPages = new Array(total).fill(null);

  try {
    for (let i = 0; i < total; i += 1) {
      const pg = content.pages[i];
      report(i, `Analysing layout — page ${i + 1} of ${total}…`);
      const { regions, outputDims } = await analyzePage(worker, pg);
      // First-run diagnostics: what the layout model actually detected per page.
      // eslint-disable-next-line no-console
      console.info(`[DocMaster] AI layout — page ${i + 1}: ${regions.length} regions`,
        regions.reduce((m, r) => { m[r.type] = (m[r.type] || 0) + 1; return m; }, {}),
        outputDims ? `(model output dims ${JSON.stringify(outputDims)})` : '');
      // Sample each region's background colour from the raster so coloured bars /
      // banners (often white text on colour) are shaded in the rebuild.
      await sampleRegionColors(pg, regions);
      // Rasterise complex-script (Devanagari etc.) runs into inline image crops so
      // they render correctly instead of scrambling as editable Unicode; Latin text
      // and values stay editable. Best-effort — falls back to the raw runs.
      const runsForLayout = await cropComplexRuns(pg);
      aiPages[i] = { blocks: buildBlocksFromRegions(runsForLayout, regions) };
    }
  } finally {
    worker.terminate();
  }

  report(total, 'Building Word document…');
  // extraImages: baked-in pictures (signature/photo/QR/logo) recovered from the
  // page raster by the caller, merged into each page so aiBody places them inline
  // in reading order alongside the rebuilt text and tables.
  return modelToDocx(model, { mode: 'ai', name: opts.name, aiPages, extraImages: opts.extraImages });
}

/** Median colour (hex, no #) of a raster rectangle, or '' when it's near-white.
 *  Median per channel is robust to the text pixels (a minority of the region). */
function medianRegionHex(ctx, x, y, w, h) {
  let data;
  try { data = ctx.getImageData(x, y, w, h).data; } catch { return ''; }
  const rs = [], gs = [], bs = [];
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 2000))); // ~2k samples max
  for (let yy = 0; yy < h; yy += step) {
    for (let xx = 0; xx < w; xx += step) {
      const i = (yy * w + xx) * 4;
      if (data[i + 3] < 128) continue; // skip transparent
      rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    }
  }
  if (!rs.length) return '';
  const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  const r = med(rs), g = med(gs), b = med(bs);
  if (r > 236 && g > 236 && b > 236) return ''; // near-white → no colour band
  return [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Attach `region.bg` = the region's sampled background colour from the page
 *  raster (best-effort; leaves bg unset on any failure). */
async function sampleRegionColors(pg, regions) {
  if (!pg.bg || !regions.length || typeof OffscreenCanvas === 'undefined') return;
  let bmp;
  try {
    let blob;
    if (pg.bg.startsWith('data:')) {
      const mime = (/^data:([^;,]+)/.exec(pg.bg) || [])[1] || 'image/jpeg';
      blob = new Blob([dataURLToBytes(pg.bg)], { type: mime });
    } else {
      blob = await (await fetch(pg.bg)).blob();
    }
    bmp = await createImageBitmap(blob);
  } catch { return; }
  try {
    const cvs = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const sx = bmp.width / (pg.w || bmp.width);
    const sy = bmp.height / (pg.h || bmp.height);
    for (const reg of regions) {
      if (!reg || !reg.box || reg.type === 'figure') continue;
      const x = Math.max(0, Math.round(reg.box.x * sx));
      const y = Math.max(0, Math.round(reg.box.y * sy));
      const w = Math.min(bmp.width - x, Math.round(reg.box.w * sx));
      const h = Math.min(bmp.height - y, Math.round(reg.box.h * sy));
      if (w > 1 && h > 1) reg.bg = medianRegionHex(ctx, x, y, w, h);
    }
  } catch { /* sampling is best-effort */ } finally {
    if (bmp && bmp.close) bmp.close();
  }
}

/** Blob → data: URL (main thread). */
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

/**
 * Replace complex-script runs with CROP runs: rasterise each contiguous
 * complex-script segment (Devanagari/Bengali/Tamil… — see hasComplexScript) from
 * the page image and hand it downstream as an inline image, so the script renders
 * exactly as in the PDF instead of scrambling when re-emitted as editable Unicode
 * (detached matras, dropped conjuncts). Latin text and numeric values are left as
 * editable runs. Best-effort: no raster / no OffscreenCanvas / decode failure →
 * the runs are returned unchanged (so those runs stay editable text, scrambled or
 * not, rather than vanishing).
 * @returns {Promise<object[]>} the run list to feed the layout engine
 */
async function cropComplexRuns(pg) {
  const src = pg.runs || [];
  const isComplex = (r) => !!(r && r.text && hasComplexScript(r.text));
  if (!pg.bg || typeof OffscreenCanvas === 'undefined' || !src.some(isComplex)) return src;

  let bmp;
  try {
    let blob;
    if (pg.bg.startsWith('data:')) {
      const mime = (/^data:([^;,]+)/.exec(pg.bg) || [])[1] || 'image/jpeg';
      blob = new Blob([dataURLToBytes(pg.bg)], { type: mime });
    } else {
      blob = await (await fetch(pg.bg)).blob();
    }
    bmp = await createImageBitmap(blob);
  } catch { return src; }

  try {
    const sx = bmp.width / (pg.w || bmp.width);
    const sy = bmp.height / (pg.h || bmp.height);
    // Group complex runs into contiguous, same-baseline segments (one image each).
    const segs = [];
    for (const r of src.filter(isComplex).sort((a, b) => a.y - b.y || a.x - b.x)) {
      const fs = r.fontSize || r.h || 12;
      const last = segs[segs.length - 1];
      const sameLine = last && Math.abs(r.y - last.y) <= Math.min(last.h, r.h || 0) * 0.6;
      if (last && sameLine && (r.x - last.right) <= fs * 1.2) {
        last.runs.push(r);
        last.right = Math.max(last.right, r.x + (r.w || 0));
        last.y = Math.min(last.y, r.y);
        last.h = Math.max(last.h, r.h || 0);
      } else {
        segs.push({ runs: [r], x: r.x, y: r.y, right: r.x + (r.w || 0), h: r.h || 0 });
      }
    }

    const cvs = new OffscreenCanvas(1, 1);
    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    const cropRuns = [];
    for (const seg of segs) {
      const pad = Math.max(1, Math.round((seg.h || 12) * 0.18)); // keep matras/descenders
      const px = Math.max(0, Math.round((seg.x - pad) * sx));
      const py = Math.max(0, Math.round((seg.y - pad) * sy));
      const pw = Math.min(bmp.width - px, Math.round((seg.right - seg.x + pad * 2) * sx));
      const ph = Math.min(bmp.height - py, Math.round((seg.h + pad * 2) * sy));
      if (pw < 1 || ph < 1) continue;
      cvs.width = pw; cvs.height = ph;
      ctx.clearRect(0, 0, pw, ph);
      ctx.drawImage(bmp, px, py, pw, ph, 0, 0, pw, ph);
      let cropSrc = '';
      try { cropSrc = await blobToDataURL(await cvs.convertToBlob({ type: 'image/png' })); } catch { cropSrc = ''; }
      if (!cropSrc) continue;
      const lead = seg.runs[0];
      const w = (seg.right - seg.x) + pad * 2;
      const h = seg.h + pad * 2;
      cropRuns.push({
        text: seg.runs.map((r) => r.text).join(''),
        x: seg.x - pad, y: seg.y - pad, w, h,
        cropSrc, cropW: w, cropH: h,
        fontSize: lead.fontSize, bold: lead.bold, italic: lead.italic,
        color: lead.color, align: lead.align,
      });
    }
    if (!cropRuns.length) return src;
    return src.filter((r) => !isComplex(r)).concat(cropRuns);
  } catch {
    return src;
  } finally {
    if (bmp && bmp.close) bmp.close();
  }
}

/** Render one page's raster to an ImageBitmap, hand it to the worker, get regions.
 *  A page with no raster (blank-editor page) can't be analysed → no regions, so
 *  its text falls through aiLayout as plain paragraphs. */
async function analyzePage(worker, pg) {
  if (!pg.bg) return { regions: [], outputDims: null };
  // Rasters are data: URLs (canvas.toDataURL). `fetch(dataURL)` is blocked by the
  // page CSP (connect-src 'self'), so decode them in-process instead of over the
  // "network". Any same-origin URL still goes through fetch (CSP allows 'self').
  let blob;
  if (pg.bg.startsWith('data:')) {
    const mime = (/^data:([^;,]+)/.exec(pg.bg) || [])[1] || 'image/jpeg';
    blob = new Blob([dataURLToBytes(pg.bg)], { type: mime });
  } else {
    blob = await (await fetch(pg.bg)).blob();
  }
  const bitmap = await createImageBitmap(blob);
  const res = await worker.call('analyze', {
    bitmap, srcW: bitmap.width, srcH: bitmap.height, pageW: pg.w, pageH: pg.h, threshold: 0.3,
  }, [bitmap]);
  return { regions: (res && res.regions) || [], outputDims: res && res.outputDims };
}
