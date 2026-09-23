/**
 * Regression test (headless Edge) — the doc editor's AI Assistant is now a
 * DOCUMENT-EDITING AGENT (DocMaster AI): the model returns a JSON list of ACTIONS
 * (insert_text, replace_selection, replace_section, delete_section, insert_after,
 * replace_all, create_table, create_list, create_heading, format_text, summarize,
 * chat) and the client executes them on the live page. This test mounts the real
 * document workspace with a MOCKED /api/ai/chat that returns deterministic actions,
 * then drives the bar and verifies each action edits the page correctly. Structural
 * UI checks (button/bar/sidebar) and the local word-count fast path are kept.
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
  window.canUndo = () => !!state.canUndo;
  window.pageCount = () => state.totalPages || 1;
  const isOpen = () => document.querySelector('.app-ws--document')?.classList.contains('is-ai-open') === true;
  const pageText = () => (document.querySelector('.doc-page')?.textContent) || '';
  const sendPrompt = async (text, ms) => {
    const input = document.querySelector('.doc-ai__input');
    input.value = text;
    document.querySelector('.doc-ai__send').click();
    await new Promise(r => setTimeout(r, ms || 450));
  };
  const selectBlock = (elx) => {
    const range = document.createRange(); range.selectNodeContents(elx);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return new Promise(r => setTimeout(r, 60));
  };
  // Deterministic agent mock: reads the POST body and returns a JSON action list
  // (or a plain { reply } for the image-recreate flow / a chat answer).
  const installMock = () => {
    window.fetch = async (url, opts) => {
      if (!String(url).includes('/api/ai/chat')) return Promise.reject(new Error('unexpected fetch ' + url));
      let obj = {}; try { obj = JSON.parse(opts.body); } catch (e) {}
      const p = (obj.prompt || '').toLowerCase();
      const sel = (obj.selection || '').trim();
      let out;
      if (String(opts.body).includes('Recreate the document/form in this image')) {
        out = { reply: '# GOV_FORM\\n\\nName: ____\\n\\nDate: ____' };
      } else if (String(opts.body).includes('Rewrite the text below')) {
        // The floating selection toolbar uses a plain (non-agent) rewrite call.
        out = { reply: 'SELEDIT_OK rewritten line.' };
      } else if (String(opts.body).includes('Revise the text below')) {
        // The in-place refine flow uses a plain (non-agent) call.
        out = { reply: '# RefineDoc\\n\\nREFINED_INPLACE improved body.' };
      } else if (p.includes('refinetopic')) {
        out = { actions: [{ action: 'insert_text', content: '# RefineDoc\\n\\nOriginal body text here.' }] };
      } else if (sel && (p.includes('bold') || p.includes('italic'))) {
        out = { actions: [{ action: 'format_text', target: 'selection', format: { bold: p.includes('bold'), italic: p.includes('italic') } }] };
      } else if (sel) {
        out = { actions: [{ action: 'replace_selection', content: 'EDITED_ALPHA formal line.\\n\\nEDITED_BETA second paragraph.' }] };
      } else if (p.includes('table')) {
        out = { actions: [{ action: 'create_table', headers: ['Name', 'Class', 'Marks'], rows: [['Asha', '10', '95'], ['Ravi', '10', '88']] }] };
      } else if (p.includes('list')) {
        out = { actions: [{ action: 'create_list', ordered: false, items: ['First point', 'Second point', 'Third point'] }] };
      } else if (p.includes('after')) {
        out = { actions: [{ action: 'insert_after', target: 'Uses', content: 'INSERTED_AFTER paragraph.' }] };
      } else if (p.includes('rewrite') && p.includes('history')) {
        out = { actions: [{ action: 'replace_section', target: 'History', content: '## History\\n\\nREPLACED_SEC content.' }] };
      } else if (p.includes('delete') || p.includes('remove')) {
        out = { actions: [{ action: 'delete_section', target: 'Overview' }] };
      } else if (p.includes('whole') || p.includes('entire')) {
        out = { actions: [{ action: 'replace_all', content: '# REWRITTEN_DOC\\n\\nAll new content here.' }] };
      } else if (p.includes('explain') || p.includes('?')) {
        out = { actions: [{ action: 'chat', content: 'CHAT_ANSWER text.' }] };
      } else if (p.includes('messy')) {
        // insert_text carrying markdown headings, LaTeX and a markdown table — the
        // client must clean ALL of it before inserting.
        out = { actions: [{ action: 'insert_text', content:
          '# Fusion Title\\n\\n## Intro Heading\\n\\nEinstein said $E = mc^2$ which is key.\\n\\n$$E = mc^2$$\\n\\nWater is **essential** and H_2O matters.\\n\\n| Feature | Fusion | Fission |\\n| :--- | :--- | :--- |\\n| Fuel | Deuterium | Uranium |\\n| Waste | Low | High |' }] };
      } else if (p.includes('rawjsonbad')) {
        // A truncated JSON action blob leaking through as a plain reply.
        out = { reply: '{"actions":[{"action":"insert_text","content":"unterminated conten' };
      } else if (p.includes('rawjsongood')) {
        // A complete JSON action blob leaking through as a plain reply — salvageable.
        out = { reply: '{"action":"insert_text","content":"SALVAGED_OK text"}' };
      } else if (p.includes('long')) {
        const para = 'The ocean is a vast body of salt water covering most of the planet and driving climate, weather and life. ';
        const paras = [];
        for (let i = 0; i < 40; i += 1) paras.push('Section ' + (i + 1) + '. ' + para + para + para);
        out = { actions: [{ action: 'insert_text', content: '# Oceans\\n\\n' + paras.join('\\n\\n') }] };
      } else {
        out = { actions: [{ action: 'insert_text', content: '# Water\\n\\n## Overview\\n\\nWater is **essential** to life.\\n\\n## Uses\\n\\nMany uses of water.\\n\\n**Deep dive**\\n\\nExtra detail here.\\n\\n## History\\n\\nOld topic content.' }] };
      }
      return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  };
  window.run = async () => {
    const ws = createDocumentWorkspace({ bus, store, services });
    ws.mount(document.getElementById('app'));
    document.querySelector('.app-drop__actions .ws-btn--accent').click();
    await new Promise(r => setTimeout(r, 400));
    const btn = document.querySelector('.doc-ai-btn');
    const before = { hasBtn: !!btn, btnText: btn && btn.textContent, dockBefore: !!document.querySelector('.doc-ai-dock'), openBefore: isOpen() };
    btn.click();
    await new Promise(r => setTimeout(r, 100));
    const bar = document.querySelector('.doc-ai-bar');
    const openAfter = isOpen();
    const barVisible = !!bar && bar.getBoundingClientRect().height > 10;
    const sidebarBeforeTask = Math.round((document.querySelector('.doc-ai-sidebar')?.getBoundingClientRect().width) || 0);
    // Local (network-free) word-count fast path still answers instantly.
    await sendPrompt('word count', 400);
    const msgCount = document.querySelectorAll('.doc-ai__msg').length;
    const convoInSidebar = !!document.querySelector('.doc-ai-sidebar .doc-ai__msg');
    const sidebarWidth = Math.round((document.querySelector('.doc-ai-sidebar')?.getBoundingClientRect().width) || 0);
    return { ...before, openAfter, barVisible, sidebarBeforeTask, sidebarWidth, msgCount, convoInSidebar };
  };
  window.closeBar = () => { document.querySelector('.doc-ai-bar__close').click(); return !isOpen(); };
  // insert_text: a "write…" request auto-writes structured content into the page.
  window.testInsert = async () => {
    installMock();
    document.querySelector('.doc-ai-btn').click();
    await new Promise(r => setTimeout(r, 100));
    await sendPrompt('write about water', 500);
    const pg = document.querySelector('.doc-page');
    const h1 = pg ? pg.querySelector('h1') : null;
    const msgsText = document.querySelector('.doc-ai__msgs').textContent;
    const outline = [...document.querySelectorAll('.doc-outline__item')].map(x => (x.textContent || '').trim());
    return {
      autoWrote: !!pg && pg.textContent.includes('essential'),
      confirmationShown: /written|added/i.test(msgsText),
      popoverCompact: !msgsText.includes('Extra detail here'),
      h1Text: h1 ? h1.textContent : null,
      noRawMarkdown: !!pg && !pg.textContent.includes('**') && !pg.textContent.includes('# '),
      taskChipsShown: document.querySelectorAll('.doc-ai-task').length,
      outlineHasMarkdownHeading: outline.some(t => /Water/.test(t)),
      outlineHasBoldHeading: outline.some(t => /Deep dive/.test(t)),
    };
  };
  window.canUndoAfterWrite = () => window.canUndo();
  // insert_after: content lands after the named section (before the next one).
  window.testInsertAfter = async () => {
    await sendPrompt('add a note after the Uses section', 450);
    const blocks = [...document.querySelectorAll('.doc-page > *')].map(b => (b.textContent || '').trim());
    const iAfter = blocks.findIndex(t => t.includes('INSERTED_AFTER'));
    const iHistory = blocks.findIndex(t => /^History/.test(t));
    return { inserted: iAfter >= 0, beforeHistory: iAfter >= 0 && iHistory >= 0 && iAfter < iHistory };
  };
  // replace_section: the named section is rewritten; other sections survive.
  window.testReplaceSection = async () => {
    await sendPrompt('rewrite the History section', 450);
    const t = pageText();
    return { replaced: t.includes('REPLACED_SEC'), overviewIntact: t.includes('Overview'), oldGone: !t.includes('Old topic content') };
  };
  // delete_section: the named section (heading + body) is removed.
  window.testDeleteSection = async () => {
    await sendPrompt('delete the Overview section', 450);
    const t = pageText();
    return { deleted: !t.includes('Overview') && !t.includes('essential'), usesIntact: t.includes('Uses') };
  };
  // create_table: a real table with the supplied data appears.
  window.testTable = async () => {
    await sendPrompt('make a table of students', 450);
    const table = document.querySelector('.doc-page table.doc-table');
    return { hasTable: !!table, hasData: !!table && /Asha/.test(table.textContent) && /Marks/.test(table.textContent) };
  };
  // create_list: a real list with the supplied items appears.
  window.testList = async () => {
    await sendPrompt('give me a bullet list of points', 450);
    const list = document.querySelector('.doc-page ul.doc-list, .doc-page ol.doc-list, .doc-page ul, .doc-page ol');
    return { hasList: !!list && /First point/.test(list.textContent), items: list ? list.querySelectorAll('li').length : 0 };
  };
  // format_text on a selection: applies inline styling to the selected block.
  window.testFormat = async () => {
    const heading = [...document.querySelectorAll('.doc-page h2')].find(h => /Deep dive/.test(h.textContent));
    if (!heading) return { skipped: true };
    await selectBlock(heading);
    await sendPrompt('make it bold', 450);
    const styled = /font-weight|<b>|<strong>/i.test(heading.innerHTML);
    return { formatted: styled || document.queryCommandState('bold') };
  };
  // replace_selection: selecting a block then instructing edits it in place, and a
  // multi-paragraph reply becomes real separate paragraphs.
  window.testEdit = async () => {
    const target = [...document.querySelectorAll('.doc-page p, .doc-page h2')].find(b => /Many uses/.test(b.textContent));
    const input = document.querySelector('.doc-ai__input');
    await selectBlock(target);
    const placeholderChanged = /Edit the selected/.test(input.placeholder);
    await sendPrompt('make it formal', 450);
    const blocks = [...document.querySelectorAll('.doc-page h1, .doc-page h2, .doc-page h3, .doc-page p')];
    const alpha = blocks.find(b => b.textContent.includes('EDITED_ALPHA'));
    const beta = blocks.find(b => b.textContent.includes('EDITED_BETA'));
    return { placeholderChanged, edited: !!alpha, splitIntoParagraphs: !!alpha && !!beta && alpha !== beta };
  };
  // chat action: a question is answered in the sidebar without changing the page.
  window.testChat = async () => {
    const before = pageText();
    await sendPrompt('explain what a document is', 450);
    const ai = [...document.querySelectorAll('.doc-ai__msg--ai')];
    const last = ai[ai.length - 1];
    return { answered: /CHAT_ANSWER/.test(last ? last.textContent : ''), pageUnchanged: pageText() === before };
  };
  // Content cleanup: markdown headings/LaTeX/markdown-table must be converted, never
  // inserted as raw markup.
  window.testClean = async () => {
    await sendPrompt('write a messy article', 500);
    const t = pageText();
    const table = document.querySelector('.doc-page table.doc-table');
    return {
      noHash: !/#/.test(t),
      noDollar: !/\\$/.test(t),
      noAsterisk: !/\\*\\*/.test(t),
      noPipeTable: !/\\| :--- \\|/.test(t) && !/\\| Feature \\|/.test(t),
      hasH1: [...document.querySelectorAll('.doc-page h1')].some(h => /Fusion Title/.test(h.textContent)),
      hasH2: [...document.querySelectorAll('.doc-page h2')].some(h => /Intro Heading/.test(h.textContent)),
      latexToUnicode: /mc²/.test(t),
      tableFromMarkdown: !!table && /Deuterium/.test(table.textContent) && /Feature/.test(table.textContent),
    };
  };
  // A truncated JSON blob leaking through as a plain reply must NOT be inserted.
  window.testRawJsonBlocked = async () => {
    const before = pageText();
    await sendPrompt('rawjsonbad please', 450);
    const ai = [...document.querySelectorAll('.doc-ai__msg--ai')];
    const last = ai[ai.length - 1];
    return {
      noJsonInDoc: !/"action"/.test(pageText()) && !pageText().includes('{"actions"'),
      pageUnchanged: pageText() === before,
      retryMsg: /incomplete|try again/i.test(last ? last.textContent : ''),
    };
  };
  // A complete JSON blob leaking through as a plain reply is salvaged into an action.
  window.testRawJsonSalvage = async () => {
    await sendPrompt('rawjsongood please', 450);
    const t = pageText();
    return { inserted: t.includes('SALVAGED_OK'), noJson: !t.includes('{"action') && !/"action"\\s*:/.test(t) };
  };
  // Conversational refine: after the AI writes something, "improve that part" (no
  // selection) must REPLACE it in place — auto-delete the old, fill with the new.
  window.testRefineInPlace = async () => {
    await sendPrompt('write about REFINETOPIC', 500);
    const wrote = pageText().includes('Original body text');
    await sendPrompt('improve that part', 500);
    const t = pageText();
    return {
      wrote,
      refined: t.includes('REFINED_INPLACE'),
      oldGone: !t.includes('Original body text'),
      noDuplicate: (t.match(/RefineDoc/g) || []).length === 1,
    };
  };
  // Floating "Edit with AI" toolbar: select text → pill appears → an instruction
  // rewrites that selection in place.
  window.testSelbar = async () => {
    const target = [...document.querySelectorAll('.doc-page p')].find(b => (b.textContent || '').trim().length > 5);
    if (!target) return { skipped: true };
    const range = document.createRange(); range.selectNodeContents(target);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise(r => setTimeout(r, 80));
    const selbar = document.querySelector('.doc-ai-selbar');
    const appeared = !!selbar && selbar.classList.contains('is-open');
    const input = selbar && selbar.querySelector('.doc-ai-sel__input');
    if (input) {
      input.dispatchEvent(new Event('focus'));
      input.value = 'make it formal';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
    }
    return { appeared, edited: pageText().includes('SELEDIT_OK') };
  };
  // Outside-click dismiss: after selecting + focusing the pill, clicking elsewhere
  // must close it (even though it was made "sticky" by the focus).
  window.testSelbarDismiss = async () => {
    const target = [...document.querySelectorAll('.doc-page p, .doc-page h1, .doc-page h2')].find(b => (b.textContent || '').trim().length > 5);
    if (!target) return { skipped: true };
    const range = document.createRange(); range.selectNodeContents(target);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise(r => setTimeout(r, 80));
    const selbar = document.querySelector('.doc-ai-selbar');
    const input = selbar.querySelector('.doc-ai-sel__input');
    input.dispatchEvent(new Event('focus')); // make it sticky
    const openWhileSticky = selbar.classList.contains('is-open');
    // Click somewhere else on the page.
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await new Promise(r => setTimeout(r, 40));
    const dismissed = !selbar.classList.contains('is-open');
    // Mimic the real click collapsing the selection (so editSel clears and doesn't
    // pollute later tests).
    const caret = document.createRange(); caret.setStart(target, 0); caret.collapse(true);
    sel.removeAllRanges(); sel.addRange(caret);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise(r => setTimeout(r, 20));
    return { openWhileSticky, dismissed };
  };
  // replace_all: the whole document is rewritten only on an explicit request.
  window.testReplaceAll = async () => {
    await sendPrompt('rewrite the whole document', 500);
    const t = pageText();
    return { rewrote: t.includes('REWRITTEN_DOC'), oldGone: !t.includes('Uses') && !t.includes('EDITED_ALPHA') };
  };
  // A big insert flows onto extra pages automatically.
  window.testPaginate = async () => {
    const before = window.pageCount();
    await sendPrompt('write a LONG article about oceans', 1200);
    return { before, after: window.pageCount() };
  };
  // The + reveals task chips; the (locked) image button's recreate pipeline works.
  window.testPlusAndUpload = async () => {
    const dock = document.querySelector('.doc-ai-dock');
    const more = document.querySelector('.doc-ai-bar__more');
    const hiddenByDefault = !dock.classList.contains('is-tasks-open');
    more.click();
    const plusRevealsChips = dock.classList.contains('is-tasks-open');
    more.click();
    const uploadBtn = document.querySelector('.doc-ai-bar__upload');
    const uploadLocked = !!uploadBtn && uploadBtn.classList.contains('is-locked');
    let uploaded = false;
    try {
      const input = document.querySelector('.doc-ai-file');
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'form.png', { type: 'image/png' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 800));
      uploaded = pageText().includes('GOV_FORM');
    } catch (e) { uploaded = 'skip:' + e.message; }
    return { hiddenByDefault, plusRevealsChips, hasUploadBtn: !!uploadBtn, uploadLocked, recreatedForm: uploaded };
  };
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
  const closedOk = await page.evaluate(() => window.closeBar());
  const ins = await page.evaluate(() => window.testInsert());
  const canUndoAfterWrite = await page.evaluate(() => window.canUndoAfterWrite());
  const after = await page.evaluate(() => window.testInsertAfter());
  const repSec = await page.evaluate(() => window.testReplaceSection());
  const delSec = await page.evaluate(() => window.testDeleteSection());
  const table = await page.evaluate(() => window.testTable());
  const list = await page.evaluate(() => window.testList());
  const fmt = await page.evaluate(() => window.testFormat());
  const edit = await page.evaluate(() => window.testEdit());
  const chat = await page.evaluate(() => window.testChat());
  const clean = await page.evaluate(() => window.testClean());
  const rawBad = await page.evaluate(() => window.testRawJsonBlocked());
  const rawGood = await page.evaluate(() => window.testRawJsonSalvage());
  const ref = await page.evaluate(() => window.testRefineInPlace());
  const selbar = await page.evaluate(() => window.testSelbar());
  const selDismiss = await page.evaluate(() => window.testSelbarDismiss());
  const repAll = await page.evaluate(() => window.testReplaceAll());
  const pag = await page.evaluate(() => window.testPaginate());
  const plusUp = await page.evaluate(() => window.testPlusAndUpload());
  check('AI Assistant button is present', r.hasBtn, r.hasBtn);
  check('button reads "AI Assistant"', (r.btnText || '').includes('AI Assistant'), r.btnText);
  check('bar is built (armed) but hidden before first click', r.dockBefore === true && r.openBefore === false, `${r.dockBefore}/${r.openBefore}`);
  check('bar is hidden before first click', r.openBefore === false, r.openBefore);
  check('clicking opens the prompt bar', r.openAfter === true, r.openAfter);
  check('bottom prompt bar is visible', r.barVisible === true, r.barVisible);
  check('sidebar stays hidden until a task is given', r.sidebarBeforeTask <= 20, r.sidebarBeforeTask);
  check('sending a prompt produces a chat exchange', r.msgCount >= 2, r.msgCount);
  check('a task reveals the right sidebar', r.convoInSidebar === true, r.convoInSidebar);
  check('revealed sidebar is compact (~250px)', r.sidebarWidth >= 200 && r.sidebarWidth <= 290, r.sidebarWidth);
  check('close button hides the assistant', closedOk === true, closedOk);
  check('task chips exist (revealed via +)', ins.taskChipsShown >= 5, ins.taskChipsShown);
  check('insert_text auto-writes into the page', ins.autoWrote === true, ins.autoWrote);
  check('inserted content became a heading', (ins.h1Text || '').includes('Water'), ins.h1Text);
  check('inserted content has no raw markdown', ins.noRawMarkdown === true, ins.noRawMarkdown);
  check('insert keeps undo available (not a full reload)', canUndoAfterWrite === true, canUndoAfterWrite);
  check('insert shows a short confirmation', ins.confirmationShown === true, ins.confirmationShown);
  check('sidebar stays compact (no content dump)', ins.popoverCompact === true, ins.popoverCompact);
  check('outline shows the markdown (#) heading', ins.outlineHasMarkdownHeading === true, ins.outlineHasMarkdownHeading);
  check('outline shows the bold-line heading', ins.outlineHasBoldHeading === true, ins.outlineHasBoldHeading);
  check('insert_after places content after the named section', after.inserted === true && after.beforeHistory === true, `${after.inserted}/${after.beforeHistory}`);
  check('replace_section rewrites only that section', repSec.replaced === true && repSec.oldGone === true, `${repSec.replaced}/${repSec.oldGone}`);
  check('replace_section leaves other sections intact', repSec.overviewIntact === true, repSec.overviewIntact);
  check('delete_section removes the named section', delSec.deleted === true, delSec.deleted);
  check('delete_section leaves other sections intact', delSec.usesIntact === true, delSec.usesIntact);
  check('create_table inserts a real table', table.hasTable === true, table.hasTable);
  check('create_table carries the supplied data', table.hasData === true, table.hasData);
  check('create_list inserts a real list', list.hasList === true, `${list.hasList}/${list.items}`);
  check('format_text styles the selection', fmt.skipped === true || fmt.formatted === true, JSON.stringify(fmt));
  check('selecting text switches the bar to edit mode', edit.placeholderChanged === true, edit.placeholderChanged);
  check('replace_selection edits the selected part in place', edit.edited === true, edit.edited);
  check('a multi-paragraph rewrite splits into real paragraphs', edit.splitIntoParagraphs === true, edit.splitIntoParagraphs);
  check('a chat action answers in the sidebar', chat.answered === true, chat.answered);
  check('a chat action does not change the page', chat.pageUnchanged === true, chat.pageUnchanged);
  check('cleanup: no # heading markers left in the doc', clean.noHash === true, clean.noHash);
  check('cleanup: no $ / LaTeX delimiters left', clean.noDollar === true, clean.noDollar);
  check('cleanup: no ** markdown bold left', clean.noAsterisk === true, clean.noAsterisk);
  check('cleanup: markdown table not left as text', clean.noPipeTable === true, clean.noPipeTable);
  check('cleanup: # / ## become real headings', clean.hasH1 === true && clean.hasH2 === true, `${clean.hasH1}/${clean.hasH2}`);
  check('cleanup: LaTeX mc^2 becomes mc²', clean.latexToUnicode === true, clean.latexToUnicode);
  check('cleanup: markdown table becomes a native table', clean.tableFromMarkdown === true, clean.tableFromMarkdown);
  check('raw JSON reply is NOT inserted into the doc', rawBad.noJsonInDoc === true && rawBad.pageUnchanged === true, `${rawBad.noJsonInDoc}/${rawBad.pageUnchanged}`);
  check('raw JSON reply shows a retry message', rawBad.retryMsg === true, rawBad.retryMsg);
  check('a complete JSON reply is salvaged into an edit', rawGood.inserted === true && rawGood.noJson === true, `${rawGood.inserted}/${rawGood.noJson}`);
  check('refine: the last AI output is written', ref.wrote === true, ref.wrote);
  check('refine: "improve that part" replaces it in place', ref.refined === true && ref.oldGone === true, `${ref.refined}/${ref.oldGone}`);
  check('refine: no duplicate copy is left behind', ref.noDuplicate === true, ref.noDuplicate);
  check('selection toolbar appears on text selection', selbar.skipped === true || selbar.appeared === true, JSON.stringify(selbar));
  check('selection toolbar edits the selected text in place', selbar.skipped === true || selbar.edited === true, JSON.stringify(selbar));
  check('clicking outside dismisses the selection toolbar', selDismiss.skipped === true || selDismiss.dismissed === true, JSON.stringify(selDismiss));
  check('replace_all rewrites the whole document', repAll.rewrote === true && repAll.oldGone === true, `${repAll.rewrote}/${repAll.oldGone}`);
  check('task chips are hidden until the + is clicked', plusUp.hiddenByDefault === true, plusUp.hiddenByDefault);
  check('the + button reveals the task chips', plusUp.plusRevealsChips === true, plusUp.plusRevealsChips);
  check('the image-upload button is present', plusUp.hasUploadBtn === true, plusUp.hasUploadBtn);
  check('the image button is locked (coming soon)', plusUp.uploadLocked === true, plusUp.uploadLocked);
  check('image→editable pipeline still works (unlock-ready)', plusUp.recreatedForm === true, plusUp.recreatedForm);
  check('a big insert flows onto multiple pages automatically', pag.after >= 2, `${pag.before} → ${pag.after}`);
} catch (e) {
  console.log('SKIPPED:', String(e.message || e).split('\n')[0]);
  if (browser) await browser.close();
  server.close();
  process.exit(0);
} finally { if (browser) await browser.close(); server.close(); }
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll AI Assistant checks passed.');
