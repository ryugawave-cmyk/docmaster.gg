/**
 * Regression test — PDF → DOC positioned "text shrinks when I click it".
 *
 * The dormant transfer model keeps the original glyphs baked in the page raster and
 * hides each editable box until it is focused; on reveal the box masks the baked
 * glyph and re-draws the line in a substitute font (Arial/Inter). That substitute is
 * usually a little NARROWER than the PDF's embedded font, so a revealed line used to
 * look smaller than the page image it replaced.
 *
 * `fitBoxFontToWidth` (positionedImport.js) scales each box's font up until the
 * re-drawn text spans the same width as the original PDF run (`_tw`). This guards:
 *   1. a narrower substitute is ENLARGED toward the original width,
 *   2. growth is CAPPED at FIT_MAX (a huge width gap can't balloon a line),
 *   3. a substitute that is already ≥ the original is left UNCHANGED (never shrunk),
 *   4. a sub-FIT_MIN gap is ignored (no pointless reflow),
 *   5. the box height grows with the enlarged font (line isn't clipped),
 *   6. no `_tw` (e.g. OCR boxes) → untouched.
 *
 * Drives the REAL shipping function with a stub canvas whose measureText width is a
 * knob, so each case pins an exact scale. Run: `node scripts/verify-posbox-fit.mjs`.
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

// Stub canvas: measureText returns `MEASURED` px regardless of the string, so a test
// can pin the substitute width exactly and thus the scale the fitter must compute.
let MEASURED = 0;
globalThis.document = {
  createElement: () => ({ getContext: () => ({ font: '', measureText: () => ({ width: MEASURED }) }) }),
};

const { fitBoxFontToWidth, FIT_MIN, FIT_MAX } =
  await import(pathToFileURL(path.join(tmp, 'app/services/convert/positionedImport.js')).href);

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok  ${name}`); return; }
  console.error(`FAIL  ${name}`);
  failures += 1;
}
// A one-run box at 20px, real PDF extent 200px, box height 26px.
function box(overrides = {}) {
  return {
    runs: [{ text: 'RAILWAY RECRUITMENT BOARD', marks: { fontSize: 20, fontFamily: 'Arial', bold: true } }],
    frame: { x: 0, y: 0, w: 220, h: 26 },
    _tw: 200,
    ...overrides,
  };
}

// 1. Narrow substitute (160px < 200px extent) → enlarge by 200/160 = 1.25, capped to FIT_MAX.
{
  MEASURED = 160;
  const b = box();
  fitBoxFontToWidth([b]);
  const expected = Math.round(20 * FIT_MAX); // 1.25 exceeds the 1.22 cap
  check('narrow substitute enlarged and capped at FIT_MAX', b.runs[0].marks.fontSize === expected);
  check('capped growth grows the box height', b.frame.h === Math.round(expected * 1.3));
}

// 2. Narrow substitute within the cap (185px → 200/185 ≈ 1.081) → exact scale.
{
  MEASURED = 185;
  const b = box();
  const scale = 200 / 185;
  check('scale is within cap (sanity)', scale < FIT_MAX && scale > FIT_MIN);
  fitBoxFontToWidth([b]);
  check('sub-cap gap uses the exact width-fit scale', b.runs[0].marks.fontSize === Math.round(20 * scale));
}

// 3. Substitute already WIDER than the original → never shrink.
{
  MEASURED = 230;
  const b = box();
  fitBoxFontToWidth([b]);
  check('wider substitute is left unchanged (no shrink)', b.runs[0].marks.fontSize === 20);
  check('unchanged box keeps its height', b.frame.h === 26);
}

// 4. Gap below FIT_MIN (198px → 1.01) → ignored (no reflow).
{
  MEASURED = 198;
  const b = box();
  check('gap is below FIT_MIN (sanity)', 200 / 198 < FIT_MIN);
  fitBoxFontToWidth([b]);
  check('sub-FIT_MIN gap ignored', b.runs[0].marks.fontSize === 20);
}

// 5. Multi-run box: every run scales by the SAME factor (relative sizes preserved).
{
  MEASURED = 160; // → cap FIT_MAX
  const b = box({
    runs: [
      { text: 'Big ', marks: { fontSize: 24, fontFamily: 'Arial' } },
      { text: 'small', marks: { fontSize: 12, fontFamily: 'Arial' } },
    ],
  });
  fitBoxFontToWidth([b]);
  check('run 0 scaled by cap', b.runs[0].marks.fontSize === Math.round(24 * FIT_MAX));
  check('run 1 scaled by the same cap', b.runs[1].marks.fontSize === Math.round(12 * FIT_MAX));
}

// 6. No `_tw` (e.g. an OCR-recovered box) → untouched.
{
  MEASURED = 10;
  const b = box({ _tw: undefined });
  fitBoxFontToWidth([b]);
  check('box without _tw is untouched', b.runs[0].marks.fontSize === 20);
}

// 7. Fail-safe: no canvas (Node without the stub) → no throw, no change.
{
  const saved = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => null }) };
  const b = box();
  let threw = false;
  try { fitBoxFontToWidth([b]); } catch { threw = true; }
  globalThis.document = saved;
  check('missing canvas context does not throw', !threw);
  check('missing canvas context leaves sizes untouched', b.runs[0].marks.fontSize === 20);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll posbox width-fit checks passed.');
