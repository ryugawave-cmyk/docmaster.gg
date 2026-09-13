/**
 * Regression test — Quick Export of a POSITIONED (exact-layout) document.
 *
 * A PDF brought into the Document editor via "Transfer to Doc" (or one of our own
 * exact exports re-imported) is a positioned model (doc.layout==='positioned',
 * per-page raster in doc.pages[].bg, one `posbox` block per line).
 *
 * DEFAULT Quick Export (blockModelToDocx) must now produce a NORMAL, fully-editable
 * Word document — standard paragraphs (w:p) / runs (w:r) and real tables (w:tbl),
 * NOT absolutely-positioned text frames or floating text boxes. No ordinary line may
 * end up inside a drawing object that Word / Google Docs / LibreOffice treat as a
 * shape to select rather than text to type in. This drives the REAL blockModelToDocx
 * routing → positionedModelToEditableDocx and asserts:
 *
 *   • lines become standard paragraphs (w:p), never w:framePr frames or floating
 *     text boxes (wps:wsp / mc:AlternateContent / v:textbox);
 *   • an aligned grid of line-boxes becomes a genuine editable table (w:tbl);
 *   • the decorative full-page raster is dropped (editability over pixel-exactness);
 *   • the real text survives and each page is its own section.
 *
 * The pixel-perfect path is still reachable via `{ exact:true }` and is covered too
 * (absolute w:framePr frames + page raster + lossless re-import sidecar), along with
 * the inkBand eraser and mergeSidecar helpers it relies on.
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

// A single page whose line-boxes form a 2×2 grid (two columns that line up across
// two rows) — the reconstruction must recognise it as a real table.
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

/* ---- A) DEFAULT Quick Export → a normal, fully-editable Word document ------------- */
{
  const { buf, s, type } = await xmlOf(makeDoc());
  check('is a Word .docx blob', type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  check('is a zip (PK header)', buf[0] === 0x50 && buf[1] === 0x4b);
  check('emits standard paragraphs (w:p)', s.includes('<w:p>') || s.includes('<w:p '));
  check('does NOT emit positioned text frames', !s.includes('<w:framePr'));
  check('does NOT use floating text boxes', !s.includes('wps:wsp') && !s.includes('mc:AlternateContent') && !s.includes('<v:textbox'));
  check('drops the decorative page raster', !s.includes('word/media/image') && !s.includes('behindDoc'));
  check('no re-import sidecar in editable mode', !s.includes('docmaster/model.json'));
  check('keeps the real text', s.includes('RAILWAY RECRUITMENT BOARD') && s.includes('Registration No : L72511691071'));
  check('one section per page (2 pages)', (s.match(/<w:sectPr>/g) || []).length === 2);
}

/* ---- B) An aligned grid of line-boxes becomes a genuine editable table ------------ */
{
  const { s } = await xmlOf(makeTableDoc());
  check('grid of line-boxes → real w:tbl table', s.includes('<w:tbl>'));
  check('table keeps its cell text', s.includes('Name') && s.includes('Age') && s.includes('Rajat') && s.includes('30'));
  check('table export uses no text frames', !s.includes('<w:framePr'));
}

/* ---- C) EXACT path (opt-in): browser stub → erased raster → TRANSPARENT frames ---- */
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
  const { s } = await xmlOf(makeDoc(), { exact: true });
  check('exact: embeds a page raster image', s.includes('word/media/image1'));
  check('exact: raster sits BEHIND the text', s.includes('behindDoc="1"'));
  check('exact: emits positioned text frames', s.includes('<w:framePr'));
  check('exact: frames anchor to the page', s.includes('w:vAnchor="page"') && s.includes('w:hAnchor="page"'));
  check('exact: does NOT use floating text boxes', !s.includes('wps:wsp') && !s.includes('mc:AlternateContent'));
  check('exact: erased raster → TRANSPARENT frames (no shd box)', !s.includes('<w:shd'));
  check('exact: embeds the gzipped re-import sidecar', s.includes('docmaster/model.json.gz'));
  check('exact: keeps the real text', s.includes('RAILWAY RECRUITMENT BOARD') && s.includes('Registration No : L72511691071'));
  check('exact: one section per page (2 pages)', (s.match(/<w:sectPr>/g) || []).length === 2);
}

/* ---- D) EXACT fallback (no canvas): opaque shd mask kept, still frames ------------- */
delete globalThis.document;
delete globalThis.Image;
{
  const { s } = await xmlOf(makeDoc(), { exact: true });
  check('exact fallback still uses positioned frames', s.includes('<w:framePr'));
  check('exact fallback masks with opaque shd fill', s.includes('w:fill="ffffff"') && s.includes('w:fill="eeeeee"'));
  check('exact fallback keeps the original raster', s.includes('word/media/image1'));
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
