/**
 * DocLayNet YOLOv10 layout model — pure preprocessing math + output decode.
 *
 * Model: Oblix/yolov10m-doclaynet (ONNX, /models/layout/doclaynet-yolov10m.onnx).
 *   input  `images`  : [1,3,640,640] float32, RGB, /255 (no mean/std), letterboxed
 *   output `output0` : [1,300,6] = [x1,y1,x2,y2,conf,class] in 640-input coords,
 *                      NMS-free (YOLOv10 one2one head), sorted by conf desc.
 *
 * This file holds only the DOM-free math (letterbox params + decode to page-unit
 * regions), so the coordinate mapping is unit-testable in Node. The canvas draw
 * and the ORT session run live in the worker (layout.worker.js).
 *
 * 11 DocLayNet classes → the region types the accuracy engine (aiLayout.js) uses.
 */

// class id → aiLayout region type
export const CLASS_TO_TYPE = {
  0: 'text',   // Caption
  1: 'text',   // Footnote
  2: 'text',   // Formula
  3: 'text',   // List-item
  4: 'text',   // Page-footer
  5: 'text',   // Page-header
  6: 'figure', // Picture  (no editable text; handled as image)
  7: 'title',  // Section-header
  8: 'table',  // Table
  9: 'text',   // Text
  10: 'title', // Title
};
export const CLASS_NAMES = ['Caption', 'Footnote', 'Formula', 'List-item', 'Page-footer',
  'Page-header', 'Picture', 'Section-header', 'Table', 'Text', 'Title'];

export const MODEL_INPUT = 640;

/** Letterbox parameters to fit srcW×srcH into a size×size square (aspect kept,
 *  image at top-left, padded right/bottom). */
export function letterboxParams(srcW, srcH, size = MODEL_INPUT) {
  const scale = size / Math.max(srcW, srcH);
  return { scale, size, nW: Math.round(srcW * scale), nH: Math.round(srcH * scale) };
}

/**
 * Decode YOLOv10 `output0` into page-unit regions.
 * @param {Float32Array|number[]} output flattened [1,N,6]
 * @param {number[]} dims output dims, e.g. [1,300,6]
 * @param {{scale:number}} params letterbox params used at preprocess time
 * @param {number} srcW rendered page-image width (px)  @param {number} srcH
 * @param {number} pageW page width in page units (run coords)  @param {number} pageH
 * @param {{threshold?:number}} [opts]
 * @returns {Array<{type:string, box:{x,y,w,h}, score:number, cls:number}>}
 */
export function decodeLayout(output, dims, params, srcW, srcH, pageW, pageH, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 0.3;
  const N = dims[1], stride = dims[2] || 6;
  const sx = pageW / srcW, sy = pageH / srcH;
  const out = [];
  for (let i = 0; i < N; i += 1) {
    const o = i * stride;
    const conf = output[o + 4];
    if (!(conf >= threshold)) continue;
    const cls = Math.round(output[o + 5]);
    // 640-space → source px (÷scale) → page units (×page/src)
    const x1 = (output[o] / params.scale) * sx;
    const y1 = (output[o + 1] / params.scale) * sy;
    const x2 = (output[o + 2] / params.scale) * sx;
    const y2 = (output[o + 3] / params.scale) * sy;
    const x = Math.min(x1, x2), y = Math.min(y1, y2);
    const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    if (w < 1 || h < 1) continue;
    out.push({
      type: CLASS_TO_TYPE[cls] || 'text',
      box: { x: Math.max(0, x), y: Math.max(0, y), w, h },
      score: conf, cls,
    });
  }
  // Higher score first so overlap resolution / containment prefers confident regions.
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Forward map a page-unit box into 640-input coords — used only by tests to
 *  prove decode is the exact inverse of preprocessing. */
export function pageBoxTo640(box, params, srcW, srcH, pageW, pageH) {
  const sx = srcW / pageW, sy = srcH / pageH;
  return {
    x1: box.x * sx * params.scale,
    y1: box.y * sy * params.scale,
    x2: (box.x + box.w) * sx * params.scale,
    y2: (box.y + box.h) * sy * params.scale,
  };
}
