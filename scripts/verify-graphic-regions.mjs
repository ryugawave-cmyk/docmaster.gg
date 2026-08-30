/**
 * Regression test — PDF → DOC image/diagram handling.
 *
 * Guards the fix for "text inside a vector diagram is lifted into a shifted, separate
 * text element" (e.g. the biology cell illustration's "CELL • NUCLEUS • ORGANELLES"
 * label). It drives the REAL shipping detector `graphicRegions.detectGraphicRegionsFromPixels`
 * with synthetic page rasters (the repo has no sample PDF) and asserts:
 *
 *   1. a COLOURFUL, BLOCKY diagram is detected as one region (its labels are kept
 *      baked / inside it),
 *   2. plain black-on-white body text is NOT a region (stays editable),
 *   3. a grey/black table grid is NOT a region (stays editable),
 *   4. a thin colourful banner bar is NOT a region (too flat),
 *   5. a near-full-page colour fill (scan) is NOT a region (OCR still works there),
 *   6. a label sitting INSIDE the diagram is gated out of the editable layer, while a
 *      caption/body line OUTSIDE it is kept.
 *
 * Pure Node: the detector has no DOM/pdfjs deps, so it is copied to a temp .mjs and
 * imported. Run: `node scripts/verify-graphic-regions.mjs`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docmaster-gr-'));
function loadModule(rel) {
  const dest = path.join(tmp, path.basename(rel));
  fs.copyFileSync(path.join(ROOT, rel), dest);
  return import(pathToFileURL(dest).href);
}
const { detectGraphicRegionsFromPixels } = await loadModule('public/js/app/services/convert/graphicRegions.js');

// Same intersection-over-smaller-box gate positionedImport uses to decide "inside".
const overlaps = (a, f, thresh) => {
  const minArea = Math.min(a.w * a.h, f.w * f.h); if (minArea <= 0) return false;
  const ix = Math.max(0, Math.min(a.x + a.w, f.x + f.w) - Math.max(a.x, f.x));
  const iy = Math.max(0, Math.min(a.y + a.h, f.y + f.h) - Math.max(a.y, f.y));
  return (ix * iy) / minArea > thresh;
};

const W = 400, H = 560;                 // portrait page raster (scale 1 ⇒ page = raster)
const COLORS = [[0, 160, 60], [40, 80, 200], [210, 60, 60], [150, 60, 200]]; // saturated
function blank() { const d = new Uint8ClampedArray(W * H * 4); d.fill(255); return d; }
function fillRect(d, x0, y0, x1, y1, color) {
  for (let y = y0; y < y1 && y < H; y += 1) {
    for (let x = x0; x < x1 && x < W; x += 1) {
      const i = (y * W + x) * 4; const c = typeof color === 'function' ? color(x, y) : color;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    }
  }
}
const rainbow = (x, y) => COLORS[(x + y) & 3];

let failures = 0;
function check(label, cond) {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
}

/* 1) Colourful diagram block (shapes) + body text below it. */
{
  const d = blank();
  fillRect(d, 40, 120, 360, 320, rainbow);      // the diagram (colourful, blocky)
  fillRect(d, 40, 420, 360, 432, [20, 20, 20]); // a black body line, well below it
  const regions = detectGraphicRegionsFromPixels(d, W, H, W);
  check('diagram detected as exactly one region', regions.length === 1);
  const g = regions[0] || { x: 0, y: 0, w: 0, h: 0 };
  // label inside the diagram (e.g. "CELL • NUCLEUS • ORGANELLES" near its bottom)
  const label = { x: 120, y: 295, w: 180, h: 16 };
  const body = { x: 40, y: 420, w: 320, h: 14 };
  check('embedded label is INSIDE the diagram region (kept baked)', overlaps(label, g, 0.5));
  check('body line is OUTSIDE the diagram region (stays editable)', !overlaps(body, g, 0.5));
}

/* 2) Plain body text page — no diagram. */
{
  const d = blank();
  for (let ln = 0; ln < 12; ln += 1) fillRect(d, 40, 60 + ln * 30, 360, 74 + ln * 30, [15, 15, 15]);
  check('black-on-white text ⇒ no regions', detectGraphicRegionsFromPixels(d, W, H, W).length === 0);
}

