/**
 * ONNX Runtime Web bootstrap.
 *
 * Centralises ORT configuration so every model (OCR detect/recognise,
 * background-removal, table-structure) shares one tuned runtime:
 *   • execution providers  : ['webgpu','wasm']  → WebGPU primary, WASM fallback
 *   • WASM threads          : all cores when cross-origin isolated, else 1
 *   • SIMD                  : on when supported
 *
 * The ORT distribution itself (`ort.*.min.js` + `*.wasm`) is a vendored static
 * asset served from /vendor/ort and /wasm/ort — added in Phase 6 (OCR), which is
 * the first consumer. This module is the config surface everything imports; it
 * lazy-loads ORT on first use, so nothing is fetched until a model is needed.
 */
import { detectCapabilities } from '../capabilities.js';

let ortPromise = null;

/** Lazily load + configure ORT once. Returns the `ort` namespace. */
export async function loadOrt() {
  if (ortPromise) return ortPromise;
  ortPromise = (async () => {
    const caps = await detectCapabilities();
    // The vendored WebGPU (JSEP) build carries BOTH the WebGPU and the WASM
    // execution providers, so one entry covers every path (see docs/ARCHITECTURE).
    const mod = await import(/* @vite-ignore */ '/vendor/ort/ort.webgpu.mjs');
    const ort = mod.InferenceSession ? mod : (mod.default || mod);

    ort.env.wasm.wasmPaths = '/wasm/ort/';
    ort.env.wasm.simd = !!caps.wasmSimd;
    // Conservative during bring-up: single-thread, in-line (no proxy worker), so
    // the first inference has the fewest moving parts. We scale up to
    // caps.maxThreads + proxy once the engine is confirmed working in-browser.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    return ort;
  })();
  return ortPromise;
}

/** Execution-provider list for the current runtime (WebGPU first when present). */
export async function executionProviders() {
  const caps = await detectCapabilities();
  return caps.webgpu ? ['webgpu', 'wasm'] : ['wasm'];
}

/**
 * Create an inference session for a model URL with the tuned EP list.
 * @param {string} url  same-origin .onnx URL (served from /models)
 * @param {object} [sessionOptions] extra InferenceSession options
 */
export async function createSession(url, sessionOptions = {}) {
  const ort = await loadOrt();
  return ort.InferenceSession.create(url, {
    executionProviders: await executionProviders(),
    graphOptimizationLevel: 'all',
    ...sessionOptions,
  });
}
