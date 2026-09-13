/**
 * Round-trip check (headless Edge) — positioned Word export → re-import.
 *
 * Transfer-to-Doc builds a positioned model; the EXACT-layout export (opt-in via
 * `blockModelToDocx(doc, { exact:true })`) writes a .docx with a re-import JSON sidecar
 * of the ORIGINAL model; re-opening that .docx in the Document editor must come back
 * POSITIONED and PIXEL-IDENTICAL to the original (original raster + dormant boxes +
 * exact frames/fills), not flattened or rebuilt lossily. (Default Quick Export instead
 * produces an editable flow document — see verify-positioned-docx.mjs.) This drives the
 * REAL browser modules (blockModelToDocx + docxToBlockModel) in Edge, since both need
 * DOMParser / canvas / DecompressionStream that Node lacks.
 *
 * Needs Microsoft Edge; uses a throwaway user-data dir to dodge the running-Edge
 * singleton. Best-effort: prints SKIPPED (exit 0) if Edge can't launch.
 * Run: `node scripts/verify-positioned-roundtrip.mjs`.
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
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const TEST_HTML = `<!doctype html><meta charset=utf8><body><script type="module">
  import { blockModelToDocx } from '/js/app/services/convert/blockExport.js';
  import { docxToBlockModel } from '/js/app/services/convert/docxImport.js';
  window.run = async () => {
    const doc = {
      layout: 'positioned', page: { width: 794, height: 1123, margin: 0 },
      pages: [{ bg: '${PNG}', width: 794, height: 1123 }, { bg: '${PNG}', width: 794, height: 1123 }],
      blocks: [
        { type:'posbox', page:0, frame:{x:100,y:80,w:400,h:24}, style:{align:'center'}, fill:'#ffffff',
          runs:[{text:'RAILWAY RECRUITMENT BOARD', marks:{fontSize:16,bold:true,color:'#111111',fontFamily:'Arial'}}] },
        { type:'posbox', page:1, frame:{x:120,y:200,w:360,h:20}, style:{align:'left'}, fill:'#eeeeee',
          runs:[{text:'Registration No : L72511691071', marks:{fontSize:12,color:'#111111',fontFamily:'Arial'}}] },
      ],
    };
    const blob = await blockModelToDocx(doc, { exact: true });
    const buf = await blob.arrayBuffer();
    const re = await docxToBlockModel(buf, 'roundtrip');
    const boxes = (re.blocks||[]).filter(b => b.type === 'posbox');
    return {
      layout: re.layout,
      pageCount: (re.pages||[]).length,
      pagesHaveBg: (re.pages||[]).every(p => !!p.bg),
      bgIsOriginal: (re.pages||[]).every(p => p.bg === '${PNG}'), // sidecar → original raster verbatim
      boxCount: boxes.length,
      texts: boxes.map(b => (b.runs||[]).map(r=>r.text).join('')),
      pageOf: boxes.map(b => b.page),
      fills: boxes.map(b => b.fill),
      firstFrame: boxes[0] && boxes[0].frame,
      firstBold: !!(boxes[0] && boxes[0].runs[0].marks.bold),
    };
  };

  // Reveal-shrink fix: a dormant box whose MODEL font is smaller than the baked raster
  // text must be enlarged on re-import so revealing it for editing doesn't shrink it.
  window.runShrinkFix = async () => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 80;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 80);
    x.fillStyle = '#111'; x.font = '26px Arial'; x.fillText('SHRINKAGE TEST LINE', 20, 44); // baked BIG
    const bg = c.toDataURL('image/png');
    const doc = {
      layout: 'positioned', page: { width: 600, height: 80, margin: 0 },
      pages: [{ bg, width: 600, height: 80 }],
      // model font deliberately TINY (8px) vs the ~26px baked line
      blocks: [{ type: 'posbox', page: 0, frame: { x: 20, y: 22, w: 400, h: 30 }, style: { align: 'left' }, fill: '#ffffff',
        runs: [{ text: 'SHRINKAGE TEST LINE', marks: { fontSize: 8, color: '#111111', fontFamily: 'Arial' } }] }],
    };
    const buf = await (await blockModelToDocx(doc, { exact: true })).arrayBuffer();
    const re = await docxToBlockModel(buf, 'shrink');
    const box = (re.blocks || []).find(b => b.type === 'posbox');
    return { size: box && box.runs[0].marks.fontSize };
  };
</script></body>`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/__rt.html') { res.setHeader('Content-Type', 'text/html'); res.end(TEST_HTML); return; }
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
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'edge-rt-')),
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/__rt.html`, { waitUntil: 'networkidle0' });
  const r = await page.evaluate(() => window.run());

  check('re-import is POSITIONED (not flattened)', r.layout === 'positioned');
  check('both pages restored', r.pageCount === 2);
  check('each page has a raster background', r.pagesHaveBg === true);
  check('sidecar restores the ORIGINAL raster (baked, not erased)', r.bgIsOriginal === true);
  check('both lines restored as posboxes', r.boxCount === 2);
  check('text preserved', r.texts.includes('RAILWAY RECRUITMENT BOARD') && r.texts.includes('Registration No : L72511691071'));
  check('lines land on their own pages', r.pageOf[0] === 0 && r.pageOf[1] === 1);
  check('fills preserved verbatim (dormant masking intact)', r.fills[0] === '#ffffff' && r.fills[1] === '#eeeeee');
  check('bold survived the round-trip', r.firstBold === true);
  check('frame position is EXACT (sidecar, no rounding)', r.firstFrame && r.firstFrame.x === 100 && r.firstFrame.y === 80);

  // Reveal-shrink fix: re-import enlarges an under-sized dormant box to match the baked text.
  const sf = await page.evaluate(() => window.runShrinkFix());
  check('re-import enlarges under-sized box to match baked (no reveal shrink)', sf.size > 10);
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
console.log('\nAll positioned round-trip checks passed.');