/* 3) Grey/black table grid — no diagram. */
{
  const d = blank();
  for (let x = 40; x <= 360; x += 64) fillRect(d, x, 120, x + 2, 360, [30, 30, 30]);   // verticals
  for (let y = 120; y <= 360; y += 40) fillRect(d, 40, y, 360, y + 2, [30, 30, 30]);   // horizontals
  check('grey table grid ⇒ no regions', detectGraphicRegionsFromPixels(d, W, H, W).length === 0);
}

/* 4) Thin colourful banner bar — too flat to be a diagram. */
{
  const d = blank();
  fillRect(d, 20, 40, 380, 60, rainbow);
  check('thin colour banner ⇒ no regions', detectGraphicRegionsFromPixels(d, W, H, W).length === 0);
}

/* 5) Near-full-page colour fill (a scanned/full-bleed page) — not a suppressing region. */
{
  const d = blank();
  fillRect(d, 0, 0, W, H, rainbow);
  check('full-page colour fill ⇒ no regions (OCR still runs)', detectGraphicRegionsFromPixels(d, W, H, W).length === 0);
}

/* 6) Colour table HEADER bar (wide + short, like a purple vocab-table header) —
 *    must NOT be treated as a diagram, or its header text would stop being editable. */
{
  const d = blank();
  fillRect(d, 40, 120, 360, 146, [150, 60, 200]);           // 320×26 purple header bar
  for (let y = 150; y <= 300; y += 30) fillRect(d, 40, y, 360, y + 2, [30, 30, 30]); // grey body rules
  check('colour table header bar ⇒ no regions (header stays editable)', detectGraphicRegionsFromPixels(d, W, H, W).length === 0);
}

/* 7) MIXED page (the real-world case): a diagram AND a colour-header table AND body
 *    text on one page. Only the diagram is gated; the table + body stay editable. */
{
  const d = blank();
  fillRect(d, 40, 60, 360, 260, rainbow);                   // the diagram (colourful, tall block)
  fillRect(d, 40, 330, 360, 356, [150, 60, 200]);           // colour table header bar
  for (let y = 360; y <= 470; y += 28) fillRect(d, 40, y, 360, y + 2, [30, 30, 30]); // table body rules
  fillRect(d, 40, 500, 360, 512, [15, 15, 15]);             // a black body line
  const regions = detectGraphicRegionsFromPixels(d, W, H, W);
  check('mixed page ⇒ exactly one region (the diagram only)', regions.length === 1);
  const g = regions[0] || { x: 0, y: 0, w: 0, h: 0 };
  const diagramLabel = { x: 120, y: 235, w: 180, h: 16 };   // inside the diagram
  const headerCell = { x: 60, y: 330, w: 120, h: 18 };      // table header "Term"
  const bodyLine = { x: 40, y: 500, w: 320, h: 14 };
  check('diagram label INSIDE the region (kept baked)', overlaps(diagramLabel, g, 0.5));
  check('table header OUTSIDE the region (stays editable)', !overlaps(headerCell, g, 0.5));
  check('body line OUTSIDE the region (stays editable)', !overlaps(bodyLine, g, 0.5));
}

/* 8) Reliability cap (positionedImport): a genuine diagram's labels are a MINORITY
 *    of a page's text. If detected regions would swallow > 35% of a page's text runs,
 *    the detection is over-firing (a busy "colourful" page) → drop the page's regions
 *    so real text stays EDITABLE and heading inference keeps a correct body size. */
function applyCap(segFrames, regions) {
  if (!regions.length) return regions;
  const inRegion = segFrames.reduce((n, s) => n + (regions.some((g) => overlaps(s, g, 0.5)) ? 1 : 0), 0);
  return inRegion > segFrames.length * 0.35 ? [] : regions;
}
{
  const seg = (y) => ({ x: 60, y, w: 200, h: 16 });
  const segs = Array.from({ length: 10 }, (_, i) => seg(100 + i * 30)); // 10 text lines
  const wide = { x: 40, y: 90, w: 260, h: 200 };  // a region overlapping the first ~6 lines
  const small = { x: 40, y: 90, w: 260, h: 70 };  // a region overlapping ~2 lines
  check('over-firing region (>35% of runs) is DROPPED (text stays editable)', applyCap(segs, [wide]).length === 0);
  check('small diagram region (<35% of runs) is KEPT (labels baked)', applyCap(segs, [small]).length === 1);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures ? `❌ ${failures} check(s) failed` : '✅ all graphic-region checks passed'}`);
process.exit(failures ? 1 : 0);
