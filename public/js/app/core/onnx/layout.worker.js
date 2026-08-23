/**
 * Layout worker — runs the DocLayNet YOLOv10 model off the main thread.
 *
 * Receives a rendered page image (ImageBitmap, transferred) + page dimensions,
 * letterboxes it to 640×640, runs the model on WebGPU/WASM (ONNX Runtime Web),
 * and decodes the output into page-unit regions (table/text/title/figure). The
 * coordinate math lives in ../../services/convert/layoutModel.js (Node-tested).
 *
 * Spawned as an ES-module worker by the pool.
 */
import { serveWorker } from '../workers/protocol.js';
import { createSession, loadOrt } from './ort.js';
import { letterboxParams, decodeLayout, MODEL_INPUT } from '../../services/convert/layoutModel.js';

const MODEL_URL = '/models/layout/doclaynet-yolov10m.onnx';
let sessionPromise = null;
const getSession = () => (sessionPromise || (sessionPromise = createSession(MODEL_URL)));

serveWorker({
  async ping() { const s = await getSession(); return { ok: true, inputs: s.inputNames, outputs: s.outputNames }; },

  // payload: { bitmap:ImageBitmap, srcW, srcH, pageW, pageH, threshold }
  async analyze({ bitmap, srcW, srcH, pageW, pageH, threshold }) {
    const ort = await loadOrt();
    const session = await getSession();

    // Letterbox the page image onto a 640×640 canvas (aspect kept, top-left,
    // grey pad) and build the NCHW float32 /255 tensor the model expects.
    const params = letterboxParams(srcW, srcH, MODEL_INPUT);
    const cvs = new OffscreenCanvas(MODEL_INPUT, MODEL_INPUT);
    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, MODEL_INPUT, MODEL_INPUT);
    ctx.drawImage(bitmap, 0, 0, params.nW, params.nH);
    if (bitmap.close) bitmap.close();

    const { data } = ctx.getImageData(0, 0, MODEL_INPUT, MODEL_INPUT);
    const n = MODEL_INPUT * MODEL_INPUT;
    const input = new Float32Array(3 * n);
    for (let i = 0; i < n; i += 1) {
      input[i] = data[i * 4] / 255;             // R
      input[n + i] = data[i * 4 + 1] / 255;     // G
      input[2 * n + i] = data[i * 4 + 2] / 255; // B
    }

    const feeds = {};
    feeds[session.inputNames[0]] = new ort.Tensor('float32', input, [1, 3, MODEL_INPUT, MODEL_INPUT]);
    const outMap = await session.run(feeds);
    const out = outMap[session.outputNames[0]];

    const regions = decodeLayout(out.data, out.dims, params, srcW, srcH, pageW, pageH, {
      threshold: threshold != null ? threshold : 0.3,
    });
    // outputDims returned so the first run can be sanity-checked in the console.
    return { regions, outputDims: Array.from(out.dims) };
  },
});
