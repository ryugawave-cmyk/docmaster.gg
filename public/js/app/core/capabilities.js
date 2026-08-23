/**
 * Runtime capability detection — the foundation the compute layer builds on.
 *
 * Every performance decision downstream keys off this: WebGPU vs WASM backend,
 * how many WASM threads ONNX Runtime Web may use (which needs cross-origin
 * isolation → SharedArrayBuffer), whether we can spill to OPFS, etc. Nothing here
 * throws or blocks the app: a missing capability just means a slower path.
 *
 * Cross-origin isolation (`self.crossOriginIsolated`) is enabled by the server
 * sending COOP:same-origin + COEP:credentialless (see src/app.js). Without it,
 * SharedArrayBuffer is unavailable and multi-threaded WASM falls back to a single
 * thread — still correct, just slower.
 */

// A tiny WASM module that uses a SIMD (v128) opcode; it only *validates* where
// SIMD is supported, so this is a reliable feature probe.
const SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62, 0x0b,
]);

function wasmSupported() {
  return typeof WebAssembly === 'object' && typeof WebAssembly.validate === 'function';
}

function wasmSimdSupported() {
  try { return wasmSupported() && WebAssembly.validate(SIMD_PROBE); } catch { return false; }
}

async function webgpuInfo() {
  if (typeof navigator === 'undefined' || !navigator.gpu) return { supported: false };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { supported: false, reason: 'no-adapter' };
    // adapter.info is not universally available; guard it.
    const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
    return {
      supported: true,
      vendor: info?.vendor || '',
      architecture: info?.architecture || '',
    };
  } catch (e) {
    return { supported: false, reason: String(e && e.message || e) };
  }
}

let cached = null;

/**
 * Detect capabilities once and cache. Returns a snapshot object.
 * @returns {Promise<object>}
 */
export async function detectCapabilities() {
  if (cached) return cached;

  const isolated = typeof self !== 'undefined' && self.crossOriginIsolated === true;
  const sab = typeof SharedArrayBuffer !== 'undefined';
  const wasm = wasmSupported();
  const simd = wasmSimdSupported();
  // Multi-threaded WASM needs SharedArrayBuffer, which needs cross-origin isolation.
  const wasmThreads = wasm && sab && isolated;
  const gpu = await webgpuInfo();

  const hardwareConcurrency = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;

  cached = {
    crossOriginIsolated: isolated,
    sharedArrayBuffer: sab,
    wasm,
    wasmSimd: simd,
    wasmThreads,
    // Threads we may actually use: all cores when isolated, else 1.
    maxThreads: wasmThreads ? hardwareConcurrency : 1,
    hardwareConcurrency,
    webgpu: gpu.supported,
    webgpuInfo: gpu,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    workers: typeof Worker !== 'undefined',
    // Origin Private File System — used to spill large documents out of the heap.
    opfs: typeof navigator !== 'undefined' && !!(navigator.storage && navigator.storage.getDirectory),
    // Preferred compute backend for image/compositing kernels.
    computeBackend: gpu.supported ? 'webgpu' : (simd ? 'wasm-simd' : (wasm ? 'wasm' : 'canvas2d')),
  };

  if (typeof window !== 'undefined') {
    window.__docmasterCaps = cached;
    window.dispatchEvent(new CustomEvent('docmaster:capabilities', { detail: cached }));
  }
  return cached;
}

/** Log a concise capability report to the console (Phase-1 smoke test). */
export async function logCapabilities() {
  const c = await detectCapabilities();
  const ok = (v) => (v ? '✓' : '✗');
  // eslint-disable-next-line no-console
  console.info(
    `[DocMaster] capabilities — backend:${c.computeBackend} · ` +
    `WebGPU ${ok(c.webgpu)} · WASM ${ok(c.wasm)}(simd ${ok(c.wasmSimd)}) · ` +
    `threads ${ok(c.wasmThreads)}(${c.maxThreads}/${c.hardwareConcurrency}) · ` +
    `isolated ${ok(c.crossOriginIsolated)} · OPFS ${ok(c.opfs)}`
  );
  if (!c.crossOriginIsolated) {
    // eslint-disable-next-line no-console
    console.warn(
      '[DocMaster] Not cross-origin isolated — multi-threaded WASM is disabled ' +
      '(single-thread fallback). Ensure the server sends COOP:same-origin + ' +
      'COEP:credentialless and no cross-origin subresources are loaded.'
    );
  }
  return c;
}
