/**
 * Regression test — PDF → DOC positioned "text shrinks when I click it".
 *
 * The dormant transfer model keeps the original glyphs baked in the page raster and
 * hides each editable box until it is focused; on reveal the box masks the baked
 * glyph and re-draws the line in a substitute font (Arial/Inter). The PDF's embedded
 * font usually inks LARGER than the substitute — sometimes wider, but often just
 * TALLER at the same width — so a revealed line used to look smaller than the page
 * image it replaced.
 *
 * `fitBoxFontToInk` (positionedImport.js) fixes this by matching inked HEIGHT: it
 * measures the baked line's real pixel height in the raster and scales the box font
 * so the substitute inks the same height. This guards:
 *   1. measureInkHeight finds a text band's height and ignores the background,
 *   2. a DENSE (full-width) bold band is still measured in full (no upper gate) —
 *      this is the heading-shrink regression: an upper gate dropped its interior
 *      rows and under-measured it,
 *   3. a thin rule above the text is ignored (tallest contiguous run wins),
 *   4. ink filling the whole region (a solid cell) is rejected (null),
 *   5. a blank region is rejected (null),
 *   6. a substitute that inks SHORTER than the baked glyph is enlarged to match,
 *   7. ENLARGE-ONLY: a taller substitute (ratio < 1) is NOT shrunk (stays as-is),
 *   8. the scale is clamped at FIT_HI (a mis-detected band can't balloon a line),
 *   9. a near-match (< FIT_EPS) is left unchanged (no pointless reflow),
 *  10. no raster / no canvas (e.g. Node) → every size untouched (fail-safe).
 *
 * Drives the REAL shipping functions: measureInkHeight is pure (synthetic pixels);
 * fitBoxFontToInk runs against a stub canvas/Image whose pixels and text metrics are
 * knobs. Run: `node scripts/verify-posbox-fit.mjs`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Copy the app tree so positionedImport's relative imports resolve; mark it ESM.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docmaster-fit-'));
fs.cpSync(path.join(ROOT, 'public/js/app'), path.join(tmp, 'app'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

// ---- browser stubs (installed before import; the module reads them lazily) -------
let PIXELS = null;   // Uint8ClampedArray for the "raster" the fitter decodes
let RW = 0, RH = 0;  // raster dimensions
let DOM_H = 0;       // actualBoundingBox height the stub measureText reports
globalThis.Image = class {
  set src(_v) { this.naturalWidth = RW; this.naturalHeight = RH; queueMicrotask(() => this.onload && this.onload()); }
};
globalThis.document = {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({
      font: '',
      measureText: () => ({ actualBoundingBoxAscent: DOM_H, actualBoundingBoxDescent: 0 }),
      drawImage: () => {},
      getImageData: () => ({ data: PIXELS }),
    }),
  }),
};

const { measureInkHeight, fitBoxFontToInk, FIT_HI, FIT_EPS } =
  await import(pathToFileURL(path.join(tmp, 'app/services/convert/positionedImport.js')).href);

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok  ${name}`); return; }
  console.error(`FAIL  ${name}`);
  failures += 1;
}

// White raster W×H with black band(s). Each band = [ry0, ry1) inked at `cov` fraction
// of the width. Accepts extra bands so a rule + a text line can share a region.
function raster(W, H, bands) {
  const d = new Uint8ClampedArray(W * H * 4); d.fill(255);
  for (const [ry0, ry1, cov] of bands) {
    const xe = 2 + Math.round((W - 4) * cov);
    for (let y = ry0; y < ry1; y += 1) for (let x = 2; x < xe; x += 1) {
      const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = 0; d[i + 3] = 255;
    }
  }
  return d;
}
const WHITE = 255; // bg luminance passed to measureInkHeight (the box's sampled fill)
const F = { x: 0, y: 0, w: 100, h: 40 };

/* 1. A 24px-tall text-like band (50% width) on a 100×40 raster (scale 1) → 24. */
{
  const d = raster(100, 40, [[8, 32, 0.5]]); // rows 8..31 = 24 rows
  check('measureInkHeight reports the band height', measureInkHeight(d, 100, 40, F, 1, WHITE) === 24);
}

