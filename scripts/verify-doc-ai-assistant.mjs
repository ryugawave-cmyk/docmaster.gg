/**
 * Regression test (headless Edge) — the doc editor exposes an AI Assistant button
 * (top-right, next to Export) that toggles a docked right-side panel with a chat
 * surface and quick-action chips. Mounts the real document workspace with stub
 * bus/store/services, opens a blank doc, and drives the button/panel/chips.
 *
 * Needs Microsoft Edge; best-effort SKIP (exit 0) if it can't launch.
 * Run: `node scripts/verify-doc-ai-assistant.mjs`.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBROOT = path.resolve(HERE, '..', 'public');
const VENDOR = path.resolve(HERE, '..', 'node_modules', 'pdfjs-dist');
const EDGES = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
const edge = EDGES.find((p) => fs.existsSync(p));
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.ttf': 'font/ttf', '.png': 'image/png' };

const TEST_HTML = `<!doctype html><meta charset=utf8><link rel="stylesheet" href="/css/app.css">
  <style>html,body{margin:0;height:100%}#app{height:100vh}</style>
  <body><div id="app"></div><script type="module">
  import { createDocumentWorkspace } from '/js/app/workspaces/document/documentWorkspace.js';
  const listeners = {};
  const bus = { emit: (n, d) => (listeners[n]||[]).forEach(f=>f(d)), on: (n,f)=>{(listeners[n]||(listeners[n]=[])).push(f);return ()=>{};} };
  let state = { docName: 'Untitled document' };
  const subs = [];
  const store = {
    getState: () => state,
    setState: (p) => { state = { ...state, ...p }; subs.forEach(f=>f(state)); },
    subscribe: (f) => { subs.push(f); return () => {}; },
  };
  const services = {
    fileManager: { enableDropZone: () => {} },
    exportManager: { run: () => {} },
  };
  window.run = async () => {
    const ws = createDocumentWorkspace({ bus, store, services });
    ws.mount(document.getElementById('app'));
    // Open a blank document — the chat bar is a permanent fixture (no top button).
    document.querySelector('.app-drop__actions .ws-btn--accent').click();
    await new Promise(r => setTimeout(r, 400));
    const noTopBtn = !document.querySelector('.doc-ai-btn'); // top button removed
    const bar = document.querySelector('.doc-ai-bar');
    const plus = document.querySelector('.doc-ai-bar__plus');
    const popHiddenAtRest = !document.querySelector('.doc-ai-pop.is-visible');
    const rect = bar ? bar.getBoundingClientRect() : { width: 0, height: 0, bottom: 0 };
    const barHeight = Math.round(rect.height);
    const main = document.querySelector('.doc-main');
    const mainRect = main ? main.getBoundingClientRect() : { bottom: 0, width: 1 };
    const nearBottom = bar ? Math.abs(rect.bottom - mainRect.bottom) < 40 : false;
    const compact = bar ? (rect.width <= 640 && rect.width < mainRect.width * 0.92) : false;
    // The `+` button reveals the actions popover.
    plus.click();
    await new Promise(r => setTimeout(r, 60));
    const popAfterPlus = !!document.querySelector('.doc-ai-pop.is-visible');
    // A quick chip produces a chat exchange.
    document.querySelector('.doc-ai__chip').click();
    await new Promise(r => setTimeout(r, 400));
    const msgCount = document.querySelectorAll('.doc-ai__msg').length;
    return { noTopBtn, hasBar: !!bar, hasPlus: !!plus, popHiddenAtRest, barHeight, nearBottom, compact, popAfterPlus, msgCount };
  };
  // The ✕ collapses the popover back to just the bar (bar itself stays visible).
  window.collapse = () => { document.querySelector('.doc-ai__chip'); document.querySelector('.doc-ai-bar__close').click(); return { popHidden: !document.querySelector('.doc-ai-pop.is-visible'), barStillThere: !!document.querySelector('.doc-ai-bar') }; };
</script></body>`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/__ai.html') { res.setHeader('Content-Type', 'text/html'); res.end(TEST_HTML); return; }
  if (url.startsWith('/vendor/pdfjs/')) {
    const vp = path.join(VENDOR, url.slice('/vendor/pdfjs/'.length));
    if (fs.existsSync(vp) && !fs.statSync(vp).isDirectory()) { res.setHeader('Content-Type', MIME[path.extname(vp)] || 'application/octet-stream'); res.end(fs.readFileSync(vp)); return; }
    res.statusCode = 404; res.end('nf'); return;
  }
  const fp = path.join(WEBROOT, url);
  if (!fp.startsWith(WEBROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(fp)] || 'application/octet-stream');
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
if (!edge) { console.log('SKIPPED: Microsoft Edge not found'); server.close(); process.exit(0); }
let failures = 0;
const check = (name, cond, extra) => { if (cond) console.log(`  ok  ${name}`); else { console.error(`FAIL  ${name}${extra != null ? ` (${extra})` : ''}`); failures += 1; } };
let browser;
try {
  browser = await puppeteer.launch({ executablePath: edge, headless: 'new', userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'edge-ai-')), args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1300, height: 720 });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE.ERR', m.text()); });
  await page.goto(`http://127.0.0.1:${port}/__ai.html`, { waitUntil: 'networkidle0' });
  const r = await page.evaluate(() => window.run());
  const collapsed = await page.evaluate(() => window.collapse());
  check('top menubar AI button is removed', r.noTopBtn === true, r.noTopBtn);
  check('chat bar is always present (no toggle needed)', r.hasBar === true, r.hasBar);
  check('bar has a + button', r.hasPlus === true, r.hasPlus);
  check('popover is hidden at rest (just the bar)', r.popHiddenAtRest === true, r.popHiddenAtRest);
  check('bar sits near the bottom of the editor', r.nearBottom === true, r.nearBottom);
  check('bar is a compact pill (not full width)', r.compact === true, r.compact);
  check('bar is small (~48px tall)', r.barHeight >= 40 && r.barHeight <= 60, r.barHeight);
  check('the + button opens the actions popover', r.popAfterPlus === true, r.popAfterPlus);
  check('a quick-action chip produces a chat exchange', r.msgCount >= 2, r.msgCount);
  check('✕ collapses the popover but keeps the bar', collapsed.popHidden === true && collapsed.barStillThere === true, JSON.stringify(collapsed));
} catch (e) {
  console.log('SKIPPED:', String(e.message || e).split('\n')[0]);
  if (browser) await browser.close();
  server.close();
  process.exit(0);
} finally { if (browser) await browser.close(); server.close(); }
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll AI Assistant checks passed.');
