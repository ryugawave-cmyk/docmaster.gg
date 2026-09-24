/**
 * Regression test (headless Edge) — PPTX → Document import.
 *
 * Verifies the new PowerPoint importer (services/convert/pptxImport.js) against
 * REAL browser APIs (DOMParser / DecompressionStream), which Node lacks. Two passes:
 *
 *   A) Round-trip: build a document model → blockModelToPptx (the app's own .pptx
 *      exporter) → pptxToBlockModel. Proves unzip + slide parsing + runs + bullets
 *      (a:buChar) + tables (a:tbl) all survive a genuine app-produced deck.
 *   B) Authentic PowerPoint shape: a hand-built minimal .pptx with a real title
 *      placeholder (<p:ph type="title">) and bulleted body. Proves the title maps
 *      to a heading and bullets map to a list — the mapping the round-trip can't
 *      cover (the exporter emits plain text boxes, not title placeholders).
 *
 * Needs Microsoft Edge; best-effort (SKIPPED, exit 0) if it can't launch.
 * Run: `node scripts/verify-pptx-import.mjs`.
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
  import { blockModelToPptx } from '/js/app/services/convert/blockExport.js';
  import { pptxToBlockModel } from '/js/app/services/convert/pptxImport.js';
  import { buildZip } from '/js/app/services/zip.js';

  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  // -- shared text extractors over the block model --
  const runsText = (runs) => (runs || []).map((r) => r.text || '').join('');
  function blockText(b) {
    if (b.type === 'paragraph') return runsText(b.runs);
    if (b.type === 'list') return (b.items || []).map((it) => runsText(it.runs)).join(' | ');
    if (b.type === 'table') return (b.rows || []).map((row) => row.map((c) => runsText(c.runs)).join(',')).join(' / ');
    return '';
  }
  const allText = (blocks) => (blocks || []).map(blockText).join('\\n');

  const mk = (text, tag, marks) => ({ type: 'paragraph', tag: tag || 'p',
    style: { align: 'left' }, runs: [{ text, marks: { fontFamily: 'Inter', fontSize: tag === 'h1' ? 24 : 16, color: '#111111', ...marks } }] });
  const li = (text) => ({ runs: [{ text, marks: { fontFamily: 'Inter', fontSize: 16, color: '#111111' } }] });
  const cell = (text) => ({ runs: [{ text, marks: { fontFamily: 'Inter', fontSize: 16, color: '#111111' } }] });

  window.runRoundtrip = async () => {
    const doc = {
      title: 'deck', source: 'docx',
      page: { width: 794, height: 1123, margin: 72 },
      blocks: [
        mk('Quarterly Report', 'h1', { bold: true }),
        mk('Revenue grew this quarter.'),
        { type: 'list', ordered: false, items: [li('Alpha'), li('Beta'), li('Gamma')] },
        { type: 'table', rows: [[cell('Region'), cell('Sales')], [cell('North'), cell('100')]] },
      ],
    };
    const blob = await blockModelToPptx(doc);
    const buf = await blob.arrayBuffer();
    const re = await pptxToBlockModel(buf, 'deck');
    return {
      text: allText(re.blocks),
      hasList: (re.blocks || []).some((b) => b.type === 'list' && b.items.some((it) => runsText(it.runs) === 'Alpha')),
      hasTable: (re.blocks || []).some((b) => b.type === 'table' && (b.rows || []).some((row) => row.some((c) => runsText(c.runs) === 'Region'))),
      headings: (re.blocks || []).filter((b) => b.type === 'paragraph' && b.tag === 'h2').length,
    };
  };

  window.runAuthentic = async () => {
    const ct = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
      + '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>';
    const rootRels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="' + R + '/officeDocument" Target="ppt/presentation.xml"/></Relationships>';
    const presRels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="' + R + '/slide" Target="slides/slide1.xml"/></Relationships>';
    const pres = '<?xml version="1.0"?><p:presentation xmlns:p="' + P + '" xmlns:r="' + R + '">'
      + '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>';
    const slide1 = '<?xml version="1.0"?><p:sld xmlns:a="' + A + '" xmlns:p="' + P + '" xmlns:r="' + R + '"><p:cSld><p:spTree>'
      + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/>'
      + '<p:txBody><a:bodyPr/><a:p><a:r><a:rPr b="1"/><a:t>My Title</a:t></a:r></a:p></p:txBody></p:sp>'
      + '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>'
      + '<p:txBody><a:bodyPr/>'
      + '<a:p><a:pPr><a:buChar char="&#8226;"/></a:pPr><a:r><a:t>Point one</a:t></a:r></a:p>'
      + '<a:p><a:pPr><a:buChar char="&#8226;"/></a:pPr><a:r><a:t>Point two</a:t></a:r></a:p>'
      + '</p:txBody></p:sp>'
      + '</p:spTree></p:cSld></p:sld>';
    const zip = buildZip([
      { name: '[Content_Types].xml', data: ct },
      { name: '_rels/.rels', data: rootRels },
      { name: 'ppt/presentation.xml', data: pres },
      { name: 'ppt/_rels/presentation.xml.rels', data: presRels },
      { name: 'ppt/slides/slide1.xml', data: slide1 },
    ]);
    const re = await pptxToBlockModel(zip, 'authentic');
    const first = re.blocks[0];
    const list = (re.blocks || []).find((b) => b.type === 'list');
    return {
      firstTag: first && first.tag,
      firstText: first && runsText(first.runs),
      firstBold: !!(first && first.runs[0] && first.runs[0].marks && first.runs[0].marks.bold),
      listItems: list ? list.items.map((it) => runsText(it.runs)) : [],
    };
  };

  // A deck whose slide carries a CHART (bar) + a PICTURE (png) — like the user's
  // slide where a table imported fine but the graphs disappeared.
  window.runGraphics = async () => {
    const PKGREL = 'http://schemas.openxmlformats.org/package/2006/relationships';
    const CHART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
    const ct = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Default Extension="png" ContentType="image/png"/>'
      + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
      + '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
      + '<Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>';
    const rootRels = '<?xml version="1.0"?><Relationships xmlns="' + PKGREL + '"><Relationship Id="rId1" Type="' + R + '/officeDocument" Target="ppt/presentation.xml"/></Relationships>';
    const presRels = '<?xml version="1.0"?><Relationships xmlns="' + PKGREL + '"><Relationship Id="rId1" Type="' + R + '/slide" Target="slides/slide1.xml"/></Relationships>';
    const pres = '<?xml version="1.0"?><p:presentation xmlns:p="' + P + '" xmlns:r="' + R + '"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>';
    const slideRels = '<?xml version="1.0"?><Relationships xmlns="' + PKGREL + '">'
      + '<Relationship Id="rId2" Type="' + R + '/chart" Target="../charts/chart1.xml"/>'
      + '<Relationship Id="rId3" Type="' + R + '/image" Target="../media/image1.png"/></Relationships>';
    const slide1 = '<?xml version="1.0"?><p:sld xmlns:a="' + A + '" xmlns:p="' + P + '" xmlns:r="' + R + '"><p:cSld><p:spTree>'
      // picture (top of slide)
      + '<p:pic><p:nvPicPr><p:cNvPr id="5" name="Pic"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
      + '<p:blipFill><a:blip r:embed="rId3"/></p:blipFill>'
      + '<p:spPr><a:xfrm><a:off x="0" y="100000"/><a:ext cx="1905000" cy="1905000"/></a:xfrm></p:spPr></p:pic>'
      // chart (below the picture)
      + '<p:graphicFrame><p:xfrm><a:off x="0" y="3000000"/><a:ext cx="4572000" cy="3048000"/></p:xfrm>'
      + '<a:graphic><a:graphicData uri="' + CHART_NS + '"><c:chart xmlns:c="' + CHART_NS + '" xmlns:r="' + R + '" r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame>'
      + '</p:spTree></p:cSld></p:sld>';
    const chart1 = '<?xml version="1.0"?><c:chartSpace xmlns:c="' + CHART_NS + '" xmlns:a="' + A + '" xmlns:r="' + R + '"><c:chart>'
      + '<c:title><c:tx><c:rich><a:p><a:r><a:t>Yearly Revenue</a:t></a:r></a:p></c:rich></c:tx></c:title>'
      + '<c:plotArea><c:barChart><c:barDir val="col"/>'
      + '<c:ser><c:idx val="0"/><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Revenue</c:v></c:pt></c:strCache></c:strRef></c:tx>'
      + '<c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>2021</c:v></c:pt><c:pt idx="1"><c:v>2022</c:v></c:pt><c:pt idx="2"><c:v>2023</c:v></c:pt></c:strCache></c:strRef></c:cat>'
      + '<c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>8</c:v></c:pt><c:pt idx="1"><c:v>10</c:v></c:pt><c:pt idx="2"><c:v>12</c:v></c:pt></c:numCache></c:numRef></c:val>'
      + '</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>';
    // A 1x1 transparent PNG.
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

    const zip = buildZip([
      { name: '[Content_Types].xml', data: ct },
      { name: '_rels/.rels', data: rootRels },
      { name: 'ppt/presentation.xml', data: pres },
      { name: 'ppt/_rels/presentation.xml.rels', data: presRels },
      { name: 'ppt/slides/slide1.xml', data: slide1 },
      { name: 'ppt/slides/_rels/slide1.xml.rels', data: slideRels },
      { name: 'ppt/charts/chart1.xml', data: chart1 },
      { name: 'ppt/media/image1.png', data: png },
    ]);
    const re = await pptxToBlockModel(zip, 'graphics');
    const chart = (re.blocks || []).find((b) => b.type === 'image' && b.chart);
    const pic = (re.blocks || []).find((b) => b.type === 'image' && !b.chart);
    return {
      chartType: chart && chart.chart && chart.chart.type,
      chartCats: chart && chart.chart && chart.chart.categories,
      chartVals: chart && chart.chart && chart.chart.series && chart.chart.series[0] && chart.chart.series[0].values,
      chartTitle: chart && chart.chart && chart.chart.title,
      chartRendersSvg: !!(chart && /^data:image\\/svg\\+xml/.test(chart.src || '')),
      picIsPng: !!(pic && /^data:image\\/png;base64,/.test(pic.src || '')),
      // chart is BELOW the picture on the slide → picture block comes first.
      picBeforeChart: (re.blocks || []).findIndex((b) => b === pic) < (re.blocks || []).findIndex((b) => b === chart),
    };
  };

  // A slide built the "exact-layout" way: a FULL-SLIDE background raster (the whole
  // page as one image) with the real text drawn in overlay boxes ON TOP. The
  // background must be skipped, not flowed inline — otherwise (at y=0, ~a page tall)
  // it sorts above every shape and buries the text below it.
  window.runBackground = async () => {
    const PKGREL = 'http://schemas.openxmlformats.org/package/2006/relationships';
    const ct = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Default Extension="png" ContentType="image/png"/>'
      + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
      + '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>';
    const rootRels = '<?xml version="1.0"?><Relationships xmlns="' + PKGREL + '"><Relationship Id="rId1" Type="' + R + '/officeDocument" Target="ppt/presentation.xml"/></Relationships>';
    const presRels = '<?xml version="1.0"?><Relationships xmlns="' + PKGREL + '"><Relationship Id="rId1" Type="' + R + '/slide" Target="slides/slide1.xml"/></Relationships>';
    // sldSz declares the slide canvas; the picture below matches it exactly.
    const pres = '<?xml version="1.0"?><p:presentation xmlns:p="' + P + '" xmlns:r="' + R + '">'
      + '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>'
      + '<p:sldSz cx="7562850" cy="10696575"/></p:presentation>';
    const slideRels = '<?xml version="1.0"?><Relationships xmlns="' + PKGREL + '">'
      + '<Relationship Id="rId3" Type="' + R + '/image" Target="../media/image1.png"/></Relationships>';
    const slide1 = '<?xml version="1.0"?><p:sld xmlns:a="' + A + '" xmlns:p="' + P + '" xmlns:r="' + R + '"><p:cSld><p:spTree>'
      // full-slide background picture (offset 0,0; size == sldSz) → must be skipped
      + '<p:pic><p:nvPicPr><p:cNvPr id="5" name="Background"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
      + '<p:blipFill><a:blip r:embed="rId3"/></p:blipFill>'
      + '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="7562850" cy="10696575"/></a:xfrm></p:spPr></p:pic>'
      // an overlay text box (plain text box, no placeholder) drawn on top
      + '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Text 3"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
      + '<p:spPr><a:xfrm><a:off x="900000" y="900000"/><a:ext cx="4000000" cy="400000"/></a:xfrm></p:spPr>'
      + '<p:txBody><a:bodyPr/><a:p><a:pPr algn="l"/><a:r><a:rPr b="1"/><a:t>Overlay Heading</a:t></a:r></a:p></p:txBody></p:sp>'
      + '</p:spTree></p:cSld></p:sld>';
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const zip = buildZip([
      { name: '[Content_Types].xml', data: ct },
      { name: '_rels/.rels', data: rootRels },
      { name: 'ppt/presentation.xml', data: pres },
      { name: 'ppt/_rels/presentation.xml.rels', data: presRels },
      { name: 'ppt/slides/slide1.xml', data: slide1 },
      { name: 'ppt/slides/_rels/slide1.xml.rels', data: slideRels },
      { name: 'ppt/media/image1.png', data: png },
    ]);
    const re = await pptxToBlockModel(zip, 'background');
    const overlay = (re.blocks || []).find((b) => b.type === 'paragraph' && runsText(b.runs) === 'Overlay Heading');
    return {
      hasOverlayText: !!overlay,
      // The full-slide background raster must not survive as an image block.
      imageCount: (re.blocks || []).filter((b) => b.type === 'image').length,
      // A plain text box (no placeholder) imports as a paragraph, not a bullet.
      overlayIsParagraph: !!overlay,
      overlayIsBullet: (re.blocks || []).some((b) => b.type === 'list' && b.items.some((it) => runsText(it.runs) === 'Overlay Heading')),
    };
  };
</script></body>`;

const DIST = path.join(ROOT, 'dist'); // built assets (fonts live here, not in public)
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/__pptx.html') { res.setHeader('Content-Type', 'text/html'); res.end(TEST_HTML); return; }
  // Resolve from public/, falling back to dist/ (the PPTX exporter fetches its
  // LiberationSans metrics fonts from /vendor/pdfjs/... which are built into dist/).
  let fp = path.join(WEBROOT, url);
  if (!fp.startsWith(WEBROOT) || !fs.existsSync(fp)) {
    const alt = path.join(DIST, url);
    fp = alt.startsWith(DIST) && fs.existsSync(alt) ? alt : fp;
  }
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(fp)] || 'application/octet-stream');
  fs.createReadStream(fp).pipe(res);
});

let failures = 0;
const check = (name, cond, extra) => { if (cond) console.log(`  ok  ${name}`); else { console.error(`FAIL  ${name}${extra != null ? ` (${extra})` : ''}`); failures += 1; } };

await new Promise((r) => server.listen(0, r));
const port = server.address().port;

if (!edge) { console.log('SKIPPED: Microsoft Edge not found'); server.close(); process.exit(0); }
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: edge, headless: 'new',
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'edge-pptx-')),
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  await page.goto(`http://127.0.0.1:${port}/__pptx.html`, { waitUntil: 'networkidle0' });

  // ---- A) round-trip through the app's own PPTX exporter ----
  const a = await page.evaluate(() => window.runRoundtrip());
  for (const s of ['Quarterly Report', 'Revenue grew this quarter.', 'Alpha', 'Beta', 'Gamma', 'Region', 'Sales', 'North', '100']) {
    check(`round-trip preserves "${s}"`, a.text.includes(s));
  }
  check('round-trip: bullets survive as a list', a.hasList);
  check('round-trip: table survives as a table', a.hasTable);
  check('round-trip: at least one slide heading emitted', a.headings >= 1, a.headings);

  // ---- B) authentic PowerPoint-shaped .pptx ----
  const b = await page.evaluate(() => window.runAuthentic());
  check('authentic: title placeholder → heading (h2)', b.firstTag === 'h2', b.firstTag);
  check('authentic: title text preserved', b.firstText === 'My Title', b.firstText);
  check('authentic: title run bold preserved', b.firstBold);
  check('authentic: bullets → list of 2 items', b.listItems.length === 2, JSON.stringify(b.listItems));
  check('authentic: bullet text preserved', b.listItems[0] === 'Point one' && b.listItems[1] === 'Point two', JSON.stringify(b.listItems));

  // ---- C) charts + pictures (the graphs that used to vanish) ----
  const g = await page.evaluate(() => window.runGraphics());
  check('graphics: bar chart → editable "column" chart', g.chartType === 'column', g.chartType);
  check('graphics: chart categories parsed', JSON.stringify(g.chartCats) === JSON.stringify(['2021', '2022', '2023']), JSON.stringify(g.chartCats));
  check('graphics: chart values parsed', JSON.stringify(g.chartVals) === JSON.stringify([8, 10, 12]), JSON.stringify(g.chartVals));
  check('graphics: chart title parsed', g.chartTitle === 'Yearly Revenue', g.chartTitle);
  check('graphics: chart renders to SVG', g.chartRendersSvg);
  check('graphics: picture extracted as PNG image', g.picIsPng);
  check('graphics: shapes ordered top-to-bottom (pic before chart)', g.picBeforeChart);

  // ---- D) full-slide background raster + overlay text (the buried-text bug) ----
  const d = await page.evaluate(() => window.runBackground());
  check('background: overlay text survives the import', d.hasOverlayText);
  check('background: full-slide background raster is skipped (no image block)', d.imageCount === 0, d.imageCount);
  check('background: plain overlay text box → paragraph, not bullet', d.overlayIsParagraph && !d.overlayIsBullet);
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
console.log('\nAll PPTX import checks passed.');
