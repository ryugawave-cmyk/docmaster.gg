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
 *   2. ink that fills the whole box (a border/rule) is rejected (null),
 *   3. a blank region is rejected (null),
 *   4. a substitute that inks SHORTER than the baked glyph is enlarged to match,
 *   5. the scale is clamped at FIT_HI (a mis-detected band can't balloon a line),
 *   6. a near-match (< FIT_EPS) is left unchanged (no pointless reflow),
 *   7. no raster / no canvas (e.g. Node) → every size untouched (fail-safe).
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

// White raster W×H with a black band on rows [ry0, ry1). `cov` = fraction of the
// width inked, so a text-like band (partial coverage) can be told from a solid rule.
function raster(W, H, ry0, ry1, cov = 0.5) {
  const d = new Uint8ClampedArray(W * H * 4); d.fill(255);
  const xe = 2 + Math.round((W - 4) * cov);
  for (let y = ry0; y < ry1; y += 1) for (let x = 2; x < xe; x += 1) {
    const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = 0; d[i + 3] = 255;
  }
  return d;
}
const WHITE = 255; // bg luminance passed to measureInkHeight (the box's sampled fill)

/* 1. measureInkHeight: a 24px-tall text-like band on a 100×40 raster (scale 1) → 24. */
{
  const d = raster(100, 40, 8, 32); // rows 8..31 inked at 50% width = 24 rows
  const h = measureInkHeight(d, 100, 40, { x: 0, y: 0, w: 100, h: 40 }, 1, WHITE);
  check('measureInkHeight reports the band height', h === 24);
}

/* 2. A solid full-width bar (a rule/border) → null (not a line of text). */
{
  const d = raster(100, 40, 8, 32, 1.0); // 100% width = solid bar
  const h = measureInkHeight(d, 100, 40, { x: 0, y: 0, w: 100, h: 40 }, 1, WHITE);
  check('solid full-width bar rejected', h === null);
}

/* 3. Blank region → null. */
{
  const d = raster(100, 40, 0, 0); // no ink
  const h = measureInkHeight(d, 100, 40, { x: 0, y: 0, w: 100, h: 40 }, 1, WHITE);
  check('blank region rejected', h === null);
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

/* 4. Substitute inks SHORTER than baked → enlarge to match (baked 24, dom 20 → 1.2×). */
{
  RW = 100; RH = 40; PIXELS = raster(RW, RH, 8, 32); DOM_H = 20; // baked band = 24
  const b = box();
  await fitBoxFontToInk([page()], [b]);
  check('shorter substitute enlarged to the baked height', b.runs[0].marks.fontSize === Math.round(20 * (24 / 20)));
}

/* 5. Huge baked band → scale clamped at FIT_HI. */
{
  RW = 100; RH = 80; PIXELS = raster(RW, RH, 4, 76); DOM_H = 20; // baked band ≈ 72 → 3.6×
  const b = box({ frame: { x: 0, y: 0, w: 100, h: 80 } });
  await fitBoxFontToInk([page()], [b]);
  check('over-tall band is clamped at FIT_HI', b.runs[0].marks.fontSize === Math.round(20 * FIT_HI));
}

/* 6. Baked height ≈ substitute height (within FIT_EPS) → unchanged. */
{
  RW = 100; RH = 40; PIXELS = raster(RW, RH, 8, 28); DOM_H = 20; // baked band = 20
  check('sanity: 20 vs 20 is within FIT_EPS', Math.abs(20 / 20 - 1) < FIT_EPS);
  const b = box();
  await fitBoxFontToInk([page()], [b]);
  check('near-match left unchanged', b.runs[0].marks.fontSize === 20);
}

/* 7. Fail-safe: no page raster → no throw, sizes untouched. */
{
  const b = box();
  let threw = false;
  try { await fitBoxFontToInk([{ bg: null, width: 100, height: 40 }], [b]); } catch { threw = true; }
  check('missing raster does not throw', !threw);
  check('missing raster leaves sizes untouched', b.runs[0].marks.fontSize === 20);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll posbox ink-fit checks passed.');
