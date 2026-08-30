/**
 * Regression test — PDF → DOC font-weight preservation.
 *
 * Guards the fix for "bold headings convert to regular text on Transfer to Doc".
 * It reproduces the Biology PDF's page (the "4. DNA and Genetic Information"
 * heading set in a Bold face, body text in a Regular face, a sub-heading, and a
 * table with a bold header row) and drives it through the REAL shipping code:
 *
 *   1. editor/fontWeight.js       — infers bold/italic/weight from the PDF font name
 *      (exactly what pdfImport.getFontProps hands it after reading the embedded font),
 *   2. services/convert/model.js  — buildContentModel maps the imported objects'
 *      bold/italic onto the conversion runs, and
 *   3. model/documentModel.js     — createRun carries the mark that the DOC editor
 *      renders as font-weight:700.
 *
 * Asserts every bold heading/cell stays bold, and — just as important — that no
 * regular text is bolded (no blanket-bold). Pure Node: the three modules have no
 * DOM/pdfjs dependencies, so they are copied to a temp dir as .mjs and imported
 * directly (no browser needed). Run: `node scripts/verify-font-weight.mjs`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Copy the (import-free) source modules to a temp dir as .mjs so Node loads them as
// ES modules regardless of the repo's CommonJS default, then import the real code.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docmaster-fw-'));
function loadModule(rel) {
  const dest = path.join(tmp, path.basename(rel));
  fs.copyFileSync(path.join(ROOT, rel), dest);
  return import(pathToFileURL(dest).href);
}

const { fontPropsFromName, weightFromName } = await loadModule('public/js/app/editor/fontWeight.js');
const { buildContentModel } = await loadModule('public/js/app/services/convert/model.js');
const { createRun } = await loadModule('public/js/app/model/documentModel.js');

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

/* 1) Weight inference straight from font names (subset tags, compound weights). */
console.log('\n— weightFromName —');
check('Arial-BoldMT → 700', weightFromName('BCDEEE+Arial-BoldMT'), 700);
check('Calibri (regular) → 400', weightFromName('Calibri'), 400);
check('Arial-SemiBold → 600', weightFromName('Arial-SemiBold'), 600);
check('Roboto-Medium → 500', weightFromName('Roboto-Medium'), 500);
check('Helvetica-Black → 900', weightFromName('Helvetica-Black'), 900);
check('Calibri-Light → 300', weightFromName('Calibri-Light'), 300);
check('Times-ExtraBold → 800', weightFromName('Times-ExtraBold'), 800);

/* 2) bold/italic decision (semibold+ is visually bold; medium/regular is not). */
console.log('\n— fontPropsFromName —');
check('Bold font is bold', fontPropsFromName('ABCDEF+Arial-BoldMT').bold, true);
check('Regular font is NOT bold', fontPropsFromName('Arial').bold, false);
check('Medium font is NOT bold', fontPropsFromName('Roboto-Medium').bold, false);
check('SemiBold font IS bold', fontPropsFromName('Source-SemiBold').bold, true);
check('Italic detected', fontPropsFromName('Georgia-Italic').italic, true);
check('BoldItalic → bold + italic', fontPropsFromName('Arial-BoldItalicMT'), { bold: true, italic: true, weight: 700 });
check('Explicit font flag wins over plain name', fontPropsFromName('Frutiger', 'sans-serif', { bold: true }).bold, true);

/* 3) End-to-end: a Biology-PDF page → conversion runs keep the right weight.
 *    Each imported text object is built the way pdfImport + buildImportedObjects do:
 *    its bold/italic come from fontPropsFromName(<embedded font name>). */
console.log('\n— Biology page → content model —');
const mkObj = (text, font, x, y, fontSize) => {
  const fp = fontPropsFromName(font);
  return {
    type: 'text', imported: true, text,
    x, y, w: text.length * fontSize * 0.5, h: fontSize * 1.1,
    fontSize, fontFamily: 'Arial, Helvetica, sans-serif',
    color: '#111827', align: 'left',
    bold: fp.bold, italic: fp.italic, fontWeight: fp.weight, underline: false,
  };
};

// The page as the Biology PDF lays it out (fonts mirror a real export: headings in
// Arial-Bold, body in Arial regular; the vocab table header row is bold).
const objects = [
  mkObj('4. DNA and Genetic Information', 'ABCDEF+Arial-BoldMT', 60, 40, 28),
  mkObj('DNA stores hereditary information used by cells.', 'ABCDEF+ArialMT', 60, 90, 15),
  mkObj('DNA vocabulary', 'ABCDEF+Arial-BoldMT', 60, 380, 18),
  mkObj('Term', 'ABCDEF+Arial-BoldMT', 60, 420, 14),        // table header cell (bold)
  mkObj('Meaning', 'ABCDEF+Arial-BoldMT', 260, 420, 14),    // table header cell (bold)
  mkObj('Double helix', 'ABCDEF+ArialMT', 60, 450, 14),     // table body cell (regular)
];
const model = { PW: 794, PH: 1123, pages: [{ w: 794, h: 1123, objects, images: [] }] };
const content = buildContentModel(model);
const runs = content.pages[0].runs;
const runFor = (needle) => runs.find((r) => r.text.includes(needle));

check('heading "4. DNA…" is bold', !!runFor('DNA and Genetic')?.bold, true);
check('body text is NOT bold', !!runFor('hereditary')?.bold, false);
check('sub-heading "DNA vocabulary" is bold', !!runFor('vocabulary')?.bold, true);
check('table header "Term" is bold', !!runFor('Term')?.bold, true);
check('table header "Meaning" is bold', !!runFor('Meaning')?.bold, true);
check('table body "Double helix" is NOT bold', !!runFor('Double helix')?.bold, false);

// No blanket-bold: at least one run must be regular AND at least one bold.
check('mix preserved (some bold, some regular)',
  runs.some((r) => r.bold) && runs.some((r) => !r.bold), true);

/* 4) createRun carries the bold mark the editor renders as font-weight:700. */
console.log('\n— documentModel.createRun —');
check('createRun bold mark set', createRun('x', { bold: true }).marks.bold, true);
check('createRun default is regular', createRun('x').marks.bold, false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures ? `❌ ${failures} check(s) failed` : '✅ all font-weight checks passed'}`);
process.exit(failures ? 1 : 0);
