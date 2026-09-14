/**
 * Regression test (headless Edge) — Doc→PDF export page count matches the editor.
 *
 * The Advanced Export "Doc → PDF" path (blockModelToPdf) re-paginates the model with
 * its OWN engine, which had drifted from the editor's paginate(): it IGNORED forced
 * page breaks (block.breakBefore) and used a single margin for top/bottom instead of
 * the model's per-side margins. So a document that showed N pages in the editor
 * exported as a different count (a 6-page doc → 4, a 16-page doc → 17, …).
 *
 * This feeds ONE model — with forced page breaks AND non-uniform per-side margins —
 * to BOTH the live editor (createDocumentEditor → onPaginate pageCount) and the PDF
 * exporter (blockModelToPdf → /Count in the PDF) and asserts the two counts are equal.
 *
 * Needs Microsoft Edge + the pdfjs-dist standard fonts (served at /vendor/pdfjs);
 * best-effort SKIP (exit 0) if it can't launch. Run: `node scripts/verify-doc-pdf-pagecount.mjs`.
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
const VENDOR = path.join(ROOT, 'node_modules', 'pdfjs-dist');
const EDGES = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
const edge = EDGES.find((p) => fs.existsSync(p));
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.ttf': 'font/ttf' };

const TEST_HTML = `<!doctype html><meta charset=utf8><link rel="stylesheet" href="/css/app.css">
  <style>#wrap{height:600px;overflow:auto}</style><body><div id="wrap"></div><script type="module">
  import { createDocumentEditor } from '/js/app/editor/documentEditor.js';
  import { blockModelToPdf } from '/js/app/services/convert/blockExport.js';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const para = (text, extra = {}) => ({ type: 'paragraph', tag: 'p',
    style: { align: 'left', lineHeight: 1.15, spaceAfter: 8, ...extra.style },
    runs: [{ text, marks: { fontFamily: 'Inter', fontSize: 15, color: '#111111' } }], ...extra });
  window.run = async () => {
    // Enough text to fill multiple pages, with a hard page break before every heading
    // and DISTINCT per-side margins (top/bottom differ from left/right) — the two
    // conditions that used to make the PDF diverge from the editor.
    const filler = ('Financial markets continue to evolve due to technology, globalization and regulatory change. ').repeat(22);
    const blocks = [];
    for (let s = 0; s < 5; s++) {
      blocks.push({ type: 'paragraph', tag: 'h1', style: { align: 'left', spaceBefore: 24, spaceAfter: 6, lineHeight: 1.15 },
        runs: [{ text: 'Section ' + (s + 1), marks: { fontFamily: 'Inter', fontSize: 24, bold: true, color: '#2E74B5' } }],
        ...(s > 0 ? { breakBefore: true } : {}) });
      blocks.push(para(filler));
      blocks.push(para(filler));
    }
    const doc = {
      id: 'd', title: 'pc', meta: { source: 'docx' },
      page: { width: 794, height: 1123, margin: 40, margins: { top: 30, right: 50, bottom: 70, left: 40 } },
      header: null, footer: null, blocks,
    };
    const wrap = document.getElementById('wrap');
    let editorPages = 0;
    const ed = createDocumentEditor({ container: wrap, onChange: () => {}, onSelection: () => {}, onPaginate: (p) => { editorPages = p.pageCount; } });
    ed.load(doc);
    await document.fonts.ready; await sleep(500);
    const blob = await blockModelToPdf(doc);
    const txt = new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));
    const m = txt.match(/\\/Count\\s+(\\d+)/);
    const pdfPages = m ? +m[1] : (txt.match(/\\/Type\\s*\\/Page[^s]/g) || []).length;
    return { editorPages, pdfPages, breaks: blocks.filter((b) => b.breakBefore).length };
  };
</script></body>`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/__pc.html') { res.setHeader('Content-Type', 'text/html'); res.end(TEST_HTML); return; }
  if (url.startsWith('/vendor/pdfjs/')) {
    const vp = path.join(VENDOR, url.slice('/vendor/pdfjs/'.length));
    if (fs.existsSync(vp) && !fs.statSync(vp).isDirectory()) { res.setHeader('Content-Type', MIME[path.extname(vp)] || 'application/octet-stream'); fs.createReadStream(vp).pipe(res); return; }
    res.statusCode = 404; res.end('nf'); return;
  }
  const fp = path.join(WEBROOT, url);
  if (!fp.startsWith(WEBROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(fp)] || 'application/octet-stream');
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
if (!edge) { console.log('SKIPPED: Microsoft Edge not found'); server.close(); process.exit(0); }

let failures = 0;
const check = (name, cond, extra) => { if (cond) console.log(`  ok  ${name}`); else { console.error(`FAIL  ${name}${extra != null ? ` (${extra})` : ''}`); failures += 1; } };
let browser;
try {
  browser = await puppeteer.launch({ executablePath: edge, headless: 'new', userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'edge-pc-')), args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); });
  await page.goto(`http://127.0.0.1:${port}/__pc.html`, { waitUntil: 'networkidle0' });
  const r = await page.evaluate(() => window.run());
  console.log(`  editor pages: ${r.editorPages} | PDF pages: ${r.pdfPages} | forced breaks: ${r.breaks}`);
  check('document actually spans multiple pages', r.editorPages > 3, `editor=${r.editorPages}`);
  check('forced page breaks were present', r.breaks === 4, `breaks=${r.breaks}`);
  check('PDF page count equals editor page count', r.editorPages === r.pdfPages, `editor=${r.editorPages} pdf=${r.pdfPages}`);
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
console.log('\nDoc→PDF page-count parity check passed.');
