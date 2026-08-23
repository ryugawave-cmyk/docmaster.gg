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
import { buildContentModel } from './model.js';
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
      aiPages[i] = { blocks: buildBlocksFromRegions(pg.runs, regions) };
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
