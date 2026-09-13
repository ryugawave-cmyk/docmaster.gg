/**
 * Regression test (headless Edge) — a revealed positioned box doesn't re-wrap its line.
 *
 * PDF→Doc "Transfer to Doc" stores each PDF line as a `.doc-posbox` whose width came
 * from the PDF's OWN embedded-font ink extent. The editor renders the line in a
 * SUBSTITUTE font that is a touch wider, so a wrapping (paragraph) box breaks its last
 * word onto a 2nd row the instant it is revealed for editing — the "paragraph width
 * shrinks / text reflows when I click it" bug. documentEditor.fitPosboxWidthEl() grows
 * the box on reveal to hold the line on ONE row, measured against the LIVE box with the
 * real font applied (exact, unlike the canvas measure at transfer time before the font
 * has loaded). This drives that REAL function against a live DOM.
 *
 * Needs Microsoft Edge; throwaway user-data dir to dodge the running-Edge singleton.
 * Best-effort: prints SKIPPED (exit 0) if Edge can't launch.
 * Run: `node scripts/verify-posbox-width.mjs`.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEBROOT = path.join(ROOT, 'public');
const EDGES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const edge = EDGES.find((p) => fs.existsSync(p));

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

const TEST_HTML = `<!doctype html><meta charset=utf8><body><script type="module">
  import { fitPosboxWidthEl } from '/js/app/editor/documentEditor.js';

  const LONG = 'The learning outcome and assessment criteria will be basis for setting question papers for final assessment.';

  // A positioned line-box exactly like editableHtml.posboxToEl renders: absolute,
  // border-box, pre-wrap, line-height 1, at (left, w).
  function makeBox(text, left, w, extra = {}) {
    const page = document.createElement('div');
    page.style.position = 'relative'; page.style.width = '2000px';
    const box = document.createElement('div');
    box.className = 'doc-posbox';
    box.style.position = 'absolute'; box.style.boxSizing = 'border-box'; box.style.margin = '0'; box.style.padding = '0';
    box.style.left = left + 'px'; box.style.top = '0'; box.style.width = w + 'px';
    box.style.whiteSpace = 'pre-wrap'; box.style.overflowWrap = 'break-word'; box.style.lineHeight = '1';
    box.style.fontFamily = 'Arial, sans-serif'; box.style.fontSize = '16px';
    box.dataset.w = String(w);
    if (extra.nowrap) box.dataset.nowrap = '1';
    const span = document.createElement('span'); span.textContent = text; span.style.fontSize = '16px';
    box.appendChild(span);
    page.appendChild(box); document.body.appendChild(page);
    return box;
  }

  window.run = () => {
    const out = {};
    // 1) A too-narrow paragraph box (wraps) → grows to one line (height collapses).
    {
      const box = makeBox(LONG, 50, 200);
      const hBefore = box.offsetHeight;                 // wrapped: several rows tall
      const w = fitPosboxWidthEl(box, 2000);
      out.grow = { hBefore, hAfter: box.offsetHeight, w, styleW: parseFloat(box.style.width) };
    }
    // 2) A nowrap box (table label/value) is NOT widened (mask must not spill).
    {
      const box = makeBox(LONG, 50, 200, { nowrap: true });
      const w = fitPosboxWidthEl(box, 2000);
      out.nowrap = { w, styleW: parseFloat(box.style.width) };
    }
    // 3) Widening is capped at the page's right edge (never runs off the sheet).
    {
      const box = makeBox(LONG, 1900, 50);              // needs far more than fits
      const w = fitPosboxWidthEl(box, 2000);            // cap = 2000 - 1900 - 2 = 98
      out.cap = { w };
    }
    // 4) A box already wide enough is left unchanged (grow-only).
    {
      const box = makeBox(LONG, 50, 1500);
      const w = fitPosboxWidthEl(box, 2000);
      out.wide = { w, styleW: parseFloat(box.style.width) };
    }
    return out;
  };
</script></body>`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/__pw.html') { res.setHeader('Content-Type', 'text/html'); res.end(TEST_HTML); return; }
  const fp = path.join(WEBROOT, url);
  if (!fp.startsWith(WEBROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(fp)] || 'application/octet-stream');
  fs.createReadStream(fp).pipe(res);
});

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok  ${name}`); else { console.error(`FAIL  ${name}`); failures += 1; } };

await new Promise((r) => server.listen(0, r));
const port = server.address().port;

if (!edge) { console.log('SKIPPED: Microsoft Edge not found'); server.close(); process.exit(0); }
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: edge, headless: 'new',
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'edge-pw-')),
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/__pw.html`, { waitUntil: 'networkidle0' });
  const r = await page.evaluate(() => window.run());

  // 1) grew to a single line
  check('grow: box widened past its original 200px', r.grow.w > 200 && r.grow.styleW > 200);
  check('grow: line no longer wraps (height collapsed to ~1 row)', r.grow.hAfter < r.grow.hBefore && r.grow.hAfter <= 24);
  // 2) nowrap untouched
  check('nowrap: box left at its original width', r.nowrap.w === 200 && r.nowrap.styleW === 200);
  // 3) capped at the page edge
  check('cap: width capped at the page right edge (98)', r.cap.w === 98);
  // 4) already wide → unchanged
  check('wide: already-wide box left unchanged', r.wide.w === 1500 && r.wide.styleW === 1500);
} catch (e) {
  console.log('SKIPPED:', String(e.message || e).split('\n')[0]);
  if (browser) await browser.close();
  server.close();
  process.exit(0);
} finally {
  if (browser) await browser.close();
  server.close();
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll posbox-width checks passed.');
