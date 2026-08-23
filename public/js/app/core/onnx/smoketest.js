/**
 * AI-engine smoke test — Step 1 of the in-browser PDF→Word AI.
 *
 * Loads ONNX Runtime Web (the vendored WebGPU/WASM runtime) and runs a tiny,
 * known-good model (`mul_1.onnx`, from ORT's own test suite) to prove that
 * on-device inference works in THIS browser before we invest in the real layout
 * model. It reports which execution provider actually ran (webgpu or wasm) and
 * the output tensor.
 *
 * Triggered manually via `window.__dmTestAI()` (see app/index.js) so the ~27 MB
 * runtime is only downloaded when you ask for it, never on a normal page load.
 */
import { loadOrt, createSession, executionProviders } from './ort.js';

export async function testAI() {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  console.info('[DocMaster] AI engine: loading ONNX Runtime Web (~27 MB first time, then cached)…');

  const ort = await loadOrt();
  const requestedEps = await executionProviders();
  const session = await createSession('/models/test/mul_1.onnx');

  // mul_1.onnx multiplies two [3,2] float tensors → feed each declared input.
  const feeds = {};
  for (const name of session.inputNames) {
    feeds[name] = new ort.Tensor('float32', Float32Array.from([1, 2, 3, 4, 5, 6]), [3, 2]);
  }

  const out = await session.run(feeds);
  const y = out[session.outputNames[0]];
  const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);

  // Best-effort: which EP actually served this run (WebGPU present ⇒ webgpu).
  const backend = ort.env && ort.env.webgpu && ort.env.webgpu.adapter ? 'webgpu(likely)' : 'wasm/unknown';

  const result = {
    ok: true,
    requestedEps,
    inputs: session.inputNames,
    output: Array.from(y.data),
    dims: y.dims,
    backendHint: backend,
    ms,
  };
  console.info('[DocMaster] ✅ AI engine WORKS —', JSON.stringify(result));
  return result;
}
