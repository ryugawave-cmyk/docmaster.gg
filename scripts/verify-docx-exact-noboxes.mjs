/**
 * Regression test (pure Node, no browser) — PDF → Word "Exact Layout" mode overlays
 * text as positioned FRAMES, not text-box shapes, so no reader draws a grey
 * bounding-box/"debug rectangle" around every line.
 *
 * Before: each line was a floating wps/VML text box; Word/LibreOffice outline those,
 * making the page look like OCR/debug mode. Now each line is a `w:framePr` paragraph
 * (real body text pinned to page coordinates) with NO shape, NO border. On the normal
 * path the page raster's glyphs are erased (cleanBg) so the frames are fully
 * transparent; without that they fall back to a background-shaded mask (still no box).
 *
 * Run: `node scripts/verify-docx-exact-noboxes.mjs`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONV = path.resolve(HERE, '../public/js/app/services/convert');
const SERVICES = path.resolve(CONV, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-exact-'));
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
fs.mkdirSync(path.join(tmp, 'services', 'convert'), { recursive: true });
fs.copyFileSync(path.join(SERVICES, 'zip.js'), path.join(tmp, 'services', 'zip.js'));
for (const f of ['model.js', 'reconstruct.js', 'docx.js']) {
  fs.copyFileSync(path.join(CONV, f), path.join(tmp, 'services', 'convert', f));
}
const { modelToDocx } = await import(pathToFileURL(path.join(tmp, 'services', 'convert', 'docx.js')));

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok  ${name}`); else { console.error(`FAIL  ${name}`); failures += 1; } };

// 1×1 PNG used as the page-background raster (imported-PDF path).
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const model = {
  PW: 600, PH: 800,
  pages: [{ w: 600, h: 800, bg: PNG, objects: [
    { type: 'text', text: 'During the 60 hours duration', x: 60, y: 100, w: 300, h: 16, fontSize: 14, imported: true, boxBg: 'ffffff' },
    { type: 'text', text: '1.1 GENERAL', x: 60, y: 140, w: 120, h: 18, fontSize: 15, imported: true, boxBg: 'ffffff' },
  ] }],
};

const noBox = (zip) => {
  check('overlay uses positioned frames (<w:framePr>)', zip.includes('<w:framePr'));
  check('NO wps DrawingML text box', !zip.includes('wps:txbx'));
  check('NO legacy VML text box', !zip.includes('<v:rect') && !zip.includes('<v:textbox'));
  check('NO mc:AlternateContent shape wrapper', !zip.includes('mc:AlternateContent'));
  check('NO shape outline (<a:ln>)', !zip.includes('<a:ln'));
  check('text preserved', zip.includes('During the 60 hours duration') && zip.includes('1.1 GENERAL'));
};

// Normal Exact path: the raster glyphs are erased (cleanBg) → frames fully transparent.
console.log('— erased raster (normal path) —');
const erased = new TextDecoder('latin1').decode(new Uint8Array(await modelToDocx(model, { mode: 'exact', cleanBg: [PNG] }).arrayBuffer()));
noBox(erased);
check('erased path: frames are transparent (no w:shd fill)', !erased.includes('<w:shd '));

// Fallback (masking unavailable): frames shaded to hide baked glyphs — still no box.
console.log('— fallback (no cleanBg) —');
const fallback = new TextDecoder('latin1').decode(new Uint8Array(await modelToDocx(model, { mode: 'exact' }).arrayBuffer()));
noBox(fallback);
check('fallback path: uses background shading to mask (w:shd present)', fallback.includes('<w:shd '));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll Exact-mode no-box checks passed.');
