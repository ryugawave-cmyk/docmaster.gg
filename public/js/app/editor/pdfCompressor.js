/**
 * Adaptive PDF compressor — reach a target file size with the least quality loss.
 *
 * IMPORTANT architectural note. In this editor a PDF is rasterised to one image
 * per page at import time (see `pdfImport.js`); the original fonts, vector text
 * streams and PDF objects are not retained past that point. So a compressor
 * running here has no PDF structure to optimise losslessly (no font subsetting,
 * no object dedup, no real-text preservation) — its only levers are the render
 * RESOLUTION and the per-page image CODEC/quality. Editor overlay objects (text,
 * shapes, stamps, signatures) are the exception: they are re-drawn as crisp
 * vectors onto the page canvas at the chosen resolution rather than resampled
 * from a baked image, so keeping the resolution up keeps them sharp.
 *
 * The strategy, mirroring the product spec as far as the raster model allows:
 *   1. Treat the user's value as a MAXIMUM. If the full-quality export already
 *      fits, return it unchanged (never inflate a small file to match a target).
 *   2. Otherwise search a discrete quality ladder (resolution + JPEG quality,
 *      highest→lowest) and pick the HIGHEST-quality rung whose output is ≤ target.
 *      Because output size is monotonic in the ladder, a binary search finds it
 *      in ~log₂(n) renders instead of trying every rung.
 *   3. Per page we still keep the smaller of {lossless deflate, JPEG} (see
 *      `pdfExport.encodePage`), so text/line-art pages stay pixel-perfect and
 *      already-clean pages aren't needlessly re-JPEG'd.
 *   4. Never go below the readability floor (the lowest rung). If even the floor
 *      exceeds the target, hand back the floor result and flag it — we don't
 *      shred text to hit an exact byte count.
 *   5. Verify the chosen output page-by-page against the full-quality reference
 *      (page count, dimensions, and blank/all-black/lost-content detection).
 */
import { exportEditorToPdf } from './pdfExport.js';

// Quality ladder, HIGHEST quality first. `scale` is the canvas oversample
// (≥1 keeps text at/above native so it never blurs); `quality` is the JPEG
// fallback used only when lossless deflate isn't smaller. The last rung is the
// readability floor: below this, small text starts to break down.
const LADDER = [
  { scale: 2.0, quality: 0.95 },
  { scale: 2.0, quality: 0.86 },
  { scale: 1.8, quality: 0.78 },
  { scale: 1.6, quality: 0.70 },
  { scale: 1.5, quality: 0.62 },
  { scale: 1.4, quality: 0.55 },
];

/**
 * @param {object} model  editor export model ({PW,PH,pages:[{bg,w,h,objects}]})
 * @param {number} target maximum output size in bytes
 * @param {(msg:string)=>void} [onStep] progress callback
 * @returns {Promise<{blob:Blob, met:boolean, unchanged:boolean, warn:string|null,
 *   verify:{ok:boolean, issues:string[]}, rung:number}>}
 */
export async function compressToTarget(model, target, onStep = () => {}) {
  const cache = new Map(); // rung index → { blob, sigs }

  const renderRung = async (i) => {
    if (cache.has(i)) return cache.get(i);
    const sigs = [];
    const { scale, quality } = LADDER[i];
    const blob = await exportEditorToPdf(model, {
      scale, quality,
      onPage: (info) => { sigs[info.index] = info; },
    });
    const res = { blob, sigs };
    cache.set(i, res);
    return res;
  };

  onStep('Analysing document…');
  const best = await renderRung(0);              // full-quality reference
  const refSigs = best.sigs;

  // (1) Target ≥ full-quality size → return the original UNCHANGED.
  if (best.blob.size <= target) {
    return {
      blob: best.blob, met: true, unchanged: true, rung: 0,
      warn: null, verify: verifyPages(refSigs, best.sigs),
    };
  }

  // (4) Even the readability floor doesn't fit → return the floor, best effort.
  const floorIdx = LADDER.length - 1;
  onStep('Testing maximum compression…');
  const floor = await renderRung(floorIdx);
  if (floor.blob.size > target) {
    return {
      blob: floor.blob, met: false, unchanged: false, rung: floorIdx,
      warn: warnMessage(target),
      verify: verifyPages(refSigs, floor.sigs),
    };
  }

  // (2) Binary-search the ladder for the smallest rung index (= highest quality)
  // whose output still fits. Size is monotonically non-increasing in the index.
  let lo = 1, hi = floorIdx, fitIdx = floorIdx;
  let step = 0;
  const totalSteps = Math.ceil(Math.log2(floorIdx)) + 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    step += 1;
    onStep(`Optimising quality… (${Math.min(step, totalSteps)}/${totalSteps})`);
    const r = await renderRung(mid);
    if (r.blob.size <= target) { fitIdx = mid; hi = mid - 1; } // fits → try higher quality
    else { lo = mid + 1; }                                     // too big → lower quality
  }

  const chosen = cache.get(fitIdx);
  // Warn if we landed on (or near) the floor — quality is genuinely constrained.
  const warn = fitIdx >= floorIdx - 1 ? warnMessage(target) : null;
  return {
    blob: chosen.blob, met: true, unchanged: false, rung: fitIdx,
    warn, verify: verifyPages(refSigs, chosen.sigs),
  };
}

function warnMessage(target) {
  return `Reaching ${fmt(target)} may significantly reduce document quality. `
    + 'For sharper text and images, try a larger target size.';
}

/**
 * Compare the compressed render against the full-quality reference, page by page.
 * Checks: same page count, unchanged dimensions, and that no page that had
 * content came out blank / all-black / mostly-lost. Fingerprints are the cheap
 * 32×32 signatures produced during rendering (null when a canvas was tainted, in
 * which case that page's visual checks are skipped — structure is still checked).
 */
function verifyPages(ref, out) {
  const issues = [];
  const rp = ref.filter(Boolean);
  const op = out.filter(Boolean);
  if (rp.length !== op.length) {
    issues.push(`page count changed (${rp.length} → ${op.length})`);
  }
  const n = Math.min(rp.length, op.length);
  for (let i = 0; i < n; i += 1) {
    const r = rp[i], o = op[i];
    if (Math.abs(r.pw - o.pw) > 0.5 || Math.abs(r.ph - o.ph) > 0.5) {
      issues.push(`page ${i + 1} dimensions changed`);
    }
    const rs = r.sig, os = o.sig;
    if (!rs || !os) continue; // tainted canvas → skip visual comparison
    // A page that clearly had content must not vanish to near-blank.
    if (rs.ink > 0.03 && os.ink < rs.ink * 0.4) {
      issues.push(`page ${i + 1} lost most of its content`);
    }
    // Guard against a page collapsing to a solid black/white block.
    if (os.max - os.min < 6 && rs.max - rs.min > 40) {
      issues.push(`page ${i + 1} rendered as a flat block`);
    }
  }
  return { ok: issues.length === 0, issues };
}

function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
