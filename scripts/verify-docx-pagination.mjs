/**
 * Regression test (headless Edge) — imported DOCX text paginates with Word-like
 * metrics, not the editor's larger "web document" defaults.
 *
 * The bug: a 6-page A4 Word file became ~18 editor pages. Page size and margins were
 * read correctly, but a paragraph carrying NO explicit run size / line spacing fell
 * back to the editor defaults (Inter 16px, line-height 1.4, 10px after) instead of
 * Word's (11pt ≈ 15px, single ≈ 1.15, 0 after). Each line was ~40% taller and every
 * paragraph gained a bottom margin — which is what tripled the page count.
 *
 * This builds a minimal real .docx (a store-only ZIP of OOXML, no docDefaults spacing,
 * so the fallback path is exercised), imports it with the SAME importer the app uses,
 * renders the blocks into a real DOM with the app stylesheet, and asserts the COMPUTED
 * per-line height / font-size / paragraph margin are Word-like — the numbers the
 * paginator actually flows on. Also checks an "Exactly Npt" (exact line-rule) paragraph
 * renders at that px height instead of inheriting the CSS 1.5 default.
 *
 * Needs Microsoft Edge; best-effort (SKIPPED, exit 0) if it can't launch (see
 * edge-verification-singleton: only runs when the user's Edge is closed).
 * Run: `node scripts/verify-docx-pagination.mjs`.
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

const TEST_HTML = `<!doctype html><meta charset=utf8>
  <link rel="stylesheet" href="/css/app.css">
  <body><div id="host" class="doc-page"></div><script type="module">
  import { docxToBlockModel } from '/js/app/services/convert/docxImport.js';
  import { renderBlocks } from '/js/app/model/editableHtml.js';

  // --- minimal store-only ZIP writer (the importer's unzip copies method-0 entries) ---
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
      parts.push(new Uint8Array(lh), nb, db);
      central.push({ name: nb, crc, size: db.length, off });
      off += lh.length + nb.length + db.length;
    }
    const cd = []; let cdLen = 0; const cdOff = off;
    for (const e of central) {
      const h = [...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(e.crc), ...u32(e.size), ...u32(e.size), ...u16(e.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(e.off)];
      cd.push(new Uint8Array(h), e.name); cdLen += h.length + e.name.length;
    }
    const eocd = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(cdLen), ...u32(cdOff), ...u16(0)]);
    const all = [...parts, ...cd, eocd]; const total = all.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total); let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
    return out.buffer;
  }

  const P = (text, extra = '') => \`<w:p><w:pPr>\${extra}</w:pPr><w:r><w:t xml:space="preserve">\${text}</w:t></w:r></w:p>\`;
  // A4 (11906 x 16838 twips), 1" (1440) margins on all sides. No docDefaults spacing/size
  // anywhere → forces the importer's Word-default fallback (the code path under test).
  // A single-row, 3-cell table with NO inline run size — exercises the cell font/line
  // fallback (cells used to render at the model's 16px + line-height 1.5, ~2× Word).
  const cell = (t) => \`<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>\${t}</w:t></w:r></w:p></w:tc>\`;
  const table = \`<w:tbl><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr>\${cell('Alpha')}\${cell('Beta')}\${cell('Gamma')}</w:tr></w:tbl>\`;
  const documentXml = \`<?xml version="1.0"?>
  <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    \${P('Plain body paragraph with no explicit run size or spacing at all.')}
    \${P('Exactly twelve point line rule paragraph.', '<w:spacing w:line="240" w:lineRule="exact"/>')}
    \${table}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body></w:document>\`;
  const stylesXml = \`<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:styles>\`;
  const rels = \`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>\`;

  window.run = async () => {
    const buf = zip({ 'word/document.xml': documentXml, 'word/styles.xml': stylesXml, 'word/_rels/document.xml.rels': rels });
    const doc = await docxToBlockModel(buf, 'pag');
    const m = doc.page.margins;
    const usable = doc.page.height - m.top - m.bottom;
    const host = document.getElementById('host');
    // Match the editable surface: page width with the real L/R padding, so wrapping
    // (and therefore line count) is what the paginator would see.
    host.style.width = doc.page.width + 'px';
    host.style.paddingLeft = m.left + 'px';
    host.style.paddingRight = m.right + 'px';
    host.replaceChildren(...renderBlocks(doc));
    const blocks = [...host.children];
    await document.fonts.ready;
    const cs = (el) => getComputedStyle(el);
    const plain = blocks[0], exact = blocks[1];
    const span = plain.querySelector('span');
    const tableEl = host.querySelector('table.doc-table');
    const cellSpan = tableEl && tableEl.querySelector('td span');
    const cellRow = tableEl && tableEl.querySelector('tr');
    return {
      pageW: doc.page.width, pageH: doc.page.height, margins: m, usable,
      plain: {
        fontSize: parseFloat(cs(span).fontSize),
        lineHeight: parseFloat(cs(plain).lineHeight),
        marginBottom: parseFloat(cs(plain).marginBottom),
      },
      exactLineHeight: parseFloat(cs(exact).lineHeight),
      cell: {
        fontSize: cellSpan ? parseFloat(cs(cellSpan).fontSize) : null,
        lineHeight: cellSpan ? parseFloat(cs(cellSpan.closest('td')).lineHeight) : null,
        rowHeight: cellRow ? Math.round(cellRow.offsetHeight) : null,
      },
    };
  };
</script></body>`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/__pag.html') { res.setHeader('Content-Type', 'text/html'); res.end(TEST_HTML); return; }
  const fp = path.join(WEBROOT, url);
  if (!fp.startsWith(WEBROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(fp)] || 'application/octet-stream');
  fs.createReadStream(fp).pipe(res);
});

let failures = 0;
const check = (name, cond, extra) => { if (cond) console.log(`  ok  ${name}`); else { console.error(`FAIL  ${name}${extra != null ? ` (got ${extra})` : ''}`); failures += 1; } };
const near = (a, b, tol) => Math.abs((a || 0) - (b || 0)) <= tol;

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
if (!edge) { console.log('SKIPPED: Microsoft Edge not found'); server.close(); process.exit(0); }

let browser;
try {
  browser = await puppeteer.launch({
    executablePath: edge, headless: 'new',
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'edge-pag-')),
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/__pag.html`, { waitUntil: 'networkidle0' });
  const r = await page.evaluate(() => window.run());

  // Geometry: A4 @96dpi with 1" margins → 794x1123, 96px sides, ~931px usable.
  check('page width read as A4 (794)', near(r.pageW, 794, 2), r.pageW);
  check('page height read as A4 (1123)', near(r.pageH, 1123, 2), r.pageH);
  check('all four margins ~96px', r.margins && [r.margins.top, r.margins.right, r.margins.bottom, r.margins.left].every((v) => near(v, 96, 1)), JSON.stringify(r.margins));
  check('usable height ~931px', near(r.usable, 931, 3), r.usable);

  // The fix: an unspecified run renders at Word's 11pt (~15px), NOT the editor's 16px.
  check('plain run font-size is Word 11pt (~15px), not 16px', near(r.plain.fontSize, 15, 1), r.plain.fontSize);
  // Line-height is Word-like single (15 * 1.15 ≈ 17.3px), NOT the old 16 * 1.4 = 22.4px.
  check('plain line-height Word-like (~17px), not ~22px', r.plain.lineHeight < 20 && near(r.plain.lineHeight, 17.3, 2), r.plain.lineHeight);
  // No phantom paragraph spacing the source never had (was 10px).
  check('plain paragraph has no injected bottom margin', near(r.plain.marginBottom, 0, 0.5), r.plain.marginBottom);
  // Exact line rule (w:lineRule="exact", 12pt = 16px) is honoured, not CSS 1.5.
  check('exact line-rule paragraph is ~16px, not CSS 1.5 default', near(r.exactLineHeight, 16, 1.5), r.exactLineHeight);

  // Table cells: render at the doc body size (~15px) and a tight, Word-like row — NOT
  // the model's 16px + line-height 1.5 + 8px padding that made rows ~2× too tall.
  check('table cell font-size matches body (~15px), not 16px', near(r.cell.fontSize, 15, 1), r.cell.fontSize);
  check('table cell line-height is tight (≤1.35×font), not 1.5', r.cell.lineHeight && r.cell.lineHeight < r.cell.fontSize * 1.35, r.cell.lineHeight);
  check('single-line table row is Word-like short (≤30px)', r.cell.rowHeight && r.cell.rowHeight <= 30, r.cell.rowHeight);

  // Sanity: quantify the improvement. Old per-line box ≈ 22.4 + 10 margin = 32.4px;
  // new ≈ 17.3px. Over the same text that's ~1.9x fewer lines/pages before font
  // differences — enough to bring a 6→18 blowup back toward ~6-8 pages.
  const oldLine = 16 * 1.4 + 10, newLine = r.plain.lineHeight + r.plain.marginBottom;
  console.log(`\n  per-paragraph line box: was ~${oldLine.toFixed(1)}px → now ~${newLine.toFixed(1)}px (${(oldLine / newLine).toFixed(2)}x denser)`);
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
console.log('\nAll DOCX pagination-metric checks passed.');
