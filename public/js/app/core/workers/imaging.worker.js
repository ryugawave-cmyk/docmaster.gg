/**
 * Imaging worker — runs image kernels off the main thread on the compute
 * backend (WebGPU or CPU). This is the reference worker that proves the Phase-2
 * wiring end to end: main thread → pool → protocol → backend kernel → zero-copy
 * transfer back. More kernels (resize, colorMatrix, convolve, threshold) land
 * here in later phases; the transport and lifecycle are already in place.
 *
 * Spawned as an ES module worker: new Worker(url, { type: 'module' }).
 */
import { serveWorker, withTransfer } from './protocol.js';
import { createBackend } from '../gpu/backend.js';

let backendPromise = null;
const backend = () => (backendPromise || (backendPromise = createBackend()));

serveWorker({
  async ping() {
    const b = await backend();
    return { ok: true, backend: b.name };
  },

  // payload: { data: Uint8ClampedArray(RGBA), width, height }
  async grayscale({ data, width, height }) {
    const b = await backend();
    const out = await b.grayscale({ data, width, height });
    return withTransfer(out, [out.data.buffer]);
  },
});
