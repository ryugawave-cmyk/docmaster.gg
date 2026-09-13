/**
 * Regression test (headless Edge) — flow DOCX export → re-import preserves layout.
 *
 * Importing a .docx gave 2 pages, but Quick Export + re-import gave 3: the exporter
 * dropped the model's paragraph SPACING / LINE-HEIGHT / indent and collapsed the four
 * page MARGINS to one value, so re-import fell back to the editor defaults (10px after,
 * 1.4 line) and a wrong printable area — inflating content onto an extra page.
 *
 * blockModelToDocx now emits w:spacing (before/after/line) + w:ind per paragraph and a
 * full four-side w:pgMar. This round-trips a model through blockModelToDocx →
 * docxToBlockModel (both browser-only: Blob / DOMParser / DecompressionStream) and
 * asserts the layout-critical fields come back unchanged — the same inputs the editor
 * paginates on, so the page count and line breaks match.
 *
 * Needs Microsoft Edge; best-effort (SKIPPED, exit 0) if it can't launch.
 * Run: `node scripts/verify-docx-roundtrip-layout.mjs`.
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
  import { blockModelToDocx } from '/js/app/services/convert/blockExport.js';
  import { docxToBlockModel } from '/js/app/services/convert/docxImport.js';

  const mk = (text, style, marks) => ({ type: 'paragraph', tag: 'p',
    style: { align: 'left', ...style }, runs: [{ text, marks: { fontFamily: 'Georgia', fontSize: 15, color: '#111111', ...marks } }] });

  window.run = async () => {
    const doc = {
      title: 'rt', source: 'docx',
      page: { width: 794, height: 1123, margin: 72, margins: { top: 40, right: 60, bottom: 80, left: 100 } },
      blocks: [
        { type: 'paragraph', tag: 'h1', style: { align: 'left', spaceBefore: 12, spaceAfter: 6, lineHeight: 1.15 },
          runs: [{ text: 'Heading', marks: { fontFamily: 'Georgia', fontSize: 24, bold: true, color: '#2E74B5' } }] },
        mk('First body paragraph with tight spacing.', { spaceBefore: 0, spaceAfter: 4, lineHeight: 1.08 }),
        mk('Second body paragraph, indented.', { spaceBefore: 0, spaceAfter: 4, lineHeight: 1.08, indentLeft: 36 }),
      ],
    };
    const blob = await blockModelToDocx(doc);
    const buf = await blob.arrayBuffer();
    const re = await docxToBlockModel(buf, 'rt');
    const paras = (re.blocks || []).filter((b) => b.type === 'paragraph');
    return {
      margins: re.page && re.page.margins,
      pageW: re.page && re.page.width,
      pageH: re.page && re.page.height,
      blocks: paras.map((b) => ({
        tag: b.tag,
        spaceAfter: b.style && b.style.spaceAfter,
        spaceBefore: b.style && b.style.spaceBefore,
        lineHeight: b.style && b.style.lineHeight,
        indentLeft: b.style && b.style.indentLeft,
        font: b.runs[0].marks.fontFamily,
        size: b.runs[0].marks.fontSize,
      })),
    };
  };
</script></body>`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/__rl.html') { res.setHeader('Content-Type', 'text/html'); res.end(TEST_HTML); return; }
  const fp = path.join(WEBROOT, url);
  if (!fp.startsWith(WEBROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(fp)] || 'application/octet-stream');
  fs.createReadStream(fp).pipe(res);
});

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok  ${name}`); else { console.error(`FAIL  ${name}`); failures += 1; } };
const near = (a, b, tol) => Math.abs((a || 0) - (b || 0)) <= tol;

await new Promise((r) => server.listen(0, r));
const port = server.address().port;

if (!edge) { console.log('SKIPPED: Microsoft Edge not found'); server.close(); process.exit(0); }
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: edge, headless: 'new',
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'edge-rl-')),
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/__rl.html`, { waitUntil: 'networkidle0' });
  const r = await page.evaluate(() => window.run());

  // Four distinct margins survive (px round-trips within 1px of px→twips→px).
  check('margin top preserved (40)', r.margins && near(r.margins.top, 40, 1));
  check('margin right preserved (60)', r.margins && near(r.margins.right, 60, 1));
  check('margin bottom preserved (80)', r.margins && near(r.margins.bottom, 80, 1));
  check('margin left preserved (100)', r.margins && near(r.margins.left, 100, 1));
  check('margins are NOT collapsed to one value', r.margins && r.margins.top !== r.margins.left);
  check('page size preserved', near(r.pageW, 794, 2) && near(r.pageH, 1123, 2));

  const [h, p1, p2] = r.blocks;
  check('heading round-trips as a heading', h && h.tag === 'h1');
  check('heading spacing preserved (after 6)', h && near(h.spaceAfter, 6, 1));
  check('body line-height preserved (~1.08, not 1.4 default)', p1 && near(p1.lineHeight, 1.08, 0.02));
  check('body spaceAfter preserved (4, not 10 default)', p1 && near(p1.spaceAfter, 4, 1));
  check('paragraph indent preserved (36)', p2 && near(p2.indentLeft, 36, 2));
  check('font family preserved through round-trip', p1 && p1.font === 'Georgia');
  check('font size preserved (15)', p1 && near(p1.size, 15, 1));
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
console.log('\nAll flow DOCX round-trip layout checks passed.');
