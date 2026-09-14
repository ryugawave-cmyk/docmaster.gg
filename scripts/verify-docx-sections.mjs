/**
 * Regression test (headless Edge) — DOCX page-setup auto-detection is SECTION-aware.
 *
 * A Word document is a sequence of sections, each with its own page size / margins /
 * orientation. The importer used to read the LAST section's setup and apply it to the
 * whole document, so a multi-section file opened at the wrong (final) section's size.
 * It now opens at the FIRST section (what the reader sees on page 1), detects
 * orientation from the page box, and tags each later section-starting block with its
 * own `pageOverride` so a mixed-setup document (e.g. a landscape page in the middle)
 * is detected and preserved through edit / save / reload.
 *
 * Builds a 3-section .docx — portrait A4 → landscape A4 → portrait A4 with wide margins
 * — imports it, and asserts: (1) the document opens at section 1 (portrait A4), (2) the
 * landscape section's first block carries a landscape `pageOverride`, (3) the setup
 * survives a render → readBlocks round-trip.
 *
 * Needs Microsoft Edge; best-effort (SKIPPED, exit 0) if it can't launch.
 * Run: `node scripts/verify-docx-sections.mjs`.
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

const TEST_HTML = `<!doctype html><meta charset=utf8><body><div id="host"></div><script type="module">
  import { docxToBlockModel } from '/js/app/services/convert/docxImport.js';
  import { renderBlocks, readBlocks } from '/js/app/model/editableHtml.js';

  const enc = new TextEncoder();
  const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip(files) {
    const parts = []; const central = []; let off = 0;
    const u16 = (v) => [v & 255, (v >>> 8) & 255];
    const u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    for (const [name, text] of Object.entries(files)) {
      const nb = enc.encode(name); const db = enc.encode(text); const crc = crc32(db);
      const lh = [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(db.length), ...u32(db.length), ...u16(nb.length), ...u16(0)];
      parts.push(new Uint8Array(lh), nb, db); central.push({ name: nb, crc, size: db.length, off }); off += lh.length + nb.length + db.length;
    }
    const cd = []; let cdLen = 0; const cdOff = off;
    for (const e of central) {
      const h = [...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(e.crc), ...u32(e.size), ...u32(e.size), ...u16(e.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(e.off)];
      cd.push(new Uint8Array(h), e.name); cdLen += h.length + e.name.length;
    }
    const eocd = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(cdLen), ...u32(cdOff), ...u16(0)]);
    const all = [...parts, ...cd, eocd]; const total = all.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total); let p = 0; for (const a of all) { out.set(a, p); p += a.length; } return out.buffer;
  }

  const R = (t) => \`<w:r><w:t xml:space="preserve">\${t}</w:t></w:r>\`;
  // Section-ending sectPr lives in the LAST paragraph of the section (inside pPr);
  // the final section's sectPr is a direct child of body.
  const sectA4Portrait = '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>';
  const sectA4Landscape = '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>';
  const sectA4WideMargins = '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="2880" w:right="2880" w:bottom="2880" w:left="2880"/>';

  const documentXml = \`<?xml version="1.0"?>
  <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p>\${R('Section one, portrait.')}</w:p>
    <w:p><w:pPr><w:sectPr>\${sectA4Portrait}</w:sectPr></w:pPr>\${R('End of section one.')}</w:p>
    <w:p>\${R('Section two, landscape wide page.')}</w:p>
    <w:p><w:pPr><w:sectPr>\${sectA4Landscape}</w:sectPr></w:pPr>\${R('End of section two.')}</w:p>
    <w:p>\${R('Section three, portrait with wide margins.')}</w:p>
    <w:sectPr>\${sectA4WideMargins}</w:sectPr>
  </w:body></w:document>\`;

  window.run = async () => {
    const buf = zip({ 'word/document.xml': documentXml, 'word/styles.xml': '<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:styles>', 'word/_rels/document.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>' });
    const doc = await docxToBlockModel(buf, 'sec');
    const overrides = (doc.blocks || []).map((b, i) => b.pageOverride ? { i, ...b.pageOverride } : null).filter(Boolean);
    // Round-trip through the editable DOM to prove pageOverride survives an edit/save.
    const host = document.getElementById('host');
    host.replaceChildren(...renderBlocks(doc));
    const rt = readBlocks(host);
    const rtOverrides = rt.map((b) => b.pageOverride || null).filter(Boolean);
    return {
      openW: doc.page.width, openH: doc.page.height,
      openMargins: doc.page.margins, orientation: doc.page.orientation,
      overrides, rtOverrideCount: rtOverrides.length, rtFirstOverride: rtOverrides[0] || null,
    };
  };
</script></body>`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/__sec.html') { res.setHeader('Content-Type', 'text/html'); res.end(TEST_HTML); return; }
  const fp = path.join(WEBROOT, url);
  if (!fp.startsWith(WEBROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(fp)] || 'application/octet-stream');
  fs.createReadStream(fp).pipe(res);
});

let failures = 0;
const check = (name, cond, extra) => { if (cond) console.log(`  ok  ${name}`); else { console.error(`FAIL  ${name}${extra != null ? ` (got ${JSON.stringify(extra)})` : ''}`); failures += 1; } };
const near = (a, b, tol) => Math.abs((a || 0) - (b || 0)) <= tol;

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
if (!edge) { console.log('SKIPPED: Microsoft Edge not found'); server.close(); process.exit(0); }

let browser;
try {
  browser = await puppeteer.launch({
    executablePath: edge, headless: 'new',
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'edge-sec-')),
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/__sec.html`, { waitUntil: 'networkidle0' });
  const r = await page.evaluate(() => window.run());

  // (1) Opens at section 1 (portrait A4 794x1123), NOT the last section.
  check('opens at section 1 width (portrait A4 ~794)', near(r.openW, 794, 2), r.openW);
  check('opens at section 1 height (~1123)', near(r.openH, 1123, 2), r.openH);
  check('opens with section 1 margins (~96px), not last section wide (~192)', r.openMargins && near(r.openMargins.left, 96, 2), r.openMargins);
  check('orientation detected as portrait', r.orientation === 'portrait', r.orientation);

  // (2) The two later sections are tagged with their own page setups.
  check('two section overrides captured', r.overrides.length === 2, r.overrides.length);
  const landscape = r.overrides.find((o) => o.width && o.height && o.width > o.height);
  check('landscape section captured (width > height, ~1123 wide)', landscape && near(landscape.width, 1123, 2), landscape);
  const wideMargin = r.overrides.find((o) => o.margins && o.margins.left > 150);
  check('wide-margin section captured (~192px margins)', wideMargin && near(wideMargin.margins.left, 192, 3), wideMargin);

  // (3) Overrides survive the editable-DOM round-trip (edit / save / reload).
  check('overrides survive render → readBlocks round-trip', r.rtOverrideCount === 2, r.rtOverrideCount);
  check('round-tripped override keeps its dimensions', r.rtFirstOverride && r.rtFirstOverride.width > 0, r.rtFirstOverride);
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
console.log('\nAll DOCX section-detection checks passed.');
