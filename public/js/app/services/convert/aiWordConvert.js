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
