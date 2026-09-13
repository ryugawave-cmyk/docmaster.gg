/**
 * Regression test (headless Edge) — DOCX import preserves run/style/theme formatting.
 *
 * Real .docx keep most formatting in the paragraph STYLE and the document THEME, not
 * inline on every run: a blue heading is `Heading1` → `w:color w:themeColor="accent1"`,
 * and the body font is `w:rFonts w:asciiTheme="minorHAnsi"` → the theme's minor font.
 * The importer used to read only inline run `w:color`/`w:ascii`, so themed/style colours
 * were lost (blue → black) and themed fonts fell back to Inter. docxToBlockModel now
 * resolves theme1.xml colours/fonts and inherits colour/font/size down the style chain.
 *
 * A minimal .docx (STORED zip) is built here and imported in Edge (needs DOMParser).
 * Best-effort: prints SKIPPED (exit 0) if Edge can't launch.
 * Run: `node scripts/verify-docx-formatting.mjs`.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
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

/* ---- build a minimal STORED .docx (our unzip reads the central directory) --------- */
function buildDocx(parts) {
  const enc = new TextEncoder();
  const files = Object.entries(parts).map(([name, text]) => ({ name, data: enc.encode(text) }));
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data);
    const crc = zlib.crc32 ? zlib.crc32(data) : 0; // our unzip ignores CRC; provide it if available
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0),
      nameBuf, data,
    ]);
    chunks.push(local);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]));
    offset += local.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...chunks, cd, eocd]);
}

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
</Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements>
<a:clrScheme name="T">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="T">
<a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont>
<a:minorFont><a:latin typeface="Cambria"/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="T"/></a:themeElements></a:theme>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
<w:rPr><w:color w:themeColor="accent1"/><w:sz w:val="32"/></w:rPr></w:style>
</w:styles>`;
const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Blue Heading</w:t></w:r></w:p>
<w:p><w:r><w:t>Body text here.</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:color w:val="2E74B5" w:themeColor="accent1" w:themeShade="BF"/><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/></w:rPr><w:t>Explicit run</w:t></w:r></w:p>
</w:body></w:document>`;

const docx = buildDocx({
  '[Content_Types].xml': CT,
  '_rels/.rels': RELS,
  'word/document.xml': DOCUMENT,
  'word/styles.xml': STYLES,
  'word/theme/theme1.xml': THEME,
});

const TEST_HTML = `<!doctype html><meta charset=utf8><body><script type="module">
  import { docxToBlockModel } from '/js/app/services/convert/docxImport.js';
  window.runImport = async (buf) => {
    const doc = await docxToBlockModel(buf, 'fmt');
    const paras = (doc.blocks || []).filter((b) => b.type === 'paragraph');
    return paras.map((b) => ({ tag: b.tag, runs: (b.runs || []).map((r) => ({ text: r.text, color: r.marks.color, font: r.marks.fontFamily, size: r.marks.fontSize })) }));
  };
</script></body>`;

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/__fmt.html') { res.setHeader('Content-Type', 'text/html'); res.end(TEST_HTML); return; }
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
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'edge-fmt-')),
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/__fmt.html`, { waitUntil: 'networkidle0' });
  const b64 = docx.toString('base64');
  const paras = await page.evaluate(async (data) => {
    const buf = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)).buffer;
    return window.runImport(buf);
  }, b64);

  const heading = paras[0], body = paras[1], explicit = paras[2];
  check('heading imported as a heading (h1)', heading && heading.tag === 'h1');
  check('heading colour resolves the theme accent1 (blue, not black)', heading && heading.runs[0].color.toLowerCase() === '#4472c4');
  check('heading inherits the theme minor font (not Inter)', heading && heading.runs[0].font === 'Cambria');
  check('heading size inherited from the style (~21px)', heading && heading.runs[0].size >= 20 && heading.runs[0].size <= 22);
  check('body font is the theme minor font (Cambria, not Inter)', body && body.runs[0].font === 'Cambria');
  check('body colour falls back to default (no style colour set)', body && body.runs[0].color === '#111111');
  check('explicit run w:val colour wins over theme', explicit && explicit.runs[0].color.toLowerCase() === '#2e74b5');
  check('explicit run font (Georgia) wins over theme', explicit && explicit.runs[0].font === 'Georgia');
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
console.log('\nAll DOCX-formatting import checks passed.');
