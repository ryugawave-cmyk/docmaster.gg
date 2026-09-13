/**
 * Regression test (headless Edge) — text highlight survives DOCX round-trip.
 *
 * The editor shows yellow highlights, but they were lost on Quick Export: the run's
 * background colour was never captured into the model (marksFromEl ignored it), so the
 * exporter had nothing to write and the importer nothing to read. Now:
 *   • marksFromEl captures the run background as marks.highlight; runToNode renders it;
 *   • blockExport writes <w:highlight w:val="yellow"/> for the 16 named marker colours,
 *     else run shading <w:shd w:fill="RRGGBB"/> for an exact custom colour;
 *   • docxImport reads w:highlight / run w:shd back into marks.highlight.
 *
 * This drives the REAL functions in Edge: (A) the editor DOM round-trip
 * (renderBlocks → readBlocks) and (B) export → raw document.xml + re-import.
 *
 * Needs Microsoft Edge; best-effort (SKIPPED, exit 0) if it can't launch.
 * Run: `node scripts/verify-docx-highlight.mjs`.
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
  import { renderBlocks, readBlocks } from '/js/app/model/editableHtml.js';
  import { blockModelToDocx } from '/js/app/services/convert/blockExport.js';
  import { docxToBlockModel } from '/js/app/services/convert/docxImport.js';

  const para = (runs) => ({ type: 'paragraph', tag: 'p', style: { align: 'left' }, runs });
  const mk = (text, hl) => ({ text, marks: { fontFamily: 'Georgia', fontSize: 15, color: '#111111', ...(hl ? { highlight: hl } : {}) } });

  const findHL = (blocks) => {
    const runs = (blocks.find((b) => b.type === 'paragraph') || {}).runs || [];
    return runs.map((r) => ({ text: r.text, hl: r.marks.highlight || null }));
  };

  window.runDom = () => {
    // (A) Render a highlighted run into the DOM, then read it back — captures marks.highlight.
    const doc = { blocks: [para([mk('plain '), mk('MARKED', '#ffff00')])] };
    const host = document.createElement('div');
    host.className = 'doc-page';
    for (const el of renderBlocks(doc)) host.appendChild(el);
    document.body.appendChild(host);
    return findHL(readBlocks(host));
  };

  window.runExport = async () => {
    // (B) A model with a named-colour highlight (yellow) and a custom colour (#ffe64d).
    const model = {
      title: 'hl', source: 'docx', page: { width: 794, height: 1123, margin: 72 },
      blocks: [para([mk('none '), mk('YELLOW', '#ffff00'), mk(' '), mk('CUSTOM', '#ffe64d')])],
    };
    const buf = await (await blockModelToDocx(model)).arrayBuffer();
    const xml = new TextDecoder('latin1').decode(new Uint8Array(buf)); // STORED zip → plain text
    const re = await docxToBlockModel(buf, 'hl');
    return {
      hasNamed: xml.includes('<w:highlight w:val="yellow"/>'),
      hasShd: /<w:shd[^>]*w:fill="FFE64D"/i.test(xml),
      runs: findHL(re.blocks),
    };
  };
</script></body>`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/__hl.html') { res.setHeader('Content-Type', 'text/html'); res.end(TEST_HTML); return; }
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
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'edge-hl-')),
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/__hl.html`, { waitUntil: 'networkidle0' });

  // (A) editor DOM round-trip
  const dom = await page.evaluate(() => window.runDom());
  const marked = dom.find((r) => r.text === 'MARKED');
  check('editor captures the run highlight on read-back', marked && marked.hl && marked.hl.toLowerCase() === '#ffff00');
  const plain = dom.find((r) => r.text.trim() === 'plain');
  check('non-highlighted run has no highlight mark', plain && !plain.hl);

  // (B) export → XML + re-import
  const exp = await page.evaluate(() => window.runExport());
  check('export writes <w:highlight w:val="yellow"/> for a named colour', exp.hasNamed);
  check('export writes run shading (w:shd w:fill) for a custom colour', exp.hasShd);
  const yellow = exp.runs.find((r) => r.text === 'YELLOW');
  const custom = exp.runs.find((r) => r.text === 'CUSTOM');
  check('re-import maps w:highlight yellow → #ffff00', yellow && yellow.hl && yellow.hl.toLowerCase() === '#ffff00');
  check('re-import maps custom w:shd fill → #ffe64d', custom && custom.hl && custom.hl.toLowerCase() === '#ffe64d');
  const none = exp.runs.find((r) => r.text.trim() === 'none');
  check('non-highlighted run stays un-highlighted through round-trip', none && !none.hl);
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
console.log('\nAll DOCX highlight round-trip checks passed.');
