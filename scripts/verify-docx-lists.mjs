/**
 * Regression test (pure Node, no browser) — PDF → Word reconstructs bullet and
 * numbered lists as REAL, editable Word lists.
 *
 * Before this, a PDF's "• item" / "1. step" lines came out as ordinary paragraphs
 * (or a literal "•\t" typed into the text), so Word wouldn't renumber them and the
 * marker was frozen. reconstruct.js now detects the marker (stripping it from the
 * text) and docx.js emits `<w:numPr>` items backed by a generated word/numbering.xml:
 * bullets share one list; each contiguous numbered run gets its OWN numId so it
 * restarts from 1 (the classic "second list continues 4,5,6…" bug).
 *
 * The DOCX writer is pure JS (hand-rolled OOXML → a STORED zip), so we build a
 * synthetic positioned-text model, convert it, and read the archive bytes directly.
 * Run: `node scripts/verify-docx-lists.mjs`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONV = path.resolve(HERE, '../public/js/app/services/convert');
const SERVICES = path.resolve(CONV, '..');

// The app ships plain-ESM `.js` served to the browser, but the repo has no
// package.json "type":"module", so Node loads bare `.js` as CommonJS. Mirror the
// (self-contained) module graph into a temp ESM package so we can import it as-is —
// no build step, no browser needed. Graph: services/zip.js + convert/{model,
// reconstruct,docx}.js (zip.js/model.js import nothing external).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-lists-'));
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
fs.mkdirSync(path.join(tmp, 'services', 'convert'), { recursive: true });
fs.copyFileSync(path.join(SERVICES, 'zip.js'), path.join(tmp, 'services', 'zip.js'));
for (const f of ['model.js', 'reconstruct.js', 'docx.js']) {
  fs.copyFileSync(path.join(CONV, f), path.join(tmp, 'services', 'convert', f));
}
const { modelToDocx } = await import(pathToFileURL(path.join(tmp, 'services', 'convert', 'docx.js')));
const { reconstructDocument } = await import(pathToFileURL(path.join(tmp, 'services', 'convert', 'reconstruct.js')));

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok  ${name}`); else { console.error(`FAIL  ${name}`); failures += 1; } };
const count = (hay, needle) => hay.split(needle).length - 1;

// A page of positioned text runs: heading, a bullet list, a paragraph, a numbered
// list, a break, then a SECOND numbered list (must restart at 1).
let y = 40;
const line = (text, fontSize = 16) => { const o = { type: 'text', text, x: 60, y, w: 400, h: 22, fontSize }; y += 34; return o; };
const model = {
  PW: 794, PH: 1123,
  pages: [{
    w: 794, h: 1123,
    objects: [
      line('Document Title', 28),
      line('• First bullet'),
      line('• Second bullet'),
      line('A normal paragraph of text.'),
      line('1. Alpha step'),
      line('2. Beta step'),
      line('Break paragraph here.'),
      line('1. Gamma step'),
      line('2. Delta step'),
    ],
  }],
};

/* ---- intermediate JSON exposes the list structure ---- */
const doc = reconstructDocument(model, 'lists');
const blocks = doc.pages.flatMap((p) => p.blocks);
const bullets = blocks.filter((b) => b.list && b.list.kind === 'bullet');
const numbers = blocks.filter((b) => b.list && b.list.kind === 'number');
check('intermediate JSON: two bullet items detected', bullets.length === 2);
check('intermediate JSON: four numbered items detected', numbers.length === 4);
check('intermediate JSON: bullet marker stripped from text', bullets[0] && bullets[0].text === 'First bullet');
check('intermediate JSON: numbered marker stripped from text', numbers[0] && numbers[0].text === 'Alpha step');

/* ---- DOCX output carries native numbering ---- */
const blob = modelToDocx(model, { mode: 'layout', name: 'lists' });
const buf = new Uint8Array(await blob.arrayBuffer());
const zip = new TextDecoder('latin1').decode(buf); // STORED zip → XML appears verbatim

check('docx is a real zip (PK header)', buf[0] === 0x50 && buf[1] === 0x4b);
check('docx includes a word/numbering.xml part', zip.includes('word/numbering.xml'));
check('numbering content-type override present', zip.includes('wordprocessingml.numbering+xml'));
check('numbering relationship wired', zip.includes('Target="numbering.xml"'));
check('paragraphs carry <w:numPr>', zip.includes('<w:numPr>'));

check('bullets use the shared bullet list (numId 1)', zip.includes('<w:numId w:val="1"/>'));
check('first numbered list uses its own numId (2)', zip.includes('<w:numId w:val="2"/>'));
check('second numbered list restarts under a fresh numId (3)', zip.includes('<w:numId w:val="3"/>'));
check('numbering.xml defines a bullet abstract (numFmt bullet)', zip.includes('<w:numFmt w:val="bullet"/>'));
check('numbering.xml defines a decimal abstract (numFmt decimal)', zip.includes('<w:numFmt w:val="decimal"/>'));
check('bullet num instance maps to abstract 0', zip.includes('<w:num w:numId="1"><w:abstractNumId w:val="0"/>'));
check('two independent decimal num instances (restart)',
  zip.includes('<w:num w:numId="2"><w:abstractNumId w:val="1"/>')
  && zip.includes('<w:num w:numId="3"><w:abstractNumId w:val="1"/>'));

// Markers must not survive as literal text (that would double them next to the real
// list marker) — the stripped words must, though.
check('literal "1. Alpha step" marker removed from body', !zip.includes('1. Alpha step'));
check('list text preserved (Alpha step / First bullet)', zip.includes('Alpha step') && zip.includes('First bullet'));
check('exactly two numbered <w:numId val=2> items (Alpha, Beta)', count(zip, '<w:numId w:val="2"/>') === 2);

/* ---- AI mode: model-classified paragraphs also become list items ---- */
const aiPages = [{
  blocks: [
    { kind: 'paragraph', text: 'Intro paragraph.' },
    { kind: 'paragraph', text: '• AI bullet one' },
    { kind: 'paragraph', text: '• AI bullet two' },
    { kind: 'paragraph', text: '1. AI step one' },
    { kind: 'paragraph', text: '2. AI step two' },
  ],
}];
const aiBlob = modelToDocx(model, { mode: 'ai', name: 'ai-lists', aiPages });
const aiZip = new TextDecoder('latin1').decode(new Uint8Array(await aiBlob.arrayBuffer()));
check('AI path: emits native numbering', aiZip.includes('<w:numPr>') && aiZip.includes('word/numbering.xml'));
check('AI path: bullet marker stripped', aiZip.includes('AI bullet one') && !aiZip.includes('• AI bullet one'));
check('AI path: numbered marker stripped', aiZip.includes('AI step one') && !aiZip.includes('1. AI step one'));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll DOCX list-reconstruction checks passed.');
