/**
 * Automated verification for the "text cannot be fully deleted" fix.
 *
 * Boots the app, opens a generated PDF in the REAL in-place editor, then deletes
 * an entire word, an entire sentence and a number field until each is empty and
 * asserts:
 *   1. the Document Model stores the empty string (no rejection),
 *   2. getText() no longer contains the deleted content,
 *   3. the raster canvas where the ORIGINAL glyphs were is now background —
 *      i.e. the original PDF text is truly gone, not merely covered,
 *   4. undo restores it (canvas + model) and redo empties it again — the
 *      renderer is an exact mirror of the model in both directions.
 *
 * Uses puppeteer-core driving the system Edge (no Chromium download). The editor
 * modules are imported in-page exactly as the app loads them, so this exercises
 * the shipping code path, not a copy.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const puppeteer = require('puppeteer-core');

const PORT = process.env.PORT || 3777;
const BASE = `http://localhost:${PORT}`;

/** Find a Chromium-family browser (Edge or Chrome); overridable via BROWSER_PATH. */
function findBrowser() {
  const candidates = [
    process.env.BROWSER_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}
const EDGE = findBrowser();

/* --------------------------- a tiny, valid PDF ---------------------------- */
function buildPdf() {
  const objs = [];
  objs[1] = '<</Type/Catalog/Pages 2 0 R>>';
  objs[2] = '<</Type/Pages/Kids[3 0 R]/Count 1>>';
  objs[3] = '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>';
  const stream = [
    'BT /F1 24 Tf 72 700 Td (Hello) Tj ET',
    'BT /F1 24 Tf 72 650 Td (The quick brown fox jumps.) Tj ET',
    'BT /F1 24 Tf 72 600 Td (1234567890) Tj ET',
  ].join('\n');
  objs[4] = `<</Length ${Buffer.byteLength(stream)}>>\nstream\n${stream}\nendstream`;
  objs[5] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>';

  let pdf = '%PDF-1.4\n%\xFF\xFF\xFF\xFF\n';
  const offsets = [];
  for (let i = 1; i <= 5; i += 1) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i += 1) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

/* ------------------------------- utilities -------------------------------- */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function ping() {
  return new Promise((resolve) => {
    http.get(`${BASE}/workspace`, (res) => { res.resume(); resolve(res.statusCode === 200); })
      .on('error', () => resolve(false));
  });
}
async function waitForServer(tries = 60) {
  for (let i = 0; i < tries; i += 1) { if (await ping()) return true; await wait(500); }
  return false;
}

/* --------------------- the in-page test (runs in Edge) -------------------- */
/* eslint-disable no-undef */
async function inPage(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const { createPdfEditor } = await import('/js/app/editor/pdfEditor.js');

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:0;top:0;width:900px;height:1200px;z-index:99999;background:#fff';
  document.body.appendChild(container);

  const editor = createPdfEditor({ container, onSelection() {}, onChange() {}, onWarn() {} });
  const file = new File([bytes], 'sample.pdf', { type: 'application/pdf' });
  await editor.load(file);
  await new Promise((r) => setTimeout(r, 400));

  const canvas = container.querySelector('.pdfedit__canvas');
  const ctx = canvas.getContext('2d');
  const cRect = canvas.getBoundingClientRect();
  const sx = canvas.width / cRect.width;   // canvas px per CSS px (incl. dpr)
  const sy = canvas.height / cRect.height;

  const allBoxes = () => [...container.querySelectorAll('.pdfrun')];

  // Count dark (text) pixels inside a box's CURRENT-or-recorded screen rect.
  function darkPixels(rect) {
    const x = Math.max(0, Math.floor((rect.left - cRect.left) * sx));
    const y = Math.max(0, Math.floor((rect.top - cRect.top) * sy));
    const w = Math.max(1, Math.floor(rect.width * sx));
    const h = Math.max(1, Math.floor(rect.height * sy));
    let dark = 0;
    const d = ctx.getImageData(x, y, w, h).data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      if (lum < 110) dark += 1;
    }
    return dark;
  }

  // Group boxes into lines by their top (a "sentence" spans several runs).
  function lineOf(matcher) {
    const boxes = allBoxes();
    const seed = boxes.find((b) => matcher(b.textContent));
    if (!seed) return { boxes: [], rect: null };
    const top = seed.getBoundingClientRect().top;
    const line = boxes.filter((b) => Math.abs(b.getBoundingClientRect().top - top) < 6);
    // Union rect of the whole line (its original footprint).
    const rs = line.map((b) => b.getBoundingClientRect());
    const rect = {
      left: Math.min(...rs.map((r) => r.left)),
      top: Math.min(...rs.map((r) => r.top)),
      right: Math.max(...rs.map((r) => r.right)),
      bottom: Math.max(...rs.map((r) => r.bottom)),
    };
    rect.width = rect.right - rect.left;
    rect.height = rect.bottom - rect.top;
    return { boxes: line, rect };
  }

  function del(box) {
    box.focus();
    box.textContent = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.blur();
  }
  const modelStrings = () => editor.getModel().pages.flatMap((p) => p.items.map((i) => i.str));

  const targets = {
    word: lineOf((t) => /Hello/.test(t)),
    sentence: lineOf((t) => /quick|fox|jumps/.test(t)),
    number: lineOf((t) => /\d{5,}/.test(t)),
  };

  const before = {
    word: darkPixels(targets.word.rect),
    sentence: darkPixels(targets.sentence.rect),
    number: darkPixels(targets.number.rect),
  };

  // Delete each target to empty.
  for (const key of ['word', 'sentence', 'number']) targets[key].boxes.forEach(del);
  await new Promise((r) => setTimeout(r, 150));

  const after = {
    word: darkPixels(targets.word.rect),
    sentence: darkPixels(targets.sentence.rect),
    number: darkPixels(targets.number.rect),
  };

  const text = editor.getText();
  const strings = modelStrings();

  // Undo (restores the last delete = the number) then redo it away again.
  const numberBox = targets.number.boxes[0];
  const numberId = numberBox.dataset.id;
  const numberRect = targets.number.rect;
  editor.undo();
  await new Promise((r) => setTimeout(r, 400));
  const undoneDark = darkPixels(numberRect);
  const undoneStr = editor.getModel().pages.flatMap((p) => p.items).find((i) => /\d{5,}/.test(i.orig || ''))?.str;
  editor.redo();
  await new Promise((r) => setTimeout(r, 400));
  const redoneDark = darkPixels(numberRect);

  container.remove();
  editor.destroy();

  return {
    boxCounts: { word: targets.word.boxes.length, sentence: targets.sentence.boxes.length, number: targets.number.boxes.length },
    before, after,
    emptyInModel: strings.filter((s) => s === '').length,
    textHasHello: /Hello/.test(text),
    textHasFox: /fox/.test(text),
    textHasNumber: /1234567890/.test(text),
    numberId,
    undoneDark, undoneStr,
    redoneDark,
  };
}
/* eslint-enable no-undef */

