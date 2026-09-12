/**
 * Regression test — Quick Export of a POSITIONED (exact-layout) document.
 *
 * A PDF brought into the Document editor via "Transfer to Doc" is a positioned model
 * (doc.layout==='positioned', per-page raster in doc.pages[].bg, one `posbox` block
 * per line). Quick Export (blockModelToDocx) must NOT flatten it into a stacked
 * column — it must produce a .docx that looks like the original page AND edits like
 * normal text (no floating boxes, no visible box chrome). This drives the REAL
 * blockModelToDocx routing → positionedModelToDocx and asserts:
 *
 *   • lines are POSITIONED TEXT FRAMES (w:framePr), never floating text boxes
 *     (wps:wsp / mc:AlternateContent) — floating boxes are select-first objects;
 *   • BROWSER path (canvas available): the baked text is erased from the raster and
 *     the frames are TRANSPARENT (no w:shd fill) → no visible box;
 *   • NODE/fallback path (no canvas): frames keep an opaque w:shd mask over the
 *     original raster (still no doubled text);
 *   • the page raster rides behind the text, one section per page, real text kept,
 *     and it never falls back to the flow (stacked) exporter.
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

const { blockModelToDocx } = await import(pathToFileURL(path.join(tmp, 'app/services/convert/blockExport.js')).href);

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok  ${name}`); else { console.error(`FAIL  ${name}`); failures += 1; } };

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==';

const makeDoc = () => ({
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
});

async function xmlOf(doc) {
  const blob = await blockModelToDocx(doc);
  const buf = Buffer.from(await blob.arrayBuffer());
  return { buf, s: buf.toString('latin1'), type: blob.type };
}

/* ---- A) BROWSER path: stub canvas/Image so the raster is erased → transparent ---- */
globalThis.Image = class { set src(_v) { this.naturalWidth = 794; this.naturalHeight = 1123; queueMicrotask(() => this.onload && this.onload()); } };
globalThis.document = {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({ fillStyle: '', drawImage() {}, fillRect() {} }),
    toDataURL: () => JPG, // the "erased" page raster
  }),
};
{
  const { buf, s, type } = await xmlOf(makeDoc());
  check('is a Word .docx blob', type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  check('is a zip (PK header)', buf[0] === 0x50 && buf[1] === 0x4b);
  check('embeds a page raster image', s.includes('word/media/image1'));
  check('raster sits BEHIND the text', s.includes('behindDoc="1"'));
  check('emits positioned text frames', s.includes('<w:framePr'));
  check('frames anchor to the page', s.includes('w:vAnchor="page"') && s.includes('w:hAnchor="page"'));
  check('does NOT use floating text boxes', !s.includes('wps:wsp') && !s.includes('mc:AlternateContent'));
  check('erased raster → TRANSPARENT frames (no shd box)', !s.includes('<w:shd'));
  check('embeds the re-import sidecar', s.includes('docmaster/model.json'));
  check('keeps the real text', s.includes('RAILWAY RECRUITMENT BOARD') && s.includes('Registration No : L72511691071'));
  check('one section per page (2 pages)', (s.match(/<w:sectPr>/g) || []).length === 2);
  check('did NOT flatten to a flow body', !s.includes('w:pgMar w:top="1440"'));
}

/* ---- B) NODE/fallback path: no canvas → opaque shd mask kept, still frames ------- */
delete globalThis.document;
delete globalThis.Image;
{
  const { s } = await xmlOf(makeDoc());
  check('fallback still uses positioned frames', s.includes('<w:framePr'));
  check('fallback masks with opaque shd fill', s.includes('w:fill="ffffff"') && s.includes('w:fill="eeeeee"'));
  check('fallback keeps the original raster', s.includes('word/media/image1'));
  check('fallback did NOT flatten to a flow body', !s.includes('w:pgMar w:top="1440"'));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll positioned-docx export checks passed.');
