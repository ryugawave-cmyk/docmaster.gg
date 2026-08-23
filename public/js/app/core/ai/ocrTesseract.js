/**
 * On-device OCR engine for "Make editable" — a SELF-HOSTED, same-origin
 * Tesseract.js provider plugged into the OCR seam (core/ai/ocr.js).
 *
 * WHY SELF-HOSTED (not a CDN): the app runs under a strict CSP and cross-origin
 * isolation (see src/app.js) — `script-src 'self' 'wasm-unsafe-eval'`,
 * `connect-src 'self'`, `worker-src 'self' blob:`. A CDN import/fetch would be
 * blocked. Serving the engine, its WASM core, the worker and the language data
 * from the SAME origin (like /vendor/pdfjs) satisfies that policy with zero
 * exceptions and keeps everything on-device — no cloud, no account.
 *
 * LAZY: `registerTesseractOcr()` only installs a loader on the seam. Nothing is
 * imported or downloaded until the user first recognises a region, matching the
 * "download the model on first use, then cache" pattern used elsewhere. If the
 * vendored files aren't present yet, the first-use import rejects and the seam
 * surfaces a friendly toast instead of crashing.
 *
 * TO ENABLE (one-time vendoring step): drop a Tesseract.js v5 build under
 * `public/vendor/tesseract/` — the ESM entry, `worker.min.js`,
 * `tesseract-core.wasm.js` (+ `.wasm`), and the `<lang>.traineddata.gz` files you
 * support (e.g. `eng`, `hin`, `ara`, `tha`). Override any path via the options.
 */
import { setOcrLoader, OcrUnavailableError } from './ocr.js';

const DEFAULT_BASE = '/vendor/tesseract';

// Map the editor's script hint → a Tesseract language set. `+eng` rides along so
// MIXED lines (Hindi/English, ubiquitous on Indian government forms) resolve both
// scripts in one pass. Add rows as you vendor more `<lang>.traineddata` files.
const LANG_SETS = {
  hin: 'hin+eng', ben: 'ben+eng', tam: 'tam+eng', tel: 'tel+eng',
  mar: 'mar+eng', guj: 'guj+eng', pan: 'pan+eng', kan: 'kan+eng',
  mal: 'mal+eng', ori: 'ori+eng', ara: 'ara+eng', tha: 'tha+eng',
};
function resolveLangs(hint) { return (hint && LANG_SETS[hint]) || 'eng'; }

let installed = false;

/**
 * Register the vendored Tesseract engine as the app's OCR provider (idempotent).
 * @param {{ base?:string, enginePath?:string, workerPath?:string,
 *   corePath?:string, langPath?:string, logger?:(m:any)=>void }} [opts]
 */
export function registerTesseractOcr(opts = {}) {
  if (installed) return;
  installed = true;
  const base = (opts.base || DEFAULT_BASE).replace(/\/+$/, '');
  const cfg = {
    enginePath: opts.enginePath || `${base}/tesseract.esm.min.js`,
    workerPath: opts.workerPath || `${base}/worker.min.js`,
    corePath: opts.corePath || `${base}/tesseract-core.wasm.js`,
    langPath: opts.langPath || base, // where <lang>.traineddata(.gz) are served
    logger: opts.logger || null,
  };
  setOcrLoader(() => createProvider(cfg));
}

async function createProvider(cfg) {
  // Import the vendored ESM build ONLY now (first recognise). If it isn't
  // vendored yet, surface a CLEAR "not installed" message (the seam/editor shows
  // it as a friendly toast) rather than a generic recognition failure.
  let mod;
  try {
    mod = await import(/* webpackIgnore: true */ cfg.enginePath);
  } catch {
    throw new OcrUnavailableError('Text recognition isn’t installed yet — add a Tesseract build under /vendor/tesseract to enable “Make editable”.');
  }
  const T = (mod && mod.default) || mod;
  const createWorker = T.createWorker || mod.createWorker;
  if (typeof createWorker !== 'function') {
    throw new Error('Vendored Tesseract build is missing createWorker().');
  }

  // One cached worker per language set — reused across regions so the model is
  // loaded once, not per crop.
  const workers = new Map(); // langKey → Promise<Worker>
  const getWorker = (langs) => {
    if (!workers.has(langs)) {
      workers.set(langs, createWorker(langs, 1, {
        workerPath: cfg.workerPath,
        corePath: cfg.corePath,
        langPath: cfg.langPath,
        workerBlobURL: true,            // blob: worker — allowed by worker-src
        logger: cfg.logger || undefined,
      }));
    }
    return workers.get(langs);
  };

  /** @type {import('./ocr.js').OcrProvider} */
  return async ({ dataURL, lang }) => {
    const worker = await getWorker(resolveLangs(lang));
    const { data } = await worker.recognize(dataURL);
    const lines = Array.isArray(data && data.lines)
      ? data.lines
          .map((l) => ({
            text: String((l && l.text) || '').replace(/\s+$/, ''),
            confidence: typeof (l && l.confidence) === 'number' ? l.confidence / 100 : undefined,
          }))
          .filter((l) => l.text.length)
      : undefined;
    return {
      text: String((data && data.text) || ''),
      lines: lines && lines.length ? lines : undefined,
      confidence: typeof (data && data.confidence) === 'number' ? data.confidence / 100 : undefined,
    };
  };
}