/* --------------------------------- main ----------------------------------- */
(async () => {
  const b64 = buildPdf().toString('base64');

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  let browser;
  let failed = false;
  try {
    if (!EDGE) throw new Error('No Edge/Chrome found. Set BROWSER_PATH=/path/to/msedge.exe');
    if (!(await waitForServer())) throw new Error('server did not start');
    browser = await puppeteer.launch({
      executablePath: EDGE,
      headless: 'new',
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 1400, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.error('  [page error]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('  [console]', m.text()); });

    await page.goto(`${BASE}/workspace`, { waitUntil: 'networkidle0' });
    const r = await page.evaluate(inPage, b64);

    // ------------------------------- report -------------------------------
    const checks = [];
    const ok = (name, cond, detail) => { checks.push({ name, pass: !!cond, detail }); if (!cond) failed = true; };

    console.log('\nExtracted runs per target:', r.boxCounts);
    console.log('Dark text pixels  BEFORE:', r.before);
    console.log('Dark text pixels  AFTER :', r.after);

    ok('word had text before delete', r.before.word > 50, r.before.word);
    ok('sentence had text before delete', r.before.sentence > 50, r.before.sentence);
    ok('number had text before delete', r.before.number > 50, r.before.number);

    ok('WORD region is blank after delete (original gone)', r.after.word <= 8, r.after.word);
    ok('SENTENCE region is blank after delete (original gone)', r.after.sentence <= 8, r.after.sentence);
    ok('NUMBER region is blank after delete (original gone)', r.after.number <= 8, r.after.number);

    ok('Document Model stores empty strings', r.emptyInModel >= 3, r.emptyInModel);
    ok('getText() no longer contains "Hello"', !r.textHasHello);
    ok('getText() no longer contains "fox"', !r.textHasFox);
    ok('getText() no longer contains the number', !r.textHasNumber);

    ok('UNDO restores original glyphs on canvas', r.undoneDark > 50, r.undoneDark);
    ok('UNDO restores original string in model', r.undoneStr === '1234567890', r.undoneStr);
    ok('REDO empties the canvas region again', r.redoneDark <= 8, r.redoneDark);

    console.log('');
    for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail !== undefined ? `  (${c.detail})` : ''}`);
    console.log(`\n${failed ? 'RESULT: FAIL' : 'RESULT: PASS — text deletes completely and the original is never restored.'}`);
  } catch (err) {
    failed = true;
    console.error('\nERROR:', err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  process.exit(failed ? 1 : 0);
})();