/* 2. DENSE full-width bold band (rows 8..32, 100% width) is still measured in full —
   the heading-shrink regression: an upper fraction gate dropped these rows. */
{
  const d = raster(100, 40, [[8, 32, 1.0]]);
  check('dense full-width band measured in full (no upper gate)', measureInkHeight(d, 100, 40, F, 1, WHITE) === 24);
}

/* 3. A thin rule (rows 2..4) above a taller text band (rows 12..30) → text wins. */
{
  const d = raster(100, 40, [[2, 4, 1.0], [12, 30, 0.5]]); // rule 2px, text 18px
  check('thin rule ignored, tallest run (text) wins', measureInkHeight(d, 100, 40, F, 1, WHITE) === 18);
}

/* 4. Ink filling the WHOLE region (a solid cell) → null. */
{
  const d = raster(100, 40, [[0, 40, 1.0]]);
  check('full-region solid fill rejected', measureInkHeight(d, 100, 40, F, 1, WHITE) === null);
}

/* 5. Blank region → null. */
{
  const d = raster(100, 40, []);
  check('blank region rejected', measureInkHeight(d, 100, 40, F, 1, WHITE) === null);
}

// A one-run box; frame maps 1:1 to the raster (scale 1).
function box(overrides = {}) {
  return {
    page: 0,
    fill: 'ffffff', // sampled bg → white; measureInkHeight uses it as the bg reference
    runs: [{ text: 'RAILWAY RECRUITMENT BOARD', marks: { fontSize: 20, fontFamily: 'Arial', bold: true } }],
    frame: { x: 0, y: 0, w: 100, h: 40 },
    ...overrides,
  };
}
const page = () => ({ bg: 'data:stub', width: RW, height: RH });

/* 6. Substitute inks SHORTER than baked → enlarge to match (baked 24, dom 20 → 1.2×). */
{
  RW = 100; RH = 40; PIXELS = raster(RW, RH, [[8, 32, 0.5]]); DOM_H = 20; // baked band = 24
  const b = box();
  await fitBoxFontToInk([page()], [b]);
  check('shorter substitute enlarged to the baked height', b.runs[0].marks.fontSize === Math.round(20 * (24 / 20)));
}

/* 7. ENLARGE-ONLY: substitute inks TALLER than baked (ratio < 1) → NOT shrunk. This
   is the reported bug — dense headings were being scaled below 1 and shrank. */
{
  RW = 100; RH = 40; PIXELS = raster(RW, RH, [[12, 28, 0.5]]); DOM_H = 20; // baked band = 16 → 0.8×
  const b = box();
  await fitBoxFontToInk([page()], [b]);
  check('taller substitute is NOT shrunk (enlarge-only)', b.runs[0].marks.fontSize === 20);
}

/* 8. Huge baked band → scale clamped at FIT_HI. */
{
  RW = 100; RH = 80; PIXELS = raster(RW, RH, [[4, 76, 0.5]]); DOM_H = 20; // baked band = 72 → 3.6×
  const b = box({ frame: { x: 0, y: 0, w: 100, h: 80 } });
  await fitBoxFontToInk([page()], [b]);
  check('over-tall band is clamped at FIT_HI', b.runs[0].marks.fontSize === Math.round(20 * FIT_HI));
}

/* 9. Baked height ≈ substitute height (within FIT_EPS) → unchanged. */
{
  RW = 100; RH = 40; PIXELS = raster(RW, RH, [[8, 28, 0.5]]); DOM_H = 20; // baked band = 20
  check('sanity: 20 vs 20 is within FIT_EPS', Math.abs(20 / 20 - 1) < FIT_EPS);
  const b = box();
  await fitBoxFontToInk([page()], [b]);
  check('near-match left unchanged', b.runs[0].marks.fontSize === 20);
}

/* 10. Fail-safe: no page raster → no throw, sizes untouched. */
{
  const b = box();
  let threw = false;
  try { await fitBoxFontToInk([{ bg: null, width: 100, height: 40 }], [b]); } catch { threw = true; }
  check('missing raster does not throw', !threw);
  check('missing raster leaves sizes untouched', b.runs[0].marks.fontSize === 20);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll posbox ink-fit checks passed.');
