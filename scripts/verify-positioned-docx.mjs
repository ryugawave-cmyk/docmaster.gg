/**
 * Regression test — Quick Export of a POSITIONED (exact-layout) document.
 *
 * A PDF/DOCX brought into the Document editor as a positioned model
 * (doc.layout==='positioned') keeps its graphics — logos, emblems, banner shapes,
 * photos and stylised/complex-script text — in the PER-PAGE BACKGROUND RASTER
 * (doc.pages[].bg); only plain text lines are `posbox` blocks. So DEFAULT Quick
 * Export (blockModelToDocx → positionedModelToDocx) must reproduce the page: the
 * raster behind the text, one inline-editable w:framePr frame per line on top —
 * the only representation that visually matches the editor in Word / LibreOffice.
 * It asserts:
 *
 *   • lines are POSITIONED TEXT FRAMES (w:framePr), never floating text boxes
 *     (wps:wsp / mc:AlternateContent) — floating boxes are select-first objects;
 *   • the page raster rides BEHIND the text (behindDoc), so no graphic is lost;
 *   • BROWSER path (canvas): the baked text is erased and frames are TRANSPARENT
 *     (no w:shd fill) → no visible box; NODE/fallback keeps an opaque w:shd mask;
 *   • one section per page, real text kept, never flattened to a stacked flow.
 *
 * The pure-reflow path (standard w:p / w:tbl, no frames, graphics dropped) is an
 * OPT-IN via `{ editable:true }` and is covered too. The inkBand eraser and
 * mergeSidecar helpers are exercised as well.
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
const { inkBand } = await import(pathToFileURL(path.join(tmp, 'app/services/convert/docx.js')).href);
const { mergeSidecar } = await import(pathToFileURL(path.join(tmp, 'app/services/convert/docxImport.js')).href);

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

// A single page whose line-boxes form a 2×2 grid — used to prove the OPT-IN reflow
// recognises an aligned grid as a real table.
const makeTableDoc = () => ({
  layout: 'positioned',
  page: { width: 794, height: 1123, margin: 0 },
  pages: [{ bg: PNG, width: 794, height: 1123 }],
  blocks: [
    { type: 'posbox', page: 0, frame: { x: 100, y: 80, w: 120, h: 20 }, style: { align: 'left' }, fill: '#ffffff',
      runs: [{ text: 'Name', marks: { fontSize: 14, bold: true } }] },
    { type: 'posbox', page: 0, frame: { x: 320, y: 80, w: 120, h: 20 }, style: { align: 'left' }, fill: '#ffffff',
      runs: [{ text: 'Age', marks: { fontSize: 14, bold: true } }] },
    { type: 'posbox', page: 0, frame: { x: 100, y: 108, w: 120, h: 20 }, style: { align: 'left' }, fill: '#ffffff',
      runs: [{ text: 'Rajat', marks: { fontSize: 14 } }] },
    { type: 'posbox', page: 0, frame: { x: 320, y: 108, w: 120, h: 20 }, style: { align: 'left' }, fill: '#ffffff',
      runs: [{ text: '30', marks: { fontSize: 14 } }] },
  ],
});

async function xmlOf(doc, opts) {
  const blob = await blockModelToDocx(doc, opts);
  const buf = Buffer.from(await blob.arrayBuffer());
  return { buf, s: buf.toString('latin1'), type: blob.type };
}

/* ---- A) DEFAULT Quick Export → layout-faithful (raster + editable frames) --------- */
// Browser stub: canvas/Image so the raster is erased under the text → transparent frames.
globalThis.Image = class { set src(_v) { this.naturalWidth = 794; this.naturalHeight = 1123; queueMicrotask(() => this.onload && this.onload()); } };
globalThis.document = {
  createElement: () => {
    const c = { width: 0, height: 0, toDataURL: () => JPG };
    c.getContext = () => ({
      fillStyle: '', drawImage() {}, fillRect() {},
      // all-white pixels → inkBand finds no ink → eraser no-ops, still produces a
      // cleaned raster (toDataURL) so the transparent-frame path runs.
      getImageData: () => ({ data: new Uint8ClampedArray(Math.max(4, c.width * c.height * 4)).fill(255) }),
    });
    return c;
  },
};
{
  const { buf, s, type } = await xmlOf(makeDoc());
  check('is a Word .docx blob', type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  check('is a zip (PK header)', buf[0] === 0x50 && buf[1] === 0x4b);
  check('embeds a page raster image (graphics preserved)', s.includes('word/media/image1'));
  check('raster sits BEHIND the text', s.includes('behindDoc="1"'));
  check('emits positioned text frames', s.includes('<w:framePr'));
  check('frames anchor to the page', s.includes('w:vAnchor="page"') && s.includes('w:hAnchor="page"'));
  check('does NOT use floating text boxes', !s.includes('wps:wsp') && !s.includes('mc:AlternateContent'));
  check('erased raster → TRANSPARENT frames (no shd box)', !s.includes('<w:shd'));
  check('embeds the gzipped re-import sidecar', s.includes('docmaster/model.json.gz'));
  check('keeps the real text', s.includes('RAILWAY RECRUITMENT BOARD') && s.includes('Registration No : L72511691071'));
  check('one section per page (2 pages)', (s.match(/<w:sectPr>/g) || []).length === 2);
  check('did NOT flatten to a flow body', !s.includes('w:pgMar w:top="1440"'));
}

/* ---- B) OPT-IN reflow ({ editable:true }) → normal, fully-editable paragraphs ------ */
{
  const { s } = await xmlOf(makeDoc(), { editable: true });
  check('editable: emits standard paragraphs (w:p)', s.includes('<w:p>') || s.includes('<w:p '));
  check('editable: does NOT emit positioned text frames', !s.includes('<w:framePr'));
  check('editable: does NOT use floating text boxes', !s.includes('wps:wsp') && !s.includes('mc:AlternateContent') && !s.includes('<v:textbox'));
  check('editable: no page raster / sidecar (pure reflow)', !s.includes('word/media/image') && !s.includes('docmaster/model.json'));
  check('editable: keeps the real text', s.includes('RAILWAY RECRUITMENT BOARD') && s.includes('Registration No : L72511691071'));
}

/* ---- C) OPT-IN reflow: an aligned grid of line-boxes becomes a real table --------- */
{
  const { s } = await xmlOf(makeTableDoc(), { editable: true });
  check('editable: grid of line-boxes → real w:tbl table', s.includes('<w:tbl>'));
  check('editable: table keeps its cell text', s.includes('Name') && s.includes('Age') && s.includes('Rajat') && s.includes('30'));
}

/* ---- D) DEFAULT fallback (no canvas) → opaque shd mask kept, still frames ---------- */
delete globalThis.document;
delete globalThis.Image;
{
  const { s } = await xmlOf(makeDoc());
  check('fallback still uses positioned frames', s.includes('<w:framePr'));
  check('fallback masks with opaque shd fill', s.includes('w:fill="ffffff"') && s.includes('w:fill="eeeeee"'));
  check('fallback keeps the original raster', s.includes('word/media/image1'));
  check('fallback did NOT flatten to a flow body', !s.includes('w:pgMar w:top="1440"'));
}

/* ---- E) inkBand: erase covers glyph rows but SPARES a grid rule below them --------- */
{
  // 100×40 region (scale 1): text ink on rows 8..20 (50% width), a full-width grid
  // rule on row 32. The eraser must cover the text band but not reach row 32.
  const W = 100, H = 40;
  const d = new Uint8ClampedArray(W * H * 4); d.fill(255);
  const ink = (y0, y1, xe) => { for (let y = y0; y < y1; y += 1) for (let x = 2; x < xe; x += 1) { const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = 0; } };
  ink(8, 21, 52);   // text band (rows 8..20)
  ink(32, 33, 98);  // horizontal rule (row 32), full width
  const band = inkBand(d, W, H, { x: 0, y: 0, w: 100, h: 40 }, 1, 255);
  check('inkBand found the text band', band && band.top <= 8 && band.top >= 6);
  check('inkBand is tight to the text (does NOT reach the rule at row 32)', band && band.top + band.h <= 24);
}

/* ---- F) mergeSidecar: keep the sidecar layout but adopt MS-Word text edits --------- */
{
  const mk = (texts) => ({
    layout: 'positioned', page: { width: 600, height: 800, margin: 0 },
    pages: [{ bg: 'data:orig', width: 600, height: 800 }],
    blocks: texts.map((t, i) => ({
      type: 'posbox', page: 0, frame: { x: 10, y: 10 + i * 20, w: 200, h: 18 }, fill: '#ffffff',
      runs: [{ text: t, marks: { fontSize: 14 } }],
    })),
  });
  const recon = (texts) => ({ layout: 'positioned', pages: [{ bg: 'data:erased' }],
    blocks: texts.map((t) => ({ type: 'posbox', page: 0, frame: {}, fill: '', revealed: true, runs: [{ text: t, marks: {} }] })) });

  // 1) Identical text (our own export) → sidecar verbatim: ORIGINAL raster + no revealed flag.
  {
    const d = mergeSidecar(mk(['Name', 'RAJAT']), recon(['Name', 'RAJAT']), 'x');
    check('merge: identical → original raster kept', d.pages[0].bg === 'data:orig');
    check('merge: identical → dormant (not revealed)', !d.blocks[0].revealed);
    check('merge: identical → text unchanged', d.blocks[1].runs[0].text === 'RAJAT');
  }
  // 2) A line edited in Word → adopt that line's new text, keep the sidecar layout/raster.
  {
    const d = mergeSidecar(mk(['Name', 'RAJAT']), recon(['Name', 'RAJAT KUMAR']), 'x');
    check('merge: edited line adopts Word text', d.blocks[1].runs[0].text === 'RAJAT KUMAR');
    check('merge: unedited line untouched', d.blocks[0].runs[0].text === 'Name');
    check('merge: still original raster + layout', d.pages[0].bg === 'data:orig' && d.blocks[1].frame.w === 200);
  }
  // 3) Line count changed in Word → sidecar layout is stale → use the reconstruction.
  {
    const r = recon(['Name', 'RAJAT', 'EXTRA LINE']);
    const d = mergeSidecar(mk(['Name', 'RAJAT']), r, 'x');
    check('merge: structure change → falls back to reconstruction', d === r);
  }
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll positioned-docx export checks passed.');
