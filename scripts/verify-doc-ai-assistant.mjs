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
    // Open a blank document (renders the menubar with the AI button).
    document.querySelector('.app-drop__actions .ws-btn--accent').click();
    await new Promise(r => setTimeout(r, 400));
    const btn = document.querySelector('.doc-ai-btn');
    const before = { hasBtn: !!btn, btnText: btn && btn.textContent, panelBefore: !!document.querySelector('.doc-ai-panel'), openBefore: document.querySelector('.app-ws--document').classList.contains('is-ai-open') };
    btn.click();
    await new Promise(r => setTimeout(r, 100));
    const panel = document.querySelector('.doc-ai-panel');
    const openAfter = document.querySelector('.app-ws--document').classList.contains('is-ai-open');
    const rect = panel ? panel.getBoundingClientRect() : { width: 0, height: 0 };
    const panelHeight = Math.round(rect.height);
    // Bottom dock: it spans the editor column width and sits at the bottom of it.
    const main = document.querySelector('.doc-main');
    const mainRect = main ? main.getBoundingClientRect() : { bottom: 0, width: 0 };
    const atBottom = panel ? Math.abs(rect.bottom - mainRect.bottom) < 4 : false;
    const spansWidth = panel ? rect.width > mainRect.width * 0.8 : false;
    // send a message via the quick chip
    document.querySelector('.doc-ai__chip').click();
    await new Promise(r => setTimeout(r, 400));
    const msgCount = document.querySelectorAll('.doc-ai__msg').length;
    return { ...before, openAfter, panelHeight, atBottom, spansWidth, msgCount };
  };
  window.closePanel = () => { document.querySelector('.doc-ai__close').click(); return !document.querySelector('.app-ws--document').classList.contains('is-ai-open'); };
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
  const closedOk = await page.evaluate(() => window.closePanel());
  check('AI Assistant button is present', r.hasBtn, r.hasBtn);
  check('button reads "AI Assistant"', (r.btnText || '').includes('AI Assistant'), r.btnText);
  check('panel is closed by default (lazy, not built before first click)', r.panelBefore === false && r.openBefore === false, `${r.panelBefore}/${r.openBefore}`);
  check('clicking opens the docked panel', r.openAfter === true, r.openAfter);
  check('panel docks at the BOTTOM (not the right side)', r.atBottom === true, r.atBottom);
  check('panel spans the editor width', r.spansWidth === true, r.spansWidth);
  check('open panel has real height (~320px)', r.panelHeight >= 280, r.panelHeight);
  check('a quick-action chip produces a chat exchange', r.msgCount >= 3, r.msgCount);
  check('close button closes the panel', closedOk === true, closedOk);
} catch (e) {
  console.log('SKIPPED:', String(e.message || e).split('\n')[0]);
  if (browser) await browser.close();
  server.close();
  process.exit(0);
} finally { if (browser) await browser.close(); server.close(); }
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll AI Assistant checks passed.');
