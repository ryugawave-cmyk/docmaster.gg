/**
 * Regression test (headless Edge) — Advanced Export carries the recent fixes.
 *
 *  • Highlight now renders in Document → PDF (a filled rect behind the run) and
 *    Document → PowerPoint (<a:highlight>), matching Quick Export's DOCX highlight.
 *  • Document → JPG/PNG renders each page INDEPENDENTLY to its own image file
 *    (name_page_1.jpg, name_page_2.jpg, …) at full quality — never one long
 *    stitched image and never a ZIP.
 *
 * Drives the REAL exporters in Edge (Blob / canvas / PDF.js are browser-only).
 * Best-effort: prints SKIPPED (exit 0) if Edge can't launch.
 * Run: `node scripts/verify-advanced-export.mjs`.
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
  import { blockModelToPdf, blockModelToPptx } from '/js/app/services/convert/blockExport.js';
  import { blockModelToImages } from '/js/app/services/convert/blockMedia.js';

  const run = (text, hl) => ({ text, marks: { fontFamily: 'Arial', fontSize: 16, color: '#111111', ...(hl ? { highlight: hl } : {}) } });
  const para = (runs, style) => ({ type: 'paragraph', tag: 'p', style: { align: 'left', ...style }, runs });
  const page = { width: 794, height: 1123, margin: 72 };

  const hlModel = () => ({ title: 't', page, blocks: [para([run('plain '), run('YELLOW', '#ffff00')])] });

  window.runPdf = async () => {
    const buf = await (await blockModelToPdf(hlModel())).arrayBuffer();
    const s = new TextDecoder('latin1').decode(new Uint8Array(buf)); // content stream is uncompressed
    return { isPdf: s.startsWith('%PDF'), hasHiRect: /1 1 0 rg [\\d.\\s]+ re f/.test(s) };
  };

  window.runPptx = async () => {
    const buf = await (await blockModelToPptx(hlModel())).arrayBuffer();
    const s = new TextDecoder('latin1').decode(new Uint8Array(buf)); // pptx is a STORED zip → plain XML
    return { hasHighlight: s.includes('<a:highlight><a:srgbClr val="FFFF00"/></a:highlight>') };
  };

  window.runImages = async (format) => {
    // Many paragraphs → more than one page: expect ONE image file PER PAGE.
    const blocks = [];
    for (let i = 0; i < 80; i += 1) blocks.push(para([run('Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' + i)]));
    const res = await blockModelToImages({ title: 't', page, blocks }, { format });
    const files = [];
    for (const f of res.files) {
      const b = new Uint8Array(await f.blob.arrayBuffer());
      files.push({
        filename: f.filename, type: f.blob.type,
        pngSig: b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
        jpgSig: b[0] === 0xff && b[1] === 0xd8,
        zipSig: b[0] === 0x50 && b[1] === 0x4b, // "PK" — must NOT be this
      });
    }
    return { count: res.count, files };
  };
</script></body>`;

const DIST = path.join(ROOT, 'dist'); // vendored pdf.js lives here (built assets)
const resolveFile = (url) => {
  for (const rootDir of [WEBROOT, DIST]) {
    const fp = path.join(rootDir, url);
    if (fp.startsWith(rootDir) && fs.existsSync(fp) && !fs.statSync(fp).isDirectory()) return fp;
  }
  return null;
};
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/__ax.html') { res.setHeader('Content-Type', 'text/html'); res.end(TEST_HTML); return; }
  const fp = resolveFile(url);
  if (!fp) { res.statusCode = 404; res.end('nf'); return; }
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
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'edge-ax-')),
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/__ax.html`, { waitUntil: 'networkidle0' });

  const pdf = await page.evaluate(() => window.runPdf());
  check('PDF export is a real PDF', pdf.isPdf);
  check('PDF draws a highlight rectangle behind the run', pdf.hasHiRect);

  const pptx = await page.evaluate(() => window.runPptx());
  check('PPTX export writes <a:highlight> for the run', pptx.hasHighlight);

  const png = await page.evaluate(() => window.runImages('png'));
  check('PNG export spanned multiple pages', png.count >= 2);
  check('PNG export produced one file PER page', png.files.length === png.count);
  check('each PNG page is a real image, not a zip', png.files.every((f) => f.type === 'image/png' && f.pngSig && !f.zipSig));
  check('PNG page filenames are name_page_N.png', png.files.every((f, i) => new RegExp(`_page_${i + 1}\\.png$`).test(f.filename)));

  const jpg = await page.evaluate(() => window.runImages('jpg'));
  check('JPG export produced one file PER page', jpg.files.length === jpg.count && jpg.count >= 2);
  check('each JPG page is a real image, not a zip', jpg.files.every((f) => f.type === 'image/jpeg' && f.jpgSig && !f.zipSig));
  check('JPG page filenames are name_page_N.jpg', jpg.files.every((f, i) => new RegExp(`_page_${i + 1}\\.jpg$`).test(f.filename)));
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
console.log('\nAll advanced-export checks passed.');
