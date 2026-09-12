/**
 * Regression test — Quick Export of a POSITIONED (exact-layout) document.
 *
 * A PDF brought into the Document editor via "Transfer to Doc" is a positioned model
 * (doc.layout==='positioned', per-page raster in doc.pages[].bg, one `posbox` block
 * per line). Quick Export (blockModelToDocx) must NOT flatten it into a stacked
 * column — it must produce a .docx that looks like the original page: each page a
 * full-page raster picture with every line laid on top as an editable, mask-filled
 * text box. This drives the REAL positionedModelToDocx and asserts that structure.
 *
 * Run: `node scripts/verify-positioned-docx.mjs`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docmaster-posdocx-'));
fs.cpSync(path.join(ROOT, 'public/js/app'), path.join(tmp, 'app'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

// blockModelToDocx is the Quick Export entry point; it must route positioned docs to
// the exact-layout exporter. Import IT (not positionedModelToDocx directly) so the
// routing itself is covered.
const { blockModelToDocx } = await import(pathToFileURL(path.join(tmp, 'app/services/convert/blockExport.js')).href);

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok  ${name}`); else { console.error(`FAIL  ${name}`); failures += 1; } };

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const doc = {
  layout: 'positioned',
  page: { width: 794, height: 1123, margin: 0 },
  pages: [
    { bg: PNG, width: 794, height: 1123 },
    { bg: PNG, width: 794, height: 1123 },
  ],
  blocks: [
    { type: 'posbox', page: 0, frame: { x: 100, y: 80, w: 400, h: 24 }, style: { align: 'center' }, fill: '#ffffff',
      runs: [{ text: 'RAILWAY RECRUITMENT BOARD', marks: { fontSize: 16, bold: true, color: '#111111', fontFamily: 'Arial' } }] },
    { type: 'posbox', page: 1, frame: { x: 100, y: 80, w: 400, h: 20 }, style: { align: 'left' }, fill: '#eeeeee',
      runs: [{ text: 'Registration No : L72511691071', marks: { fontSize: 12, color: '#111111', fontFamily: 'Arial' } }] },
  ],
};

const blob = await blockModelToDocx(doc);
const buf = Buffer.from(await blob.arrayBuffer());
const s = buf.toString('latin1');

check('is a Word .docx blob', blob.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
check('is a zip (PK header)', buf[0] === 0x50 && buf[1] === 0x4b);
check('has document.xml', s.includes('word/document.xml'));
check('embeds a page raster image', s.includes('word/media/image1'));
check('lays the raster as a picture', s.includes('pic:pic'));
check('raster sits BEHIND the text', s.includes('behindDoc="1"'));
check('emits editable wps text boxes', s.includes('wps:wsp'));
check('keeps the real text', s.includes('RAILWAY RECRUITMENT BOARD') && s.includes('Registration No : L72511691071'));
check('masks with the sampled fill', s.includes('srgbClr val="ffffff"') && s.includes('srgbClr val="eeeeee"'));
// Two PDF pages → two Word sections (page breaks), so the layout doesn't collapse to one page.
check('one section per page (2 pages)', (s.match(/<w:sectPr>/g) || []).length === 2);
check('embeds the raster once per page (2 images)', s.includes('word/media/image2'));
// It must NOT have gone through the flow exporter (which would emit flowing paragraphs
// with body margins and no anchored raster).
check('did NOT flatten to a flow body', !s.includes('w:pgMar w:top="1440"'));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll positioned-docx export checks passed.');
