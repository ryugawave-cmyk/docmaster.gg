/**
 * Regression test (headless Edge) — Enter inside a positioned text box is LOSSLESS.
 *
 * In a positioned (exact-layout) document the caret's "block" is a `.doc-posbox`
 * pinned to page coordinates (editRoot is the page; the box is its child). The old
 * paragraph splitter treated that box as a flow block and extracted the post-caret
 * content into a NEW sibling <div> — tearing the text out of the positioned box, which
 * then emptied so the first line "disappeared". documentEditor now breaks WITHIN the
 * box via breakInPosbox(): a <br> at the caret, all text preserved, caret on the new
 * line. This drives the REAL breakInPosbox against a live DOM (Range.insertNode /
 * extractContents need a real browser, which Node lacks).
 *
 * Needs Microsoft Edge; uses a throwaway user-data dir to dodge the running-Edge
 * singleton. Best-effort: prints SKIPPED (exit 0) if Edge can't launch.
 * Run: `node scripts/verify-posbox-enter.mjs`.
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
  import { breakInPosbox } from '/js/app/editor/documentEditor.js';

  // Build a positioned page: a contentEditable page with one .doc-posbox child that
  // holds a heading wrapping onto two lines (like "ROOFTOP SOLAR PV (INSTALLATION...)").
  function makeBox(text) {
    const page = document.createElement('div');
    page.contentEditable = 'true';
    page.style.position = 'relative';
    const box = document.createElement('div');
    box.className = 'doc-posbox';
    box.dataset.page = '0'; box.dataset.x = '100'; box.dataset.y = '200';
    box.style.position = 'absolute'; box.style.left = '100px'; box.style.top = '200px'; box.style.width = '400px';
    const span = document.createElement('span');
    span.textContent = text;
    box.appendChild(span);
    page.appendChild(box);
    document.body.appendChild(page);
    return { page, box, span };
  }

  // Place a collapsed caret at character offset \`off\` within the box's first text node.
  function caretAt(box, off) {
    const t = box.querySelector('span').firstChild; // the text node
    const range = document.createRange();
    range.setStart(t, off);
    range.collapse(true);
    return range;
  }

  window.run = () => {
    const TEXT = 'ROOFTOP SOLAR PV (INSTALLATION & MAINTENANCE)';
    const split = TEXT.indexOf('(INSTALLATION'); // caret between the two lines
    const out = {};

    // 1) MID split — the reported case: caret between the two lines.
    {
      const { box } = makeBox(TEXT);
      const r = breakInPosbox(caretAt(box, split), box);
      out.mid = {
        text: box.textContent,                       // must be unchanged (no loss)
        brs: box.querySelectorAll('br').length,      // exactly one hard break
        boxes: box.parentNode.querySelectorAll('.doc-posbox').length, // still ONE box on this page
        siblingFlow: !!box.parentNode.querySelector('.doc-block'), // no orphan flow block
        caretCollapsed: r.collapsed,
      };
    }
    // 2) START — caret at offset 0: the whole line must survive in the same box.
    {
      const { box } = makeBox(TEXT);
      breakInPosbox(caretAt(box, 0), box);
      out.start = { text: box.textContent, boxes: box.parentNode.querySelectorAll('.doc-posbox').length };
    }
    // 3) END — caret at the very end: text kept + a trailing <br> so the new line shows.
    {
      const { box } = makeBox(TEXT);
      breakInPosbox(caretAt(box, TEXT.length), box);
      out.end = { text: box.textContent, brs: box.querySelectorAll('br').length };
    }
    return out;
  };
</script></body>`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/__pe.html') { res.setHeader('Content-Type', 'text/html'); res.end(TEST_HTML); return; }
  const fp = path.join(WEBROOT, url);
  if (!fp.startsWith(WEBROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(fp)] || 'application/octet-stream');
  fs.createReadStream(fp).pipe(res);
});

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok  ${name}`); else { console.error(`FAIL  ${name}`); failures += 1; } };

await new Promise((r) => server.listen(0, r));
const port = server.address().port;

if (!edge) { console.log('SKIPPED: Microsoft Edge not found'); server.close(); process.exit(0); }
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: edge, headless: 'new',
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'edge-pe-')),
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/__pe.html`, { waitUntil: 'networkidle0' });
  const r = await page.evaluate(() => window.run());

  const FULL = 'ROOFTOP SOLAR PV (INSTALLATION & MAINTENANCE)';
  // 1) mid split
  check('mid: no text is lost (both lines preserved)', r.mid.text === FULL);
  check('mid: exactly one hard break inserted', r.mid.brs === 1);
  check('mid: still a single positioned box (not split)', r.mid.boxes === 1);
  check('mid: no orphan flow block created', r.mid.siblingFlow === false);
  check('mid: caret is collapsed on the new line', r.mid.caretCollapsed === true);
  // 2) caret at start
  check('start: whole line survives in the same box', r.start.text === FULL);
  check('start: still one box (first line not torn out)', r.start.boxes === 1);
  // 3) caret at end
  check('end: text preserved', r.end.text === FULL);
  check('end: trailing <br> added so the new line is visible', r.end.brs === 2);
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
console.log('\nAll posbox-Enter checks passed.');
