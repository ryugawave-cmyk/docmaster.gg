/**
 * On-device OCR seam — the AI layer that sits ON TOP of the Exact Layout base.
 *
 * Exact Layout reproduces a page 1:1 with the original text baked into the page
 * raster. For most scripts that baked text is also lifted into editable overlay
 * boxes, but COMPLEX scripts (Devanagari, Arabic, Thai, …) are deliberately left
 * baked because the PDF stores them glyph-by-glyph in scrambled order — see
 * services/convert/model.js `hasComplexScript`. This module is the bridge that
 * turns such a baked region back into EDITABLE text on demand:
 *
 *     editor crops the region's pixels ─▶ recognizeRegion() ─▶ { text }
 *     editor drops an editable, masked text box in its place
 *
 * Why OCR instead of re-reading the PDF's text layer: OCR reads the RENDERED
 * pixels in correct visual order, so for complex scripts it is the *only*
 * reliable source of editable, correctly-ordered text — exactly the text the
 * PDF's own layer scrambles.
 *
 * THE ENGINE IS PLUGGABLE AND NOT SHIPPED HERE. A host wires a real recogniser
 * once via `setOcrProvider` (or a lazy `setOcrLoader`) — e.g. Tesseract-WASM, or
 * an ONNX detection+recognition model driven through core/onnx + a Worker (the
 * same "download the model on first use, then cache" pattern as AI Layout).
 * Until one is registered, `isOcrAvailable()` is false and `recognizeRegion`
 * throws {@link OcrUnavailableError}, which the editor surfaces as a friendly
 * toast rather than crashing. Keeping the engine behind this seam means the whole
 * feature — cropping, masking, placing the editable box, undo — is built and
 * testable today, and the model is a genuine drop-in later.
 */

/** Thrown by recognizeRegion when no OCR engine has been registered yet. */
export class OcrUnavailableError extends Error {
  constructor(message) {
    super(message || 'On-device text recognition isn’t installed yet.');
    this.name = 'OcrUnavailableError';
  }
}

/**
 * @typedef {{ text:string, confidence?:number }} OcrLine
 * @typedef {{ text:string, lines?:OcrLine[], confidence?:number }} OcrResult
 * @typedef {(input:{ dataURL:string, width:number, height:number, lang?:string,
 *   signal?:AbortSignal }) => Promise<OcrResult>} OcrProvider
 *   Recognises the text in ONE cropped region image. `lang` is a hint (e.g.
 *   'hin', 'ara', 'tha') the editor derives from the detected script; a provider
 *   may ignore it and auto-detect.
 */

let provider = null; // OcrProvider | null — a ready recogniser
let loader = null;   // (() => Promise<OcrProvider>) | null — lazy first-use loader

/** Register the real recogniser directly (already initialised). Pass null to clear. */
export function setOcrProvider(fn) { provider = typeof fn === 'function' ? fn : null; }

/**
 * Register a LAZY loader resolved on first recognise — the place to download +
 * warm the model (Worker, WASM, ONNX weights). Runs at most once; its result
 * becomes the provider. Pass null to clear.
 */
export function setOcrLoader(fn) { loader = typeof fn === 'function' ? fn : null; }

/** True when a provider is registered OR one can be lazily loaded. Lets the UI
 *  offer/greys-out "Make editable" without triggering a download. */
export function isOcrAvailable() { return !!provider || !!loader; }

async function ensureProvider() {
  if (provider) return provider;
  if (loader) {
    const p = await loader();
    loader = null;                 // one-shot: never re-run the loader
    if (typeof p === 'function') { provider = p; return provider; }
  }
  throw new OcrUnavailableError();
}

/**
 * Recognise the text in one cropped region image.
 * @param {{ dataURL:string, width:number, height:number, lang?:string,
 *   signal?:AbortSignal }} input
 * @returns {Promise<OcrResult>}  always normalised: `text` is a string; `lines`
 *   is present only when the engine returned per-line results.
 * @throws {OcrUnavailableError} when no engine is registered.
 */
export async function recognizeRegion(input) {
  if (!input || typeof input.dataURL !== 'string') {
    throw new Error('recognizeRegion: { dataURL } is required');
  }
  const recognise = await ensureProvider();
  const res = await recognise(input);
  // Normalise so a sloppy provider can never crash callers.
  const lines = Array.isArray(res && res.lines)
    ? res.lines.filter((l) => l && typeof l.text === 'string')
    : null;
  const text = typeof (res && res.text) === 'string'
    ? res.text
    : (lines ? lines.map((l) => l.text).join('\n') : '');
  const out = { text };
  if (lines && lines.length) out.lines = lines;
  if (res && typeof res.confidence === 'number') out.confidence = res.confidence;
  return out;
}
