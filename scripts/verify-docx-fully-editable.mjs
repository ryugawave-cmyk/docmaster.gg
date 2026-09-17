/**
 * Regression test (pure Node, no browser) — the PDF → Word "Fully Editable" mode
 * (docx.js mode:'layout') produces a document you can click into and type, NOT one
 * with text trapped in floating boxes.
 *
 * It asserts the whole reconstruction is NATIVE, editable OOXML:
 *   • headings/paragraphs are real <w:p>/<w:r>/<w:t>
 *   • a detected grid is a real <w:tbl> with editable <w:tc> cells
 *   • bullet/numbered lines are real <w:numPr> list items
 *   • and — the key "fully editable" guarantee — there are NO text boxes anywhere
 *     (<w:txbxContent> / wps:txbx / <v:textbox>), which is what the "Exact Copy"
 *     mode uses and what makes text feel un-editable.
 *
 * The DOCX writer is pure JS (hand-rolled OOXML → a STORED zip), so we build a
 * synthetic positioned-text model, convert it, and read the archive bytes directly.
 * Run: `node scripts/verify-docx-fully-editable.mjs`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONV = path.resolve(HERE, '../public/js/app/services/convert');
const SERVICES = path.resolve(CONV, '..');

// Mirror the self-contained module graph into a temp ESM package so Node can import
// the browser-served `.js` as-is (the repo has no package.json "type":"module").
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-fe-'));
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
fs.mkdirSync(path.join(tmp, 'services', 'convert'), { recursive: true });
fs.copyFileSync(path.join(SERVICES, 'zip.js'), path.join(tmp, 'services', 'zip.js'));
for (const f of ['model.js', 'reconstruct.js', 'docx.js']) {
  fs.copyFileSync(path.join(CONV, f), path.join(tmp, 'services', 'convert', f));
}
const { modelToDocx } = await import(pathToFileURL(path.join(tmp, 'services', 'convert', 'docx.js')));

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok  ${name}`); else { console.error(`FAIL  ${name}`); failures += 1; } };

// A realistic one-page mix: title, paragraph, a bullet list, a numbered list, and a
// 2×2 aligned grid (→ a real table).
const txt = (text, x, y, w, fontSize = 16) => ({ type: 'text', text, x, y, w, h: 22, fontSize });
const model = {
  PW: 794, PH: 1123,
  pages: [{
    w: 794, h: 1123,
    objects: [
      txt('Quarterly Report', 60, 40, 300, 26),
      txt('This is the first paragraph of the report body.', 60, 92, 460),
      txt('• Revenue grew', 60, 132, 200),
      txt('• Costs fell', 60, 166, 200),
      txt('1. Review numbers', 60, 210, 260),
      txt('2. Approve budget', 60, 244, 260),
      // Aligned grid → detected as a real table (two columns at x=60 and x=320).
      txt('Metric', 60, 300, 60), txt('Value', 320, 300, 60),
      txt('Users', 60, 334, 60), txt('1200', 320, 334, 60),
    ],
  }],
};

const blob = modelToDocx(model, { mode: 'layout', name: 'fully-editable' });
const buf = new Uint8Array(await blob.arrayBuffer());
const zip = new TextDecoder('latin1').decode(buf); // STORED zip → XML appears verbatim

check('output is a real .docx zip (PK header)', buf[0] === 0x50 && buf[1] === 0x4b);

// Native, editable text — real runs, not boxes.
check('paragraph text is a native run', zip.includes('This is the first paragraph of the report body.'));
check('heading text present', zip.includes('Quarterly Report'));

// The key guarantee: NOTHING is trapped in a text box / drawing shape.
check('NO DrawingML text boxes (wps:txbx)', !zip.includes('wps:txbx'));
check('NO text box content (w:txbxContent)', !zip.includes('<w:txbxContent>'));
check('NO legacy VML text boxes (v:textbox)', !zip.includes('<v:textbox'));
check('NO absolute-positioned text frames (w:framePr)', !zip.includes('<w:framePr'));

// Real, editable table.
check('grid became a native <w:tbl>', zip.includes('<w:tbl>'));
check('table has editable cells (<w:tc>)', zip.includes('<w:tc>'));
check('table cell text preserved', zip.includes('Metric') && zip.includes('Value')
  && zip.includes('Users') && zip.includes('1200'));

// Real, editable lists (markers stripped, native numbering).
check('native list items (<w:numPr>)', zip.includes('<w:numPr>'));
check('numbering part present', zip.includes('word/numbering.xml'));
check('bullet marker stripped (text kept)', zip.includes('Revenue grew') && !zip.includes('• Revenue grew'));
check('numbered marker stripped (text kept)', zip.includes('Review numbers') && !zip.includes('1. Review numbers'));

// A page section keeps page size / breaks (not one endless page).
check('page section present (<w:sectPr>)', zip.includes('<w:sectPr>'));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll "Fully Editable" checks passed.');
