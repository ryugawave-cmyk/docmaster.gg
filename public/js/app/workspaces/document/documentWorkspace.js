/**
 * Document workspace — a Word / Google-Docs style rich-text editor.
 *
 * This is a SEPARATE editing surface from the PDF workspace. Where the PDF
 * workspace annotates positioned pages (`blankEditorShell.js`), this one edits a
 * flowing document — headings, paragraphs, lists, tables and images — on a
 * `contentEditable` page via `editor/documentEditor.js`.
 *
 * The two editors deliberately share the Unified Document Model
 * (`model/documentModel.js`): the same block/run structure the PDF importer can
 * build is what this editor renders, edits and exports (DOCX / PDF / HTML). Only
 * the UI and tools differ.
 */
import { el } from '../../../workspace/utils/dom.js';
import { renderIcon } from '../../../workspace/icons.js';
import { selection, emptySelection, SelectionKind } from '../../core/selection.js';
import { createDocumentEditor } from '../../editor/documentEditor.js';
import { createBlankDocument, createDocument, createParagraph, createRun, createTableBlock, createListBlock, documentToText } from '../../model/documentModel.js';
import { blockModelToDocx, blockModelToPdf, htmlBlob } from '../../services/convert/blockExport.js';
import { docxToBlockModel } from '../../services/convert/docxImport.js';
import { createDocExportPanel } from './docExportPanel.js';
import { openShapePicker } from './docShapePicker.js';
import { openStampPicker } from './docStampPicker.js';
import { stampSvgMarkup } from '../../editor/stampLibrary.js';
import { openChartPicker } from './chartPicker.js';
import { defaultChart } from '../../editor/chartRender.js';
import { openCalculator } from '../../editor/calculator.js';
import { openSymbolLibrary } from '../../editor/symbolLibrary.js';
import { FONT_OPTIONS } from '../../properties/index.js';

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64];

export function createDocumentWorkspace({ bus, store, services }) {
  let root = null;
  let menubarEl = null;
  let toolbarEl = null;
  let rulerEl = null;
  let outlineEl = null;
  let hostEl = null;
  let editor = null;
  let docZoom = 1; // page zoom factor (mirrors editor zoom; scales the ruler too)
  let hasDoc = false;
  let advExportPanel = null; // lazily-built Advanced Export modal
  let outlineOpen = true; // left "tabs & outline" panel open by default
  const ui = {}; // references to toolbar controls we reflect selection state into

  /* -------------------------------- mount ------------------------------- */
  function mount(container) {
    root = el('div', { class: 'app-ws app-ws--document' });
    container.appendChild(root);
    services.fileManager.enableDropZone(root, (files) => bus.emit('file:dropped', files));
    renderEmpty();
  }

  // Enter the dedicated word-processor layout (own menu/format bars; shared
  // toolbar/nav/panel hidden, status bar kept) only while a document is open.
  // The empty "create or open" screen keeps the normal shell so the nav is
  // reachable. Restored on deactivate / when the document is closed.
  function setDocMode(on) {
    store.setState({ docMode: on });
  }

  function renderEmpty() {
    hasDoc = false;
    setDocMode(false);
    root.replaceChildren(
      el('div', { class: 'app-drop' }, [
        el('span', { class: 'app-drop__icon', html: renderIcon('new-doc') }),
        el('h2', { class: 'app-drop__title' }, 'Create or open a document'),
        el('p', { class: 'app-drop__lead' }, 'Write from a blank page, or open a Word (.docx), text or Markdown file.'),
        el('div', { class: 'app-drop__actions' }, [
          el('button', { class: 'ws-btn ws-btn--lg ws-btn--accent', type: 'button', onClick: () => newBlank() }, 'New document'),
          el('button', { class: 'ws-btn ws-btn--lg', type: 'button', onClick: () => bus.emit('nav:command', { command: 'open', arg: 'document' }) }, 'Open document'),
        ]),
      ])
    );
  }

  /* --------------------------- editor scaffold -------------------------- */
  function ensureEditor() {
    if (editor) return editor;
    // A Word / Google-Docs style stack: a menu bar, then a single formatting
    // toolbar, then the scrolling page host. The document page is the focus.
    menubarEl = el('div', { class: 'doc-menubar', role: 'menubar', 'aria-label': 'Menus' });
    buildMenuBar(menubarEl);
    toolbarEl = el('div', { class: 'doc-toolbar', role: 'toolbar', 'aria-label': 'Formatting' });
    buildToolbar(toolbarEl);
    // Left "tabs & outline" panel (Google-Docs style), collapsible.
    outlineEl = el('div', { class: 'doc-outline is-open' });
    buildOutline(outlineEl);
    // Horizontal ruler bar (kept visible above the page); its measured region and
    // draggable margin markers mirror the page geometry.
    rulerEl = el('div', { class: 'doc-rulerbar', 'aria-hidden': 'true' });
    hostEl = el('div', { class: 'doc-host' });
    // Floating zoom control at the page's bottom-right (the shell's zoom lives in
    // the top toolbar, which is hidden in doc mode — so the editor carries its own).
    const zoomCtl = mkZoomControl();
    // Body row: [outline | main(ruler + page)] so the ruler sits above the page
    // only, with the outline panel spanning the full height to its left.
    const main = el('div', { class: 'doc-main' }, [rulerEl, hostEl, zoomCtl]);
    ui.docMain = main; // AI Assistant panel docks at the bottom of this column
    ui.docBody = el('div', { class: 'doc-body' }, [outlineEl, main]);
    root.replaceChildren(menubarEl, toolbarEl, ui.docBody);
    // Restore the remembered theme preference for the document editor.
    try { if (localStorage.getItem('alvion:doc-theme') === 'dark') setDark(true); } catch (e) { /* noop */ }
    editor = createDocumentEditor({
      container: hostEl,
      onChange: ({ canUndo, canRedo }) => { store.setState({ canUndo, canRedo }); refreshOutline(); },
      onSelection: reflectSelection,
      // Keep the shell's page counter in sync with the real laid-out pages (the
      // editor reports this after every pagination pass and on scroll).
      onPaginate: ({ pageCount, currentPage }) => store.setState({ totalPages: pageCount, currentPage }),
      // The header/footer "Options ▾ · Header & footer settings" opens our dialog.
      onRequestHfSettings: () => openHfSettings(),
    });
    // Build the AI machinery now (not lazily) so the floating "Edit with AI"
    // selection toolbar is armed as soon as the user selects text — no need to open
    // the AI panel first. The dock/sidebar stay hidden until toggled.
    if (!ui.aiPanel) buildAiPanel();
    return editor;
  }

  function loadDoc(doc, name) {
    ensureEditor();
    editor.load(doc);
    editor.setEditable(true);
    hasDoc = true;
    setDocMode(true);
    docZoom = editor.setZoom(1); // fresh document opens at 100%
    store.setState({
      file: { name, size: 0, type: 'application/vnd.docmaster.doc' },
      docName: name,
      // totalPages / currentPage are set by the editor's onPaginate callback,
      // which already fired during editor.load() above with the real page count.
      zoom: 1,
      // The properties panel stays hidden by default — all common formatting
      // now lives in the single top toolbar (Word/Docs feel).
      panelOpen: false,
      status: 'ready',
      statusMessage: 'Ready',
      canUndo: false,
      canRedo: false,
    });
    if (ui.docName) ui.docName.textContent = name;
    renderRuler();
    refreshOutline();
    bus.emit('selection:change', textSelection());
    requestAnimationFrame(() => editor.focus());
  }

  function newBlank() {
    loadDoc(createBlankDocument('Untitled document'), 'Untitled document');
  }

  /* ------------------------------- menu bar ----------------------------- */
  // A Word / Google-Docs style menu bar: File · Edit · View · Insert · Format ·
  // Tools. Each opens a popover of real actions (the menus route to the same
  // editor + export/save code the toolbar uses). One menu is open at a time and
  // hovering another top item switches to it, like a native menu bar.
  let openMenu = null; // { el, btn }
  let toolbarHidden = false;
  let highlightColor = '#ffe64d'; // current highlighter (marker) colour
  let highlightOn = false; // is the caret/selection currently highlighted?

  // ----- Dark theme toggle (mirrors the PDF editor's dark mode) -----------
  // Toggles `.is-dark` on the document root; the palette lives in app.css. The
  // choice is remembered per device. The page itself stays white paper.
  function setDark(on) {
    if (!root) return;
    root.classList.toggle('is-dark', !!on);
    if (ui.themeToggle) {
      ui.themeToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      ui.themeToggle.classList.toggle('is-on', !!on);
    }
    try { localStorage.setItem('alvion:doc-theme', on ? 'dark' : 'light'); } catch (e) { /* storage blocked */ }
  }
  function mkThemeToggle() {
    ui.themeToggle = el('button', {
      class: 'doc-btn doc-menubar__theme', type: 'button',
      'data-tip': 'Toggle dark mode', 'aria-label': 'Toggle dark mode', 'aria-pressed': 'false',
      onClick: () => setDark(!root.classList.contains('is-dark')),
    }, el('span', { class: 'doc-btn__ico', html: renderIcon('moon') }));
    return ui.themeToggle;
  }

  function buildMenuBar(bar) {
    const brand = el('button', {
      class: 'doc-menubar__brand', type: 'button', 'data-tip': 'Close document',
      'aria-label': 'Close document and go home', onClick: backHome,
    }, el('span', { class: 'doc-menubar__logo' }, [el('img', { class: 'doc-menubar__logo-img', src: '/images/logo-mark.png', alt: '' })]));
    ui.docName = el('span', { class: 'doc-menubar__title', title: 'Document name' }, store.getState().docName || 'Untitled document');

    bar.replaceChildren(
      el('div', { class: 'doc-menubar__left' }, [brand, ui.docName]),
      el('div', { class: 'doc-menubar__menus' }, [
        mkMenu('File', fileMenu),
        mkMenu('Edit', editMenu),
        mkMenu('View', viewMenu),
        mkMenu('Insert', insertMenu),
        mkMenu('Format', formatMenu),
        mkMenu('Tools', toolsMenu),
        // Quick-insert icons sit right after Tools, like the reference layout.
        el('div', { class: 'doc-menubar__insert' }, [
          mkTablePicker(),
          mkBtn('image', 'Insert image', pickImage),
          mkBtn('stamp', 'Insert stamp', insertStamp),
          mkBtn('chart', 'Professional Library — charts & graphs', openProLibrary),
        ]),
      ]),
      // Download lives at the top-right of the menu bar (pushed there via CSS).
      el('div', { class: 'doc-menubar__right' }, [mkThemeToggle(), mkAiAssistant(), mkExportMenu()]),
    );
  }

  // AI Assistant: a gradient-glow button at the top-right (next to Export) that
  // opens the assistant — a docked right sidebar for the conversation plus a small
  // floating prompt bar at the bottom of the document (see buildAiPanel).
  function mkAiAssistant() {
    ui.aiBtn = el('button', {
      class: 'doc-btn doc-ai-btn', type: 'button',
      'data-tip': 'AI Assistant', 'aria-label': 'AI Assistant', 'aria-pressed': 'false',
      onClick: () => toggleAiPanel(),
    }, [
      el('span', { class: 'doc-ai-btn__ico', html: renderIcon('sparkle') }),
      el('span', { class: 'doc-ai-btn__txt' }, 'AI Assistant'),
    ]);
    return ui.aiBtn;
  }

  /* ------------------------------ AI Assistant ------------------------------ */
  // A ChatGPT/Copilot-style assistant: a fixed right SIDEBAR holds the whole
  // conversation + tools (it's a flex child of .doc-body, so the document canvas
  // resizes to make room — it never overlaps the page), and a small floating
  // prompt bar at the bottom carries the input + suggestion chips. Both are driven
  // by one `is-ai-open` state class on the workspace root for a coordinated,
  // animated open/close. Built lazily on first open and reused thereafter.
  function toggleAiPanel() {
    if (!ui.aiPanel) buildAiPanel();
    const open = !root.classList.contains('is-ai-open');
    root.classList.toggle('is-ai-open', open);
    // Clicking the button only shows the prompt bar; the sidebar reveals itself once
    // a conversation exists (or stays if one already does).
    if (open && ui.aiMsgs && ui.aiMsgs.querySelector('.doc-ai__msg')) root.classList.add('is-ai-chat');
    ui.aiBtn?.setAttribute('aria-pressed', open ? 'true' : 'false');
    ui.aiBtn?.classList.toggle('is-on', open);
    if (open) requestAnimationFrame(() => ui.aiInput?.focus());
  }
  function closeAiPanel() {
    root.classList.remove('is-ai-open', 'is-ai-chat');
    ui.aiBtn?.setAttribute('aria-pressed', 'false');
    ui.aiBtn?.classList.remove('is-on');
  }
  // Collapse just the conversation sidebar (keeps the prompt bar open).
  function closeChat() { root.classList.remove('is-ai-chat'); }

  function buildAiPanel() {
    const msgs = el('div', { class: 'doc-ai__msgs', role: 'log', 'aria-live': 'polite' });
    ui.aiMsgs = msgs;
    // Each bubble has a text body; AI bubbles also get an "Insert into document"
    // button (revealed only for real, insertable replies). Returns a handle whose
    // setText(text, insertable) fills the reply and shows/hides that button.
    const addMsg = (who, text) => {
      const body = el('div', { class: 'doc-ai__msg-text' }, text);
      const children = [body];
      let insertBtn = null;
      if (who === 'ai') {
        insertBtn = el('button', {
          class: 'doc-ai__insert', type: 'button', hidden: true,
          onClick: () => insertIntoDoc(body.textContent || ''),
        }, 'Insert into document');
        children.push(insertBtn);
      }
      const bubble = el('div', { class: `doc-ai__msg doc-ai__msg--${who}` }, children);
      ui.aiEmpty?.remove(); ui.aiEmpty = null; // drop the empty-state hint on first message
      msgs.appendChild(bubble);
      msgs.scrollTop = msgs.scrollHeight;
      root.classList.add('is-ai-chat'); // a task/message reveals the conversation sidebar
      return {
        el: bubble,
        setText(t, insertable) {
          body.textContent = t;
          if (insertBtn) insertBtn.hidden = !insertable;
          msgs.scrollTop = msgs.scrollHeight;
        },
      };
    };

    const input = el('textarea', {
      class: 'doc-ai__input', rows: '1', placeholder: 'Ask the AI to help with your document…',
      'aria-label': 'Message the AI Assistant',
      onKeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } },
      onInput: (e) => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(180, e.target.scrollHeight)}px`; },
    });
    ui.aiInput = input;
    const sendBtn = el('button', {
      class: 'doc-ai__send', type: 'button', 'data-tip': 'Send', 'aria-label': 'Send',
      onClick: () => submit(),
    }, el('span', { html: renderIcon('sparkle') }));

    function docText() {
      try { return documentToText(editor.getModel()).replace(/\n{2,}/g, '\n').trim(); } catch { return ''; }
    }
    // Deterministic asks (word/character count, reading time) are answered locally
    // and instantly — no network round-trip. Returns null when the ask needs the
    // model. Empty-doc guidance stays local too.
    function localAnswer(prompt) {
      const text = docText();
      const p = prompt.toLowerCase();
      if (/\b(word|character|char|count|how many|length|reading time)\b/.test(p)) {
        if (!text) return 'Your document is empty — add some text first.';
        const words = text.split(/\s+/).filter(Boolean).length;
        const chars = text.length;
        const mins = Math.max(1, Math.round(words / 200));
        return `Your document has ${words.toLocaleString()} words and ${chars.toLocaleString()} characters — about a ${mins}-minute read.`;
      }
      return null;
    }

    // Ask the server-side proxy (/api/ai/chat), which holds the API key and calls
    // the configured model. The key never touches the browser. `contextText` lets a
    // caller override the document context (e.g. '' for fresh generation/edits).
    async function askModel(prompt, contextText, image) {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, text: contextText != null ? contextText : docText(), image: image || null }),
      });
      let data = null;
      try { data = await res.json(); } catch { /* non-JSON error body */ }
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status}).`);
      return data?.reply || 'The model returned an empty response.';
    }

    // Upload a document/form image → the multimodal model reads it and rebuilds the
    // content as EDITABLE text/fields/tables in the page (headings, labels, blanks
    // as "____", markdown tables). Honest caveat: this recreates the CONTENT and
    // structure, not a pixel-perfect image of the original.
    function importImage(file) {
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = String(reader.result || '');
        const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
        if (!m) { addMsg('ai', 'Sorry — I couldn’t read that image.'); return; }
        addMsg('user', `🖼 ${file.name} — recreate as an editable form`);
        const thinking = addMsg('ai', 'Reading the document…');
        const modelPrompt = [
          'Recreate the document/form in this image as clean, EDITABLE content.',
          "Use markdown '#'/'##' for the title and section headings.",
          'Keep every field LABEL and its value; render empty fields as "Label: ____".',
          'Reproduce any tables as markdown tables. Preserve the wording and order.',
          'Output ONLY the recreated content — no preamble or explanation.',
        ].join(' ');
        try {
          const reply = await askModel(modelPrompt, '', { mimeType: m[1], data: m[2] });
          insertIntoDoc(reply);
          thinking.setText('✓ Recreated the document as editable content on the page.', false);
        } catch (err) {
          thinking.setText(`Sorry — I couldn't read the document. ${err?.message || ''}`.trim(), false);
        }
      };
      reader.readAsDataURL(file);
    }

    const DEFAULT_PH = 'Ask the AI to help with your document…';
    // The block elements the AI last WROTE into the page. Follow-up modification
    // requests (shorten / expand / rewrite / translate / tone / grammar …) replace
    // THESE in place — conversational refine — rather than inserting a new copy.
    // Reset only when the blocks are gone or the user asks for a brand-new insert.
    let lastAiBlocks = null;
    const lastAiLive = () => Array.isArray(lastAiBlocks) && lastAiBlocks.some((el) => el && el.isConnected);
    // Read the current text of the last-written blocks back as light markdown (so the
    // model sees the up-to-date content, incl. manual edits, with heading structure).
    function blocksToText(els) {
      return (els || []).filter((el) => el && el.isConnected).map((el) => {
        const tag = (el.tagName || '').toLowerCase();
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (tag === 'h1') return `# ${text}`;
        if (tag === 'h2') return `## ${text}`;
        if (tag === 'h3') return `### ${text}`;
        return text;
      }).join('\n\n');
    }

    // Last non-collapsed selection made INSIDE the editor page. Kept up to date so
    // that when the user then types an instruction in the bar, we can edit exactly
    // that part of the page in place. Interacting with the bar doesn't clear it.
    let editSel = null;
    document.addEventListener('selectionchange', () => {
      const pageEl = editor && editor.element;
      if (!pageEl) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const r = sel.getRangeAt(0);
      const inPage = pageEl.contains(r.commonAncestorContainer);
      if (inPage && !sel.isCollapsed) { editSel = { range: r.cloneRange(), text: sel.toString() }; }
      else if (inPage && sel.isCollapsed) { editSel = null; if (!selbarSticky) hideSelbar(); } // clicked away → no target
      if (ui.aiInput) ui.aiInput.placeholder = editSel ? 'Edit the selected text — e.g. “make it formal”' : DEFAULT_PH;
    });

    // Replace the captured editor selection with the reply, in place on the page.
    // Uses rich block replacement so a multi-paragraph rewrite becomes real
    // paragraphs (and keeps any bold/italic), as one undoable edit. Returns the
    // affected block element(s) so a follow-up refine targets the SAME part.
    function replaceSelection(newText) {
      if (!editSel || !editor) return null;
      try {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(editSel.range);
        return editor.replaceSelectionWithBlocks(textToBlocks((newText || '').trim()));
      } catch { return null; }
      finally { editSel = null; if (ui.aiInput) ui.aiInput.placeholder = DEFAULT_PH; }
    }

    // ---- Floating "Edit with AI" toolbar (smart selection) ----
    // Select text in the page → a small pill appears right above the selection. Type
    // an instruction ("make it formal", "change this to…") → the selected text is
    // rewritten IN PLACE. This is the discoverable version of selection editing.
    let selbarSticky = false; // once focused, don't auto-hide when the highlight is lost
    const selInput = el('input', {
      class: 'doc-ai-sel__input', type: 'text', 'aria-label': 'Edit the selected text with AI',
      placeholder: 'Change this to… (e.g. make it formal)',
      onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submitSel(); } else if (e.key === 'Escape') { hideSelbar(); } },
    });
    const selbar = el('div', { class: 'doc-ai-selbar', role: 'toolbar', 'aria-label': 'Edit selection with AI' }, [
      el('span', { class: 'doc-ai-sel__ico', html: renderIcon('sparkle') }),
      selInput,
      el('button', { class: 'doc-ai-sel__send', type: 'button', 'data-tip': 'Edit with AI', 'aria-label': 'Apply edit', onClick: () => submitSel() }, el('span', { html: renderIcon('sparkle') })),
    ]);
    // Clicking the pill (except the input) must NOT steal the page selection.
    selbar.addEventListener('mousedown', (e) => { if (e.target !== selInput) e.preventDefault(); });
    selInput.addEventListener('focus', () => { selbarSticky = true; drawSelHighlight(); });
    ui.aiSelbar = selbar;
    document.body.appendChild(selbar);
    // A persistent highlight painted over the selection: focusing the input drops the
    // native selection colour, so we draw our own so the user still sees what's being
    // edited. Pointer-events:none, sits just under the pill.
    const selHi = el('div', { class: 'doc-ai-selhi', 'aria-hidden': 'true' });
    document.body.appendChild(selHi);
    function drawSelHighlight() {
      selHi.replaceChildren();
      if (!selbar.classList.contains('is-open') || !editSel || !editSel.range) return;
      let rects; try { rects = editSel.range.getClientRects(); } catch { return; }
      for (const r of rects) {
        if (!r.width || !r.height) continue;
        selHi.appendChild(el('div', { class: 'doc-ai-selhi__box', style: `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px` }));
      }
    }

    function hideSelbar() { selbar.classList.remove('is-open'); selInput.value = ''; selbarSticky = false; selHi.replaceChildren(); }
    function positionSelbar() {
      if (!editSel || !editSel.range) { hideSelbar(); return; }
      let rect;
      try { rect = editSel.range.getBoundingClientRect(); } catch { hideSelbar(); return; }
      if (!rect || (!rect.width && !rect.height)) { hideSelbar(); return; }
      selbar.style.visibility = 'hidden'; selbar.classList.add('is-open');
      const bw = selbar.offsetWidth; const bh = selbar.offsetHeight;
      let top = rect.top - bh - 8; if (top < 8) top = rect.bottom + 8;
      let left = rect.left + rect.width / 2 - bw / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
      selbar.style.top = `${Math.round(top)}px`; selbar.style.left = `${Math.round(left)}px`;
      selbar.style.visibility = 'visible';
      drawSelHighlight();
    }
    // Reveal the pill once a selection settles (mouseup / shift-key selection).
    const maybeShowSelbar = () => { setTimeout(() => { if (editSel && editSel.text) positionSelbar(); else if (!selbarSticky) hideSelbar(); }, 0); };
    document.addEventListener('mouseup', (e) => { if (!selbar.contains(e.target)) maybeShowSelbar(); });
    // Clicking anywhere outside the pill dismisses it (even after the input was
    // focused / made sticky) — e.g. you selected by accident and changed your mind.
    document.addEventListener('mousedown', (e) => { if (selbar.classList.contains('is-open') && !selbar.contains(e.target)) hideSelbar(); });
    document.addEventListener('keyup', (e) => { if (e.shiftKey || /Arrow/.test(e.key)) maybeShowSelbar(); });
    // Keep it glued to the selection while scrolling (or hide if the user isn't editing).
    const hostScroll = editor && editor.element ? editor.element.closest('.doc-host') : null;
    (hostScroll || window).addEventListener('scroll', () => { if (!selbar.classList.contains('is-open')) return; if (selbarSticky) positionSelbar(); else hideSelbar(); }, true);

    // Apply the instruction to the captured selection, in place (a plain, non-agent
    // rewrite so the result is always clean prose — never JSON/markdown).
    async function submitSel() {
      const instr = (selInput.value || '').trim();
      if (!instr || !editSel || !editSel.text) return;
      const target = editSel.text;
      selInput.value = ''; selInput.disabled = true;
      try {
        const modelPrompt = `Rewrite the text below according to this instruction: "${instr}". Return ONLY the rewritten text as clean plain text — no markdown, no LaTeX, no JSON, no quotes, no explanation.\n\nText:\n${target}`;
        const reply = await askModel(modelPrompt, '');
        const els = replaceSelection(reply); // restores the range + replaces in place
        if (els && els.length) lastAiBlocks = els; // a follow-up "make it shorter" refines this
      } catch { /* leave the selection so the user can retry */ }
      finally { selInput.disabled = false; hideSelbar(); }
    }

    // ---- DocMaster AI editing agent ----
    // Instead of chatting, the model returns a JSON list of ACTIONS (create /
    // replace / delete / format sections, tables, lists…) which we execute on the
    // live page. A short conversation history is kept so edits are multi-turn /
    // conversational (a "make it shorter" follow-up refers to the previous turn).
    const history = [];
    function pushHistory(role, text) {
      const t = (text || '').trim();
      if (!t) return;
      history.push({ role, text: t });
      if (history.length > 16) history.splice(0, history.length - 16);
    }

    // Ask the agent endpoint. Returns { actions } (structured edits) or { reply }
    // (plain text, when the model didn't produce JSON — we degrade gracefully).
    async function askAgent(prompt) {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'agent',
          prompt,
          text: docText(),
          selection: (editSel && editSel.text) || '',
          history: history.slice(-8),
        }),
      });
      let data = null;
      try { data = await res.json(); } catch { /* non-JSON error body */ }
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status}).`);
      return data || {};
    }

    // A reply that is really a JSON action blob (e.g. the model ignored the schema
    // wrapper, or a truncated action list slipped through) must NEVER be inserted as
    // text. Detect it, and try to salvage real actions from it (string-aware scan).
    // Detect a JSON action blob leaking through as a plain reply. Deliberately does
    // NOT treat a leading "[" as JSON — letters legitimately start with "[Your Name]".
    // Requires an object start or an explicit "action":"…" field.
    const looksLikeJson = (s) => /^\s*\{\s*"/.test(s || '') || /"action"\s*:\s*"/.test(s || '');
    function extractActionsFromText(raw) {
      if (!raw) return null;
      let s = String(raw).trim();
      const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
      if (fence) s = fence[1].trim();
      let val = null;
      try { val = JSON.parse(s); } catch { /* try a balanced, string-aware slice */ }
      if (!val) {
        const start = s.search(/[[{]/);
        if (start < 0) return null;
        const open = s[start]; const close = open === '{' ? '}' : ']';
        let depth = 0; let inStr = false; let esc = false;
        for (let i = start; i < s.length; i += 1) {
          const ch = s[i];
          if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
          if (ch === '"') { inStr = true; continue; }
          if (ch === open) depth += 1;
          else if (ch === close) { depth -= 1; if (depth === 0) { try { val = JSON.parse(s.slice(start, i + 1)); } catch { val = null; } break; } }
        }
      }
      if (!val) return null;
      const list = Array.isArray(val) ? val : Array.isArray(val.actions) ? val.actions : (val.action ? [val] : null);
      return list && list.filter((a) => a && typeof a.action === 'string');
    }

    /* ---- action executor: apply the model's JSON actions to the page ---- */
    const headingLevel = (elx) => {
      const t = (elx && elx.tagName || '').toLowerCase();
      return t === 'h1' ? 1 : t === 'h2' ? 2 : t === 'h3' ? 3 : 0;
    };
    const normText = (elx) => (elx.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const lastBlockEl = () => { const e = editor.getBlockEls ? editor.getBlockEls() : []; return e.length ? e[e.length - 1] : null; };

    // Find the block elements that make up a named section: the matching heading
    // plus the following blocks up to the next heading of the same-or-higher level.
    // A non-heading match returns just that one block. Case-insensitive; falls back
    // to a substring match so "Scene 3" finds "Scene 3: The rooftop".
    function findSectionEls(name) {
      if (!name || !editor.getBlockEls) return null;
      const els = editor.getBlockEls();
      const want = String(name).replace(/\s+/g, ' ').trim().toLowerCase();
      if (!want) return null;
      let idx = els.findIndex((e) => normText(e) === want);
      if (idx < 0) idx = els.findIndex((e) => normText(e).includes(want));
      if (idx < 0) return null;
      const start = els[idx];
      const level = headingLevel(start);
      if (!level) return [start];
      const out = [start];
      for (let i = idx + 1; i < els.length; i += 1) {
        const l = headingLevel(els[i]);
        if (l && l <= level) break; // next same/higher heading ends the section
        out.push(els[i]);
      }
      return out;
    }

    // Select a run of block elements (so selection-based editor commands can act on
    // a whole section for format_text).
    function selectEls(els) {
      const live = (els || []).filter((e) => e && e.isConnected);
      if (!live.length) return false;
      try {
        const range = document.createRange();
        range.setStartBefore(live[0]);
        range.setEndAfter(live[live.length - 1]);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
        return true;
      } catch { return false; }
    }

    // Build a table block from { headers, rows }. The header row is bold.
    function tableBlockFrom(headers, rows) {
      const body = [];
      const head = Array.isArray(headers) ? headers.map((h) => String(h == null ? '' : h)) : [];
      if (head.length) body.push({ cells: head, header: true });
      (Array.isArray(rows) ? rows : []).forEach((r) => {
        body.push({ cells: (Array.isArray(r) ? r : [r]).map((c) => String(c == null ? '' : c)), header: false });
      });
      if (!body.length) return null;
      const nCols = Math.max(...body.map((r) => r.cells.length), 1);
      const tbl = createTableBlock(body.length, nCols);
      body.forEach((r, ri) => {
        for (let ci = 0; ci < nCols; ci += 1) {
          // Clean each cell too (LaTeX / fences / stray markup), like paragraph text.
          const val = cleanInline(r.cells[ci] != null ? r.cells[ci] : '');
          tbl.rows[ri][ci] = { runs: r.header ? [createRun(stripStray(val), { bold: true })] : parseInline(val) };
        }
      });
      return tbl;
    }

    function listBlockFrom(items, ordered) {
      const list = (Array.isArray(items) ? items : []).map((t) => String(t == null ? '' : t)).filter((t) => t.trim());
      if (!list.length) return null;
      return createListBlock({ ordered: !!ordered, items: list.map((t) => ({ runs: parseInline(cleanInline(t).replace(/^\s*[-*•]\s+|^\s*\d+[.)]\s+/, '')) })) });
    }

    // Apply one format spec to the current selection or a named section.
    function applyFormat(target, fmt) {
      fmt = fmt || {};
      let ok = false;
      if (target && target !== 'selection' && target !== 'cursor') {
        const sec = findSectionEls(target);
        ok = sec ? selectEls(sec) : false;
      } else if (editSel && editSel.range) {
        try { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(editSel.range); ok = !!editSel.text; } catch { ok = false; }
      }
      if (!ok) return false;
      let did = false;
      if (fmt.bold) { editor.toggleMark('bold'); did = true; }
      if (fmt.italic) { editor.toggleMark('italic'); did = true; }
      if (fmt.underline) { editor.toggleMark('underline'); did = true; }
      if (fmt.align) { editor.setAlign(fmt.align); did = true; }
      if (fmt.heading) { editor.setBlockTag(`h${Math.min(3, Math.max(1, parseInt(fmt.heading, 10) || 1))}`); did = true; }
      if (fmt.list) { editor.insertList(fmt.list === 'number' || fmt.list === 'ordered' || fmt.list === 'numbered'); did = true; }
      return did;
    }

    // Execute a single action; returns a short human summary (or null if it was a
    // no-op). Updates `lastAiBlocks` so a follow-up refine targets what changed.
    function applyAction(a) {
      const action = a && a.action;
      const content = typeof a.content === 'string' ? a.content : '';
      const target = typeof a.target === 'string' ? a.target : '';
      const remember = (els) => { if (els && els.length) lastAiBlocks = els; return els; };
      switch (action) {
        case 'insert_text': {
          const blocks = textToBlocks(content);
          if (!blocks.length) return null;
          remember(target === 'end' ? editor.insertBlocksRelative(blocks, lastBlockEl(), 'after') : editor.insertBlocks(blocks));
          return 'Added the content to your document.';
        }
        case 'summarize': {
          const blocks = textToBlocks(content);
          if (!blocks.length) return null;
          if (target && target !== 'cursor' && target !== 'end') {
            const sec = findSectionEls(target);
            if (sec) { remember(editor.insertBlocksRelative(blocks, sec[sec.length - 1], 'after')); return `Added a summary after “${target}”.`; }
          }
          remember(target === 'cursor' ? editor.insertBlocks(blocks) : editor.insertBlocksRelative(blocks, lastBlockEl(), 'after'));
          return 'Added a summary.';
        }
        case 'replace_selection': {
          const blocks = textToBlocks(content);
          if (!blocks.length) return null;
          const els = replaceSelection(content);
          if (els && els.length) { lastAiBlocks = els; return 'Replaced the selected text.'; }
          remember(editor.insertBlocks(blocks));
          return 'Inserted the text.';
        }
        case 'replace_section': {
          const blocks = textToBlocks(content);
          if (!blocks.length) return null;
          const sec = findSectionEls(target);
          if (sec) { const els = editor.replaceBlocks(sec, blocks); if (els && els.length) { lastAiBlocks = els; return `Rewrote “${target}”.`; } }
          remember(editor.insertBlocks(blocks));
          return sec ? 'Updated the section.' : `Couldn’t find “${target}” — added the content instead.`;
        }
        case 'delete_section': {
          const sec = findSectionEls(target);
          if (sec && editor.removeBlocks(sec)) {
            if (lastAiBlocks && lastAiBlocks.some((e) => sec.includes(e))) lastAiBlocks = null;
            return `Deleted “${target}”.`;
          }
          return `Couldn’t find a section called “${target}”.`;
        }
        case 'insert_after':
        case 'insert_before': {
          const blocks = textToBlocks(content);
          if (!blocks.length) return null;
          const where = action === 'insert_before' ? 'before' : 'after';
          const sec = findSectionEls(target);
          const ref = sec ? (where === 'before' ? sec[0] : sec[sec.length - 1]) : null;
          remember(editor.insertBlocksRelative(blocks, ref, where));
          return sec ? `Inserted content ${where} “${target}”.` : 'Added the content to your document.';
        }
        case 'replace_all': {
          const blocks = textToBlocks(content);
          if (!blocks.length) return null;
          const all = editor.getBlockEls();
          remember(all.length ? editor.replaceBlocks(all, blocks) : editor.insertBlocks(blocks));
          return 'Rewrote the document.';
        }
        case 'create_table': {
          const tbl = tableBlockFrom(a.headers, a.rows);
          if (!tbl) return null;
          remember(editor.insertBlocks([tbl]));
          return 'Inserted a table.';
        }
        case 'create_heading': {
          const lvl = Math.min(3, Math.max(1, parseInt(a.level, 10) || 2));
          remember(editor.insertBlocks([createParagraph({ tag: `h${lvl}`, runs: parseInline(cleanInline(content)) })]));
          return 'Added a heading.';
        }
        case 'create_list': {
          const list = listBlockFrom(a.items, a.ordered);
          if (!list) return null;
          remember(editor.insertBlocks([list]));
          return 'Inserted a list.';
        }
        case 'format_text':
          return applyFormat(a.target, a.format) ? 'Updated the formatting.' : null;
        default:
          return null;
      }
    }

    // Run a list of actions in order; collect confirmations + any 'chat' reply.
    function applyActions(actions) {
      const summaries = [];
      let chatReply = null;
      for (const a of actions) {
        if (a && a.action === 'chat') { chatReply = typeof a.content === 'string' ? a.content : ''; continue; }
        try { const s = applyAction(a); if (s) summaries.push(s); } catch { /* skip a malformed action */ }
      }
      return { summaries, chatReply };
    }

    // Fallback intent for when the model returns plain text (no JSON actions): a
    // "write/make/create…" request writes into the page; anything else is chat.
    const WRITE_INTENT = /^\s*(write|draft|compose|create|generate|make|produce|prepare|give me|add|insert|summari[sz]e|list|outline)\b/i;

    // ---- conversational refine of the LAST AI output ("improve that part") ----
    // A brand-new generation (starts with write/create/…): NOT a refine.
    const FRESH_INTENT = /^\s*(write|draft|compose|create|generate|make me|produce|prepare|give me|add (a|an|another)|insert (a|an)|new (doc|document|essay|article|letter|paragraph|section|version|table|list))\b/i;
    // A modify/improve instruction.
    const REFINE_INTENT = /\b(improve|enhance|better|rewrite|re-?word|rephrase|revise|redo|shorten|shorter|lengthen|longer|expand|elaborate|simplif|clarif|polish|proofread|condense|summari[sz]e|make it|more (detail|formal|casual|professional|concise)|less (detail|formal)|professional|concise|formal|casual|translate|fix)\b/i;
    // Refers to the thing just written (pronoun), not a named part. "the whole
    // document/doc" is deliberately EXCLUDED — that's an explicit replace_all for the
    // agent, not a refine of the last snippet.
    const refersToLast = (s) => /\b(this|that|it|these|those|the (above|last|previous)|that (part|section|paragraph|text|one|bit))\b/i.test(s);
    // Names a specific structural part → let the agent target it (replace_section) instead.
    const namesPart = (s) => /\b(introduction|intro|conclusion|abstract|section|sub-?heading|heading|title|paragraph|table|bullet list|numbered list|scene\s*\d|slide\s*\d|chapter\s*\d)\b/i.test(s);
    // True when the AI's last output IS essentially the whole document (so a bare
    // "improve"/"make it better" can refine the whole thing in place).
    function lastCoversWholeDoc() {
      if (!lastAiLive()) return false;
      const all = editor.getBlockEls ? editor.getBlockEls() : [];
      return all.filter((b) => (b.textContent || '').trim() && !lastAiBlocks.includes(b)).length === 0;
    }

    // Rewrite the last AI-written block(s) IN PLACE: delete them and drop in the
    // revised version — the "improve that part" flow. Uses a plain (non-agent) call
    // so the reply is clean prose; the block cleaner strips any stray markup.
    async function runRefine(display, thinking) {
      const current = blocksToText(lastAiBlocks);
      const modelPrompt = [
        `Revise the text below according to this instruction: "${display}".`,
        'Return ONLY the revised version as clean text. Keep #/##/### heading lines where appropriate.',
        'No markdown symbols beyond those headings, no LaTeX, no JSON, no code fences, no explanation.',
        '', 'Text:', current,
      ].join('\n');
      const reply = await askModel(modelPrompt, '');
      const blocks = textToBlocks(reply);
      const newEls = blocks.length ? editor.replaceBlocks(lastAiBlocks, blocks) : null;
      if (newEls && newEls.length) { lastAiBlocks = newEls; thinking.setText('✓ Updated that part.', false); }
      else { const els = insertIntoDoc(reply); thinking.setText(els ? '✓ Written into your document.' : 'Sorry — I could not apply that change.', false); }
      pushHistory('user', display); pushHistory('assistant', 'Revised that part.');
    }

    // One code path for every typed message: send it to the agent and execute the
    // JSON actions it returns (create/edit/delete/format…). Local deterministic
    // asks (word count) still answer instantly. Multi-turn: each turn is recorded.
    async function runAgent(display) {
      addMsg('user', display);
      input.value = ''; input.style.height = 'auto';
      try { bus?.emit?.('doc:ai-request', { prompt: display, text: docText() }); } catch { /* optional bus */ }

      const local = localAnswer(display);
      if (local != null) {
        const t = addMsg('ai', '…');
        setTimeout(() => t.setText(local, false), 150);
        pushHistory('user', display); pushHistory('assistant', local);
        return;
      }

      const hadSelection = !!(editSel && editSel.text);
      // "improve/rewrite/shorten … that part/it" with NO selection but a live last-AI
      // block → refine THAT block in place (auto-delete + refill), not a new copy.
      const wantRefine = !hadSelection && lastAiLive() && REFINE_INTENT.test(display)
        && !FRESH_INTENT.test(display) && !namesPart(display)
        && !/\b(whole|entire|full)\b/i.test(display) // explicit whole-doc → agent replace_all
        && (refersToLast(display) || lastCoversWholeDoc());

      const thinking = addMsg('ai', '…');
      try {
        if (wantRefine) { await runRefine(display, thinking); return; }
        const data = await askAgent(display);
        // The server flags a truncated/unparseable action reply — show a friendly
        // retry, never dump raw JSON into the document.
        if (data.incomplete || (data.error && !data.reply && !data.actions)) {
          thinking.setText(data.error || 'The AI response was incomplete — please try again.', false);
          return;
        }
        let actions = Array.isArray(data.actions) && data.actions.length ? data.actions : null;
        const reply = data.reply || '';
        // Defense in depth: if the plain reply is actually a JSON action blob, parse
        // it here rather than inserting the JSON text.
        if (!actions && looksLikeJson(reply)) {
          const salvaged = extractActionsFromText(reply);
          if (salvaged && salvaged.length) actions = salvaged;
          else { thinking.setText('The AI response was incomplete — please try again.', false); return; }
        }
        if (actions) {
          const { summaries, chatReply } = applyActions(actions);
          const msg = chatReply || (summaries.length ? `✓ ${summaries.join(' ')}` : 'Done.');
          thinking.setText(msg, false);
          pushHistory('user', display); pushHistory('assistant', msg);
        } else {
          // No structured actions — degrade gracefully using the plain reply. (Guarded
          // above so this is never raw JSON.)
          if (hadSelection) {
            const els = replaceSelection(reply);
            if (els && els.length) { lastAiBlocks = els; thinking.setText('✓ Replaced the selected text.', false); }
            else thinking.setText(reply, true);
          } else if (WRITE_INTENT.test(display)) {
            insertIntoDoc(reply);
            thinking.setText('✓ Written into your document.', false);
          } else {
            thinking.setText(reply, true);
          }
          pushHistory('user', display); pushHistory('assistant', reply);
        }
      } catch (err) {
        thinking.setText(`Sorry — I couldn't reach the AI service. ${err?.message || ''}`.trim(), false);
      }
    }

    function submit() {
      const prompt = (input.value || '').trim();
      if (!prompt) return;
      runAgent(prompt);
    }

    // Quick task chips: click a type, and (with a topic in the bar) it generates and
    // writes straight into the page; with no topic it primes the bar for one.
    const TASKS = [
      { label: 'Letter', kind: 'a formal letter' },
      { label: 'Article', kind: 'an article' },
      { label: 'Essay', kind: 'an essay' },
      { label: 'Movie script', kind: 'a movie script (with scene headings and dialogue)' },
      { label: 'Presentation', kind: 'a slide-by-slide presentation outline (use a heading per slide)' },
    ];
    function runTask(t) {
      const topic = (input.value || '').trim();
      if (!topic) { input.value = `Write ${t.kind} about `; input.focus(); input.dispatchEvent(new Event('input')); return; }
      runAgent(`Write ${t.kind} about: ${topic}`);
    }

    // Turn an AI reply into paragraph blocks and write them into the page at the
    // caret as a single undoable edit (keeps the rest of the doc + undo history).
    // Remembers the inserted blocks as `lastAiBlocks` so a follow-up "make it
    // shorter" refines THEM instead of adding a second copy.
    function insertIntoDoc(text) {
      const clean = (text || '').trim();
      if (!clean || !editor) return null;
      const blocks = textToBlocks(clean);
      if (!blocks.length) return null;
      const els = editor.insertBlocks(blocks);
      lastAiBlocks = els && els.length ? els : null;
      return els;
    }

    /* ---- content cleanup: the document must read like Word/Docs, never raw markup ---- */
    const SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' };
    const SUB = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎' };
    const toUni = (s, map) => String(s).split('').map((c) => map[c] || c).join('');
    // Convert a LaTeX-ish math expression to readable plain Unicode (best effort).
    function convertMath(expr) {
      let s = String(expr);
      s = s.replace(/\\text\s*\{([^}]*)\}/g, '$1').replace(/\\mathrm\s*\{([^}]*)\}/g, '$1');
      s = s.replace(/\\right?arrow|\\to\b/g, '→').replace(/\\Rightarrow/g, '⇒')
        .replace(/\\times/g, '×').replace(/\\cdot/g, '·').replace(/\\div/g, '÷')
        .replace(/\\pm/g, '±').replace(/\\approx/g, '≈').replace(/\\neq/g, '≠')
        .replace(/\\leq/g, '≤').replace(/\\geq/g, '≥').replace(/\\infty/g, '∞')
        .replace(/\\sqrt/g, '√').replace(/\\sum/g, '∑').replace(/\\int/g, '∫')
        .replace(/\\alpha/g, 'α').replace(/\\beta/g, 'β').replace(/\\gamma/g, 'γ')
        .replace(/\\delta/g, 'δ').replace(/\\Delta/g, 'Δ').replace(/\\pi/g, 'π')
        .replace(/\\lambda/g, 'λ').replace(/\\mu/g, 'μ').replace(/\\sigma/g, 'σ').replace(/\\theta/g, 'θ');
      s = s.replace(/\^\{([^}]*)\}/g, (m, g) => toUni(g, SUP)).replace(/\^(\w)/g, (m, g) => toUni(g, SUP));
      s = s.replace(/_\{([^}]*)\}/g, (m, g) => toUni(g, SUB)).replace(/_(\w)/g, (m, g) => toUni(g, SUB));
      s = s.replace(/\\[a-zA-Z]+/g, '').replace(/[{}]/g, '').replace(/\\[,;:!]/g, ' ').replace(/\\\\/g, ' ');
      return s.replace(/\s+/g, ' ').trim();
    }
    // Strip LaTeX delimiters, code fences and stray markup from a whole block of text.
    function cleanContent(text) {
      let s = String(text || '');
      s = s.replace(/```[a-zA-Z0-9]*\r?\n?/g, '').replace(/```/g, ''); // drop code fences (keep inner text)
      s = s.replace(/\$\$([\s\S]*?)\$\$/g, (m, g) => convertMath(g)); // block math
      s = s.replace(/\\\[([\s\S]*?)\\\]/g, (m, g) => convertMath(g)); // \[ ... \]
      s = s.replace(/\$([^$\n]+?)\$/g, (m, g) => convertMath(g)); // inline math
      s = s.replace(/\\\(([\s\S]*?)\\\)/g, (m, g) => convertMath(g)); // \( ... \)
      return s;
    }
    // Single-line clean (for table cells, list items, headings): strip LaTeX/fences
    // and collapse whitespace so no raw markup or newlines leak into a cell/item.
    const cleanInline = (s) => cleanContent(String(s == null ? '' : s)).replace(/\s+/g, ' ').trim();
    const isTableRow = (l) => /\|/.test(l) && /^\s*\|?.*\|\s*$/.test(l.trim());
    const isTableSep = (l) => /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/.test(l) && /-/.test(l) && /\|/.test(l);
    const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

    // Clean AI content → block model. Markdown tables become NATIVE tables; `#`/`##`/
    // `###` (and a whole-line bold, or "Title:") become headings; LaTeX/fences are
    // stripped; **bold**/*italic* become marks. Never leaves raw markup in the doc.
    function textToBlocks(text) {
      const src = cleanContent(text);
      const lines = src.split(/\r?\n/);
      const blocks = [];
      for (let i = 0; i < lines.length; i += 1) {
        // A markdown table = a row line followed by a |---|---| separator.
        if (isTableRow(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
          const header = splitRow(lines[i]);
          const rows = [];
          i += 2;
          while (i < lines.length && isTableRow(lines[i]) && !isTableSep(lines[i])) { rows.push(splitRow(lines[i])); i += 1; }
          i -= 1; // the for-loop will advance past the last consumed row
          const tbl = tableBlockFrom(header, rows);
          if (tbl) blocks.push(tbl);
          continue;
        }
        const line = lines[i].trim();
        if (!line) continue;
        let tag = 'p';
        let content = line;
        const h = /^(#{1,3})\s+(.*)$/.exec(line);
        const boldOnly = /^(\*\*|__)([^*_].*?)\1$/.exec(line);
        if (h) { tag = `h${h[1].length}`; content = h[2]; }
        else if (/^title:\s*/i.test(line)) { tag = 'h1'; content = line.replace(/^title:\s*/i, ''); }
        else if (boldOnly && boldOnly[2].length <= 80) { tag = 'h2'; content = boldOnly[2]; }
        blocks.push(createParagraph({ tag, runs: parseInline(content) }));
      }
      return blocks;
    }

    // Inline markdown → runs: **bold**/__bold__ and *italic*/_italic_ become marks;
    // any leftover/stray emphasis markers are stripped so they never show as raw text.
    function parseInline(str) {
      const runs = [];
      const re = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3/g;
      let last = 0; let m;
      const push = (t, marks) => { const clean = stripStray(t); if (clean) runs.push(createRun(clean, marks)); };
      while ((m = re.exec(str))) {
        if (m.index > last) push(str.slice(last, m.index));
        if (m[2] != null) push(m[2], { bold: true });
        else push(m[4], { italic: true });
        last = re.lastIndex;
      }
      if (last < str.length) push(str.slice(last));
      return runs.length ? runs : [createRun(stripStray(str))];
    }
    // Remove stray/unpaired markdown emphasis + heading marks so no raw syntax leaks.
    function stripStray(t) {
      return String(t).replace(/\*\*|__/g, '').replace(/(^|\s)[*_](?=\S)|(?<=\S)[*_](?=\s|$)/g, '$1').replace(/^#{1,6}\s*/, '');
    }

    // ---- Right SIDEBAR: the full conversation + tools (a flex child of .doc-body,
    // so the document resizes and nothing overlaps the page). ----
    ui.aiEmpty = el('div', { class: 'doc-ai__empty' }, [
      el('div', { class: 'doc-ai__empty-ico', html: renderIcon('sparkle') }),
      el('div', { class: 'doc-ai__empty-title' }, 'Ask AI anything'),
      el('div', { class: 'doc-ai__empty-sub' }, 'Write, edit, or ask about your document. Type below or pick a task.'),
    ]);
    msgs.appendChild(ui.aiEmpty);
    const sidebar = el('aside', { class: 'doc-ai-sidebar', 'aria-label': 'AI Assistant conversation' }, [
      el('div', { class: 'doc-ai-side__head' }, [
        el('span', { class: 'doc-ai-side__title' }, [
          el('span', { class: 'doc-ai-side__title-ico', html: renderIcon('sparkle') }),
          el('span', {}, 'AI Assistant'),
        ]),
        el('div', { class: 'doc-ai-side__tools' }, [
          el('button', {
            class: 'doc-ai-side__tool', type: 'button', 'data-tip': 'New chat', 'aria-label': 'New chat',
            onClick: () => { msgs.replaceChildren(); ui.aiEmpty && msgs.appendChild(ui.aiEmpty); },
          }, 'New chat'),
          el('button', {
            class: 'doc-ai-side__close', type: 'button', 'aria-label': 'Hide conversation',
            'data-tip': 'Hide', onClick: () => closeChat(),
          }, '✕'),
        ]),
      ]),
      msgs,
    ]);
    ui.aiSidebar = sidebar;
    ui.docBody.appendChild(sidebar);

    // ---- Bottom PROMPT BAR. Suggestion chips are hidden behind the `+` button;
    // a `+`(tasks) and an image-upload button sit at the left of the pill. ----
    const tasks = el('div', { class: 'doc-ai-tasks' },
      TASKS.map((t) => el('button', { class: 'doc-ai-task', type: 'button', onClick: () => { runTask(t); dock.classList.remove('is-tasks-open'); } }, t.label)));

    const moreBtn = el('button', {
      class: 'doc-ai-bar__more', type: 'button', 'aria-label': 'Show tasks', 'data-tip': 'Tasks',
      onClick: () => dock.classList.toggle('is-tasks-open'),
    }, el('span', { html: renderIcon('plus') }));

    // Hidden file input + upload button: pick a form/document image and the model
    // recreates it as editable content in the page (see importImage).
    const fileInput = el('input', {
      type: 'file', accept: 'image/*', class: 'doc-ai-file', 'aria-hidden': 'true',
      onChange: (e) => { const f = e.target.files && e.target.files[0]; if (f) importImage(f); e.target.value = ''; },
    });
    // Image → editable recreation is built but LOCKED for now (flip to false to
    // enable it in the future — the whole pipeline below stays wired).
    const IMAGE_LOCKED = true;
    const uploadBtn = el('button', {
      class: `doc-ai-bar__upload${IMAGE_LOCKED ? ' is-locked' : ''}`, type: 'button',
      'aria-label': IMAGE_LOCKED ? 'Upload document image (coming soon)' : 'Upload a document image',
      'data-tip': IMAGE_LOCKED ? 'Image import — coming soon' : 'Upload image → recreate as editable',
      'aria-disabled': IMAGE_LOCKED ? 'true' : null,
      onClick: () => { if (IMAGE_LOCKED) return; fileInput.click(); },
    }, el('span', { html: renderIcon('image') }));

    const bar = el('div', { class: 'doc-ai-bar' }, [
      moreBtn,
      uploadBtn,
      fileInput,
      input,
      sendBtn,
      el('button', {
        class: 'doc-ai-bar__close', type: 'button', 'aria-label': 'Close AI Assistant',
        'data-tip': 'Close', onClick: () => closeAiPanel(),
      }, '✕'),
    ]);
    const dock = el('div', { class: 'doc-ai-dock', 'aria-label': 'AI prompt' }, [tasks, bar]);
    ui.aiPanel = dock;
    (ui.docMain || ui.docBody || root).appendChild(dock);
  }

  function mkMenu(label, itemsFn) {
    const btn = el('button', {
      class: 'doc-menu__top', type: 'button', role: 'menuitem',
      'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onClick: (e) => { e.stopPropagation(); toggleMenu(btn, itemsFn); },
      // Once a menu is open, hovering a sibling switches to it (native feel).
      onMouseenter: () => { if (openMenu && openMenu.btn !== btn) toggleMenu(btn, itemsFn); },
    }, label);
    return el('div', { class: 'doc-menu-wrap' }, btn);
  }

  function toggleMenu(btn, itemsFn) {
    const wasThis = openMenu && openMenu.btn === btn;
    closeMenu();
    if (wasThis) return;
    const menu = el('div', { class: 'app-menu doc-menu', role: 'menu' }, itemsFn().map(renderMenuItem));
    btn.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    btn.parentElement.appendChild(menu);
    openMenu = { el: menu, btn };
    setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
  }

  function onDocClick(e) {
    if (openMenu && !openMenu.el.contains(e.target) && e.target !== openMenu.btn) closeMenu();
  }

  function closeMenu() {
    if (!openMenu) return;
    openMenu.btn.classList.remove('is-open');
    openMenu.btn.setAttribute('aria-expanded', 'false');
    openMenu.el.remove();
    openMenu = null;
    document.removeEventListener('click', onDocClick, true);
  }

  function renderMenuItem(it) {
    if (it.sep) return el('div', { class: 'app-menu__sep' });
    return el('button', {
      class: `app-menu__item${it.disabled ? ' is-disabled' : ''}`,
      type: 'button', role: 'menuitem', disabled: !!it.disabled,
      onMousedown: (e) => e.preventDefault(), // keep the editor caret/selection
      onClick: (e) => { e.stopPropagation(); closeMenu(); if (!it.disabled) it.onClick?.(); },
    }, [
      it.icon ? el('span', { class: 'app-menu__icon', html: renderIcon(it.icon) }) : null,
      el('span', { class: 'app-menu__label' }, it.label),
      it.shortcut ? el('span', { class: 'app-menu__shortcut' }, it.shortcut) : null,
    ].filter(Boolean));
  }

  /* ---- menu contents (built fresh on open so disabled state is current) --- */
  const fileMenu = () => [
    { label: 'New document', icon: 'new-doc', onClick: newBlank },
    { label: 'Open…', icon: 'open', shortcut: 'Ctrl+O', onClick: () => bus.emit('nav:command', { command: 'open', arg: 'document' }) },
    { label: 'Open project', icon: 'open', onClick: openProject },
    { sep: true },
    { label: 'Save project', icon: 'save', shortcut: '.dmdoc', onClick: saveProject },
    { sep: true },
    { label: 'Page setup', icon: 'sliders', onClick: openPageSetup },
    { label: 'Close document', onClick: backHome },
  ];
  const editMenu = () => [
    { label: 'Undo', shortcut: 'Ctrl+Z', disabled: !editor?.canUndo?.(), onClick: () => editor?.undo() },
    { label: 'Redo', shortcut: 'Ctrl+Y', disabled: !editor?.canRedo?.(), onClick: () => editor?.redo() },
    { sep: true },
    { label: 'Select all', shortcut: 'Ctrl+A', onClick: selectAll },
    { sep: true },
    { label: 'Symbol…', onClick: openSymbols },
    { label: 'Calculator', onClick: () => openCalculator() },
  ];
  const viewMenu = () => [
    { label: toolbarHidden ? 'Show formatting toolbar' : 'Hide formatting toolbar', onClick: toggleToolbar },
    { label: document.fullscreenElement ? 'Exit full screen' : 'Full screen', onClick: toggleFullscreen },
  ];
  const insertMenu = () => {
    const items = [
      { label: 'Image…', icon: 'image', onClick: pickImage },
      { label: 'Shape…', icon: 'shapes', onClick: insertShape },
      { label: 'Stamp…', icon: 'stamp', onClick: insertStamp },
      { label: 'Professional Library…', icon: 'chart', onClick: openProLibrary },
      { label: 'Table', icon: 'table', onClick: () => editor.insertTable(3, 3) },
      { sep: true },
      { label: 'Bulleted list', icon: 'list-bullet', onClick: () => editor.insertList(false) },
      { label: 'Numbered list', icon: 'list-numbered', onClick: () => editor.insertList(true) },
      { sep: true },
      { label: 'Header', onClick: () => editor.editHeader() },
      { label: 'Footer', onClick: () => editor.editFooter() },
      { label: 'Page number', onClick: () => editor.insertField('page') },
      { label: 'Page count', onClick: () => editor.insertField('pages') },
      { label: 'Headers & footers…', icon: 'sliders', onClick: () => openHfSettings() },
    ];
    // Row/column editing is only meaningful when the caret is inside a table.
    if (editor?.inTable?.()) {
      items.push(
        { sep: true },
        { label: 'Insert row above', onClick: () => editor.insertTableRow('above') },
        { label: 'Insert row below', onClick: () => editor.insertTableRow('below') },
        { label: 'Insert column left', onClick: () => editor.insertTableColumn('left') },
        { label: 'Insert column right', onClick: () => editor.insertTableColumn('right') },
        { sep: true },
        { label: 'Delete row', onClick: () => editor.deleteTableRow() },
        { label: 'Delete column', onClick: () => editor.deleteTableColumn() },
        { label: 'Delete table', onClick: () => editor.deleteTable() },
      );
    }
    return items;
  };
  const formatMenu = () => [
    { label: 'Bold', shortcut: 'Ctrl+B', onClick: () => editor.toggleMark('bold') },
    { label: 'Italic', shortcut: 'Ctrl+I', onClick: () => editor.toggleMark('italic') },
    { label: 'Underline', shortcut: 'Ctrl+U', onClick: () => editor.toggleMark('underline') },
    { sep: true },
    { label: 'Highlight', icon: 'highlight', onClick: () => applyHighlight(highlightColor) },
    { label: 'Remove highlight', onClick: () => applyHighlight('transparent') },
    { sep: true },
    { label: 'Align left', icon: 'align-left', onClick: () => editor.setAlign('left') },
    { label: 'Align center', icon: 'align-center', onClick: () => editor.setAlign('center') },
    { label: 'Align right', icon: 'align-right', onClick: () => editor.setAlign('right') },
    { label: 'Justify', icon: 'align-justify', onClick: () => editor.setAlign('justify') },
    { sep: true },
    { label: 'Normal text', onClick: () => editor.setBlockTag('p') },
    { label: 'Heading 1', onClick: () => editor.setBlockTag('h1') },
    { label: 'Heading 2', onClick: () => editor.setBlockTag('h2') },
    { label: 'Heading 3', onClick: () => editor.setBlockTag('h3') },
    { sep: true },
    { label: 'Table borders: Normal', icon: 'table', disabled: !editor?.inTable?.(), onClick: () => editor.setTableBorder('thin') },
    { label: 'Table borders: Thick', disabled: !editor?.inTable?.(), onClick: () => editor.setTableBorder('thick') },
    { label: 'Table borders: None', disabled: !editor?.inTable?.(), onClick: () => editor.setTableBorder('none') },
  ];
  const toolsMenu = () => [
    { label: 'Word count', onClick: wordCount },
  ];

  /* ---- menu-bar actions ---- */
  function backHome() {
    closeMenu();
    bus.emit('nav:command', { command: 'view', arg: 'home' });
  }
  function selectAll() {
    if (!editor) return;
    editor.focus();
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(editor.element);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function toggleToolbar() {
    toolbarHidden = !toolbarHidden;
    if (toolbarEl) toolbarEl.hidden = toolbarHidden;
  }
  // Paint / clear the highlighter. With a caret (no selection) this arms the
  // highlighter so typed text comes out highlighted (Google-Docs style);
  // 'transparent' clears it. Also updates the toolbar button's colour bar.
  function applyHighlight(color) {
    if (!editor) return;
    const on = color && color !== 'transparent';
    highlightOn = !!on;
    if (ui.highlight) ui.highlight.classList.toggle('is-active', highlightOn);
    editor.setHighlight(on ? color : 'transparent');
  }

  // Right-click colour panel for the highlighter: a small swatch grid + "None"
  // + custom picker. Swatches preventDefault on mousedown so the editor's
  // caret/selection survives — picking one sets the marker colour and applies it.
  const HL_COLORS = [
    '#ffff00', '#ffe64d', '#ffd54f', '#ffab40', '#ff8a80', '#ff80ab',
    '#ea80fc', '#b388ff', '#8c9eff', '#80d8ff', '#84ffff', '#a7ffeb',
    '#b9f6ca', '#ccff90', '#f4ff81', '#e0e0e0', '#9e9e9e', '#000000',
  ];
  let hlPalette = null;
  function closeHighlightPalette() {
    if (!hlPalette) return;
    hlPalette.remove();
    hlPalette = null;
    document.removeEventListener('click', onHlOutside, true);
    document.removeEventListener('contextmenu', onHlOutside, true);
  }
  function onHlOutside(e) {
    if (hlPalette && !hlPalette.contains(e.target)) closeHighlightPalette();
  }
  function openHighlightPalette(anchor) {
    if (hlPalette) return closeHighlightPalette();
    const pick = (color) => { closeHighlightPalette(); applyHighlight(color); };
    const none = el('button', {
      class: 'doc-hl__none', type: 'button', onMousedown: (e) => e.preventDefault(),
      onClick: () => pick('transparent'),
    }, [el('span', { class: 'doc-hl__none-swatch' }), 'None']);
    const grid = el('div', { class: 'doc-hl__grid' }, HL_COLORS.map((c) => el('button', {
      class: `doc-hl__swatch${c.toLowerCase() === highlightColor.toLowerCase() ? ' is-active' : ''}`,
      type: 'button', title: c, style: `background:${c}`,
      onMousedown: (e) => e.preventDefault(),
      onClick: () => pick(c),
    })));
    const custom = el('input', {
      class: 'doc-hl__custom', type: 'color', value: highlightColor, title: 'Custom colour',
      onChange: (e) => pick(e.target.value),
    });
    hlPalette = el('div', { class: 'app-menu doc-hl-menu', role: 'menu' }, [
      none, grid,
      el('div', { class: 'doc-hl__custom-row' }, [el('span', { class: 'doc-hl__custom-label' }, 'Custom'), custom]),
    ]);
    // Anchor under the button with the viewport rect (fixed) so it can't be
    // clipped by the toolbar and lands exactly beneath the highlighter.
    const rect = anchor.getBoundingClientRect();
    Object.assign(hlPalette.style, { position: 'fixed', top: `${rect.bottom + 6}px`, left: `${rect.left}px`, right: 'auto' });
    document.body.appendChild(hlPalette);
    setTimeout(() => {
      document.addEventListener('click', onHlOutside, true);
      document.addEventListener('contextmenu', onHlOutside, true);
    }, 0);
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.();
  }
  function wordCount() {
    const text = (editor?.element?.innerText || '').trim();
    const words = text ? text.split(/\s+/).length : 0;
    const chars = text.replace(/\s/g, '').length;
    bus.emit('toast', `${words} word${words === 1 ? '' : 's'} · ${chars} character${chars === 1 ? '' : 's'}.`);
  }

  /* ------------------------------ page setup ---------------------------- */
  // A Google-Docs style Page setup dialog: orientation, paper size, page colour
  // and per-side margins (in cm). Applying updates the live page and the model
  // (persists through save/export). Paper sizes are portrait dimensions in CSS px
  // at 96dpi; landscape swaps width/height.
  const PX_PER_CM = 96 / 2.54;
  const CM_PER_PX = 2.54 / 96;
  const PAPER_SIZES = [
    { id: 'a4', label: 'A4 (21.0 cm x 29.7 cm)', w: 794, h: 1123 },
    { id: 'letter', label: 'Letter (21.6 cm x 27.9 cm)', w: 816, h: 1056 },
    { id: 'legal', label: 'Legal (21.6 cm x 35.6 cm)', w: 816, h: 1344 },
    { id: 'a3', label: 'A3 (29.7 cm x 42.0 cm)', w: 1123, h: 1587 },
    { id: 'a5', label: 'A5 (14.8 cm x 21.0 cm)', w: 559, h: 794 },
    { id: 'tabloid', label: 'Tabloid (27.9 cm x 43.2 cm)', w: 1056, h: 1632 },
  ];
  let pageDialog = null;
  let pageKeyHandler = null;
  function closePageSetup() {
    if (pageKeyHandler) { document.removeEventListener('keydown', pageKeyHandler, true); pageKeyHandler = null; }
    if (pageDialog) { pageDialog.remove(); pageDialog = null; }
  }
  function openPageSetup() {
    closeMenu();
    if (!editor || !hasDoc) { bus.emit('toast', 'Create or open a document first.'); return; }
    if (pageDialog) return;

    const cur = editor.getPageSetup();
    const landscape = cur.width > cur.height;
    const pw = landscape ? cur.height : cur.width;
    const ph = landscape ? cur.width : cur.height;
    const paper = PAPER_SIZES.find((s) => Math.abs(s.w - pw) <= 3 && Math.abs(s.h - ph) <= 3) || PAPER_SIZES[0];
    const toCm = (px) => (px * CM_PER_PX).toFixed(2);
    let orientation = landscape ? 'landscape' : 'portrait';

    const orient = (val, label) => {
      const input = el('input', {
        type: 'radio', name: 'doc-orient', value: val, checked: orientation === val,
        onChange: () => { orientation = val; },
      });
      return el('label', { class: 'doc-dialog__radio' }, [input, el('span', {}, label)]);
    };
    const paperSelect = el('select', { class: 'doc-select doc-dialog__select' },
      PAPER_SIZES.map((s) => el('option', { value: s.id, selected: s.id === paper.id }, s.label)));
    const colorInput = el('input', { class: 'doc-dialog__color', type: 'color', value: cur.background || '#ffffff' });
    const mInput = (key) => el('input', { class: 'doc-dialog__num', type: 'number', min: '0', step: '0.1', value: toCm(cur.margins[key]) });
    const mTop = mInput('top'), mBottom = mInput('bottom'), mLeft = mInput('left'), mRight = mInput('right');
    const field = (label, input) => el('label', { class: 'doc-dialog__field' }, [el('span', { class: 'doc-dialog__flabel' }, label), input]);
    // "Show page margins": a view-only guide outlining the printable area. Off by
    // default; the checkbox reflects the current live state.
    const showMarginsInput = el('input', { type: 'checkbox', checked: !!editor.getShowMargins() });

    const apply = () => {
      const size = PAPER_SIZES.find((s) => s.id === paperSelect.value) || PAPER_SIZES[0];
      const width = orientation === 'landscape' ? size.h : size.w;
      const height = orientation === 'landscape' ? size.w : size.h;
      const cmToPx = (v) => Math.max(0, Math.round((parseFloat(v) || 0) * PX_PER_CM));
      editor.setPageSetup({
        width, height,
        margins: { top: cmToPx(mTop.value), right: cmToPx(mRight.value), bottom: cmToPx(mBottom.value), left: cmToPx(mLeft.value) },
        background: colorInput.value,
      });
      editor.setShowMargins(showMarginsInput.checked);
      renderRuler();
      closePageSetup();
      editor.focus();
      bus.emit('toast', 'Page setup applied.');
    };

    const dialog = el('div', { class: 'doc-dialog', role: 'dialog', 'aria-label': 'Page setup', onMousedown: (e) => e.stopPropagation() }, [
      el('h2', { class: 'doc-dialog__title' }, 'Page setup'),
      el('div', { class: 'doc-dialog__section' }, [
        el('div', { class: 'doc-dialog__label' }, 'Orientation'),
        el('div', { class: 'doc-dialog__row' }, [orient('portrait', 'Portrait'), orient('landscape', 'Landscape')]),
      ]),
      el('div', { class: 'doc-dialog__cols' }, [
        el('div', { class: 'doc-dialog__section' }, [el('div', { class: 'doc-dialog__label' }, 'Paper size'), paperSelect]),
        el('div', { class: 'doc-dialog__section' }, [el('div', { class: 'doc-dialog__label' }, 'Page colour'), colorInput]),
      ]),
      el('div', { class: 'doc-dialog__section' }, [
        el('div', { class: 'doc-dialog__label' }, 'Margins (centimetres)'),
        el('div', { class: 'doc-dialog__margins' }, [field('Top', mTop), field('Bottom', mBottom), field('Left', mLeft), field('Right', mRight)]),
      ]),
      el('div', { class: 'doc-dialog__section' }, [
        el('label', { class: 'doc-dialog__check' }, [showMarginsInput, el('span', {}, 'Show page margins')]),
      ]),
      el('div', { class: 'doc-dialog__foot' }, [
        el('button', { class: 'doc-dialog__btn', type: 'button', onClick: closePageSetup }, 'Cancel'),
        el('button', { class: 'doc-dialog__btn doc-dialog__btn--primary', type: 'button', onClick: apply }, 'OK'),
      ]),
    ]);

    // Backdrop click closes; keys: Esc cancels, Enter applies.
    pageDialog = el('div', { class: 'doc-modal', onMousedown: () => closePageSetup() }, dialog);
    pageKeyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closePageSetup(); }
      else if (e.key === 'Enter') { e.preventDefault(); apply(); }
    };
    document.body.appendChild(pageDialog);
    document.addEventListener('keydown', pageKeyHandler, true);
    setTimeout(() => paperSelect.focus(), 0);
  }

  /* --------------------------- header & footer -------------------------- */
  // The "Headers and footers" dialog (Google-Docs): header/footer distance from
  // the page edge (cm) + the Different-first / Different-odd-&-even layout flags.
  // Apply writes straight through editor.setHfSettings, which reflows the body.
  let hfDialog = null;
  let hfKeyHandler = null;
  function closeHfSettings() {
    if (hfKeyHandler) { document.removeEventListener('keydown', hfKeyHandler, true); hfKeyHandler = null; }
    if (hfDialog) { hfDialog.remove(); hfDialog = null; }
  }
  function openHfSettings() {
    closeMenu();
    if (!editor || !hasDoc) { bus.emit('toast', 'Create or open a document first.'); return; }
    if (hfDialog) return;
    const cur = editor.getHfSettings();
    const toCm = (px) => (px * CM_PER_PX).toFixed(2);
    const headerInput = el('input', { class: 'doc-dialog__num', type: 'number', min: '0', step: '0.1', value: toCm(cur.headerDistance) });
    const footerInput = el('input', { class: 'doc-dialog__num', type: 'number', min: '0', step: '0.1', value: toCm(cur.footerDistance) });
    const firstChk = el('input', { type: 'checkbox', checked: cur.differentFirst });
    const oddEvenChk = el('input', { type: 'checkbox', checked: cur.differentOddEven });
    const field = (label, input) => el('label', { class: 'doc-dialog__field' }, [el('span', { class: 'doc-dialog__flabel' }, label), input]);
    const check = (input, label) => el('label', { class: 'doc-dialog__check' }, [input, el('span', {}, label)]);

    const apply = () => {
      editor.setHfSettings({
        headerDistance: Math.max(0, Math.round((parseFloat(headerInput.value) || 0) * PX_PER_CM)),
        footerDistance: Math.max(0, Math.round((parseFloat(footerInput.value) || 0) * PX_PER_CM)),
        differentFirst: firstChk.checked,
        differentOddEven: oddEvenChk.checked,
      });
      closeHfSettings();
      editor.focus();
      bus.emit('toast', 'Header & footer settings applied.');
    };

    const dialog = el('div', { class: 'doc-dialog', role: 'dialog', 'aria-label': 'Headers and footers', onMousedown: (e) => e.stopPropagation() }, [
      el('h2', { class: 'doc-dialog__title' }, 'Headers and footers'),
      el('div', { class: 'doc-dialog__section' }, [
        el('div', { class: 'doc-dialog__label' }, 'Margins'),
        el('div', { class: 'doc-dialog__margins doc-dialog__margins--hf' }, [
          field('Header (centimetres from top)', headerInput),
          field('Footer (centimetres from bottom)', footerInput),
        ]),
      ]),
      el('div', { class: 'doc-dialog__section' }, [
        el('div', { class: 'doc-dialog__label' }, 'Layout'),
        check(firstChk, 'Different first page'),
        check(oddEvenChk, 'Different odd & even'),
      ]),
      el('div', { class: 'doc-dialog__foot' }, [
        el('button', { class: 'doc-dialog__btn', type: 'button', onClick: closeHfSettings }, 'Cancel'),
        el('button', { class: 'doc-dialog__btn doc-dialog__btn--primary', type: 'button', onClick: apply }, 'Apply'),
      ]),
    ]);

    hfDialog = el('div', { class: 'doc-modal', onMousedown: () => closeHfSettings() }, dialog);
    hfKeyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeHfSettings(); }
      else if (e.key === 'Enter') { e.preventDefault(); apply(); }
    };
    document.body.appendChild(hfDialog);
    document.addEventListener('keydown', hfKeyHandler, true);
    setTimeout(() => headerInput.focus(), 0);
  }

  /* -------------------------------- ruler ------------------------------- */
  // A Word / Google-Docs style horizontal ruler above the page. It shows a
  // centimetre scale (origin at the left margin), shades the margin areas, and
  // exposes draggable left/right margin markers that write back through
  // editor.setPageSetup — so the ruler and the page always agree.
  const RULER_PX_PER_CM = 96 / 2.54;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /** Floating − 100% + control at the page's bottom-right. */
  function mkZoomControl() {
    ui.zoomVal = el('button', {
      class: 'doc-zoom__val', type: 'button', title: 'Reset to 100%',
      onClick: () => applyDocZoom(editor?.setZoom(1)),
    }, '100%');
    const btn = (icon, label, fn) => el('button', {
      class: 'doc-zoom__btn', type: 'button', 'aria-label': label, 'data-tip': label,
      onClick: fn,
    }, el('span', { class: 'doc-btn__ico', html: renderIcon(icon) }));
    return el('div', { class: 'doc-zoom', role: 'group', 'aria-label': 'Zoom' }, [
      btn('minus', 'Zoom out', () => applyDocZoom(editor?.zoomOut())),
      ui.zoomVal,
      btn('plus', 'Zoom in', () => applyDocZoom(editor?.zoomIn())),
    ]);
  }

  /** Apply a new page zoom: update the floating control + store readout and scale
   *  the ruler to match. `z` is the editor's clamped value; null (no editor yet)
   *  makes it a no-op. */
  function applyDocZoom(z) {
    if (z == null) return false;
    docZoom = z;
    store.setState({ zoom: z });
    if (ui.zoomVal) ui.zoomVal.textContent = `${Math.round(z * 100)}%`;
    const r = rulerEl?.querySelector('.doc-ruler');
    if (r) r.style.zoom = String(z);
    return true;
  }

  function renderRuler() {
    if (!rulerEl || !editor || !hasDoc) return;
    const ps = editor.getPageSetup(); // { width, height, margins, background }
    const W = ps.width;
    const m = ps.margins;

    const ruler = el('div', { class: 'doc-ruler' });
    ruler.style.width = `${W}px`;

    // Shaded margin areas at both ends.
    const padL = el('div', { class: 'doc-ruler__pad' }); padL.style.left = '0'; padL.style.width = `${m.left}px`;
    const padR = el('div', { class: 'doc-ruler__pad' }); padR.style.right = '0'; padR.style.width = `${m.right}px`;
    ruler.append(padL, padR);

    // Quarter-cm ticks across the whole width. Numbers are measured from the
    // left margin (0 at content start) and MIRRORED into the margins — e.g. the
    // left margin reads 2, 1 back toward the page edge, exactly like Google Docs.
    const ticks = el('div', { class: 'doc-ruler__ticks' });
    const quarter = RULER_PX_PER_CM / 4;
    for (let k = Math.ceil((0 - m.left) / quarter); ; k += 1) {
      const x = m.left + k * quarter;
      if (x > W + 0.5) break;
      if (x < -0.5) continue;
      const isCm = k % 4 === 0;
      const isHalf = k % 2 === 0;
      const cls = isCm ? 'doc-ruler__tick doc-ruler__tick--major' : isHalf ? 'doc-ruler__tick doc-ruler__tick--half' : 'doc-ruler__tick';
      const tick = el('div', { class: cls }); tick.style.left = `${x}px`;
      ticks.appendChild(tick);
      if (isCm) {
        const cm = k / 4;
        if (cm !== 0) { const num = el('span', { class: 'doc-ruler__num' }, String(Math.abs(cm))); num.style.left = `${x}px`; ticks.appendChild(num); }
      }
    }
    ruler.appendChild(ticks);

    // Draggable margin markers.
    const mkMarker = (side, x) => {
      const mk = el('div', { class: `doc-ruler__marker doc-ruler__marker--${side}`, title: `${side === 'left' ? 'Left' : 'Right'} margin — drag to adjust` });
      mk.style.left = `${x}px`;
      mk.addEventListener('pointerdown', (e) => startMarginDrag(e, mk, side, ps));
      return mk;
    };
    ruler.appendChild(mkMarker('left', m.left));
    ruler.appendChild(mkMarker('right', W - m.right));

    ruler.style.zoom = String(docZoom); // scale with the page so ticks stay aligned
    rulerEl.replaceChildren(ruler);
  }

  function startMarginDrag(e, mk, side, ps0) {
    e.preventDefault();
    const W = ps0.width;
    const m0 = { ...ps0.margins };
    const startX = e.clientX;
    const MIN_CONTENT = 96; // keep ≥ ~1in of content between margins
    let val = side === 'left' ? m0.left : m0.right;
    try { mk.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      if (side === 'left') { val = clamp(m0.left + dx, 0, W - m0.right - MIN_CONTENT); mk.style.left = `${val}px`; }
      else { val = clamp(m0.right - dx, 0, W - m0.left - MIN_CONTENT); mk.style.left = `${W - val}px`; }
    };
    const onUp = () => {
      mk.removeEventListener('pointermove', onMove);
      mk.removeEventListener('pointerup', onUp);
      editor.setPageSetup({ width: W, height: ps0.height, margins: { ...m0, [side]: Math.round(val) }, background: ps0.background });
      renderRuler();
      editor.focus();
    };
    mk.addEventListener('pointermove', onMove);
    mk.addEventListener('pointerup', onUp);
  }

  /* ------------------------- tabs & outline panel ----------------------- */
  // A Google-Docs style left panel: a "Document tabs" section plus a live
  // outline of the document's headings (click to jump). Collapses to a small
  // round toggle button so the page stays the focus.
  function buildOutline(rootEl) {
    const toggle = el('button', {
      class: 'doc-outline__toggle', type: 'button', 'data-tip': 'Show tabs and outlines',
      'aria-label': 'Show tabs and outlines', onClick: () => setOutlineOpen(true),
    }, el('span', { class: 'doc-outline__ico', html: renderIcon('outline') }));

    const back = el('button', {
      class: 'doc-outline__back', type: 'button', 'data-tip': 'Hide',
      'aria-label': 'Hide tabs and outlines', onClick: () => setOutlineOpen(false),
    }, el('span', { class: 'doc-outline__ico', html: renderIcon('chevron') }));

    const tabs = el('div', { class: 'doc-outline__tabs' }, [
      el('div', { class: 'doc-outline__tabhead' }, [
        el('span', { class: 'doc-outline__label' }, 'Document tabs'),
        el('button', {
          class: 'doc-outline__add', type: 'button', 'data-tip': 'Add tab', 'aria-label': 'Add tab',
          onClick: () => bus.emit('toast', 'Multiple document tabs — coming soon.'),
        }, el('span', { class: 'doc-outline__ico', html: renderIcon('plus') })),
      ]),
      el('button', { class: 'doc-outline__tab is-active', type: 'button' }, [
        el('span', { class: 'doc-outline__tabico', html: renderIcon('document') }),
        el('span', {}, 'Tab 1'),
      ]),
    ]);

    ui.outlineList = el('div', { class: 'doc-outline__list' });
    const panel = el('div', { class: 'doc-outline__panel' }, [
      el('div', { class: 'doc-outline__head' }, [back]),
      tabs,
      el('div', { class: 'doc-outline__outhead' }, 'Outline'),
      ui.outlineList,
    ]);

    rootEl.replaceChildren(toggle, panel);
    setOutlineOpen(outlineOpen);
  }

  function setOutlineOpen(open) {
    outlineOpen = open;
    if (outlineEl) outlineEl.classList.toggle('is-open', open);
    if (open) refreshOutline();
  }

  function refreshOutline() {
    if (!ui.outlineList || !editor || !hasDoc) return;
    // Flow docs tag headings as h1/h2/h3; positioned (exact-layout) docs tag them
    // as .doc-posbox[data-heading]. Collect both, in document (DOM) order.
    const heads = Array.from(editor.element.querySelectorAll(
      'h1.doc-block, h2.doc-block, h3.doc-block, .doc-posbox[data-heading]'
    ));
    if (!heads.length) {
      ui.outlineList.replaceChildren(
        el('p', { class: 'doc-outline__empty' }, 'Headings that you add to the document will appear here.')
      );
      return;
    }
    ui.outlineList.replaceChildren(...heads.map((h) => {
      const level = h.dataset && h.dataset.heading ? `h${h.dataset.heading}` : h.tagName.toLowerCase();
      // Plain heading text only, with internal whitespace/newlines collapsed —
      // the outline shows clean names, never document markup or formatting.
      const text = (h.textContent || '').replace(/\s+/g, ' ').trim() || 'Heading';
      return el('button', {
        class: `doc-outline__item doc-outline__item--${level}`, type: 'button', title: text,
        onClick: () => {
          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
          editor.focus();
          const r = document.createRange();
          r.selectNodeContents(h);
          r.collapse(true);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
        },
      }, text);
    }));
  }

  /* -------------------------- formatting toolbar ------------------------ */
  function buildToolbar(bar) {
    // Paragraph style.
    ui.style = mkSelect([
      { value: 'p', label: 'Normal text' },
      { value: 'h1', label: 'Heading 1' },
      { value: 'h2', label: 'Heading 2' },
      { value: 'h3', label: 'Heading 3' },
    ], (v) => editor.setBlockTag(v), 'doc-toolbar__style');

    ui.font = mkSelect(FONT_OPTIONS, (v) => editor.setFontFamily(v), 'doc-toolbar__font');
    ui.size = mkSelect(FONT_SIZES.map((s) => ({ value: String(s), label: String(s) })), (v) => editor.setFontSize(v), 'doc-toolbar__size');
    ui.size.value = '16';

    ui.bold = mkBtn('bold', 'Bold (Ctrl+B)', () => editor.toggleMark('bold'));
    ui.italic = mkBtn('italic', 'Italic (Ctrl+I)', () => editor.toggleMark('italic'));
    ui.underline = mkBtn('underline', 'Underline (Ctrl+U)', () => editor.toggleMark('underline'));
    ui.strike = mkBtn('strikethrough', 'Strikethrough', () => editor.toggleMark('strikeThrough'));
    ui.superscript = mkBtn('superscript', 'Superscript', () => editor.toggleMark('superscript'));
    ui.subscript = mkBtn('subscript', 'Subscript', () => editor.toggleMark('subscript'));
    ui.clear = mkBtn('clear-format', 'Clear formatting', () => editor.clearFormatting());

    // Line spacing (paragraph-level) — writes lineHeight, which round-trips in the
    // block model. Options mirror Word's common presets.
    ui.lineSpacing = mkSelect(
      [['', 'Line spacing'], ['1', 'Single'], ['1.15', '1.15'], ['1.5', '1.5'], ['2', 'Double']]
        .map(([value, label]) => ({ value, label })),
      (v) => { if (v) editor.setBlockStyle('lineHeight', v); },
      'doc-toolbar__linespacing',
    );

    // Highlighter: a single marker button (like a highlighter pen). LEFT-click
    // highlights the selection / arms the marker so text you type comes out
    // highlighted; left-click again removes it. RIGHT-click opens a colour panel
    // to change the marker colour. Read the live state synchronously (not the
    // debounced highlightOn) so the toggle decision is never stale.
    ui.highlight = mkBtn('highlight', 'Highlight text · right-click for colours', () =>
      applyHighlight(editor.getFormat()?.highlight ? 'transparent' : highlightColor)
    );
    ui.highlight.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openHighlightPalette(ui.highlight);
    });

    // Apply on `change` (fires once when the picker closes) — not `input`, which
    // streams while dragging and would fight the editor re-focus. foreColor then
    // only affects the selection / next-typed text, never earlier text.
    ui.color = el('input', {
      class: 'doc-toolbar__color', type: 'color', value: '#111111', title: 'Text colour',
      onChange: (e) => editor.setColor(e.target.value),
    });

    ui.alignLeft = mkBtn('align-left', 'Align left', () => editor.setAlign('left'));
    ui.alignCenter = mkBtn('align-center', 'Align center', () => editor.setAlign('center'));
    ui.alignRight = mkBtn('align-right', 'Align right', () => editor.setAlign('right'));
    ui.alignJustify = mkBtn('align-justify', 'Justify', () => editor.setAlign('justify'));

    ui.bullet = mkBtn('list-bullet', 'Bulleted list', () => editor.insertList(false));
    ui.number = mkBtn('list-numbered', 'Numbered list', () => editor.insertList(true));

    bar.replaceChildren(
      grp([ui.style]),
      sep(),
      grp([ui.font, ui.size]),
      sep(),
      grp([ui.bold, ui.italic, ui.underline, ui.strike]),
      sep(),
      grp([ui.superscript, ui.subscript, ui.clear]),
      sep(),
      grp([ui.highlight, ui.color]),
      sep(),
      grp([ui.alignLeft, ui.alignCenter, ui.alignRight, ui.alignJustify]),
      sep(),
      grp([ui.bullet, ui.number, ui.lineSpacing]),
      // Insert (table/image) and Download now live in the top menu bar.
    );
  }

  const grp = (children) => el('div', { class: 'doc-toolbar__group' }, children);
  const sep = () => el('span', { class: 'doc-toolbar__sep' });

  function mkBtn(icon, tip, onClick) {
    return el('button', {
      class: 'doc-btn', type: 'button', 'data-tip': tip, 'aria-label': tip,
      // Keep the caret/selection in the editor when clicking a formatting button.
      onMousedown: (e) => e.preventDefault(),
      onClick,
    }, el('span', { class: 'doc-btn__ico', html: renderIcon(icon) }));
  }

  function mkSelect(options, onChange, cls) {
    const s = el('select', {
      class: `doc-select ${cls || ''}`,
      onMousedown: (e) => e.stopPropagation(),
      onChange: (e) => onChange(e.target.value),
    }, options.map((o) => el('option', { value: o.value }, o.label)));
    return s;
  }

  /**
   * Insert-table button with a Google-Docs-style size picker: click opens a grid,
   * hovering highlights an R×C rectangle (with a live "cols × rows" readout), and
   * clicking a cell inserts that table via the existing engine. The grid can be
   * dragged past its initial size — a bottom row/right column is added on demand
   * so you can build larger tables without a separate dialog.
   */
  function mkTablePicker() {
    const COLS = 20, ROWS = 20; // grid to pick table size up to 20 × 20
    let menu = null;
    const close = () => { if (menu) { menu.remove(); menu = null; document.removeEventListener('click', close); } };
    const btn = el('button', {
      class: 'doc-btn', type: 'button', 'data-tip': 'Insert table', 'aria-label': 'Insert table',
      onMousedown: (e) => e.preventDefault(),
      onClick: (e) => {
        e.stopPropagation();
        if (menu) return close();
        menu = buildPicker();
        document.body.appendChild(menu);
        const rect = btn.getBoundingClientRect();
        menu.style.top = `${Math.round(rect.bottom + 4)}px`;
        // Keep the popup on-screen (it's near the right edge of the menu bar).
        const w = menu.offsetWidth || 220;
        menu.style.left = `${Math.round(Math.min(rect.left, window.innerWidth - w - 8))}px`;
        setTimeout(() => document.addEventListener('click', close), 0);
      },
    }, el('span', { class: 'doc-btn__ico', html: renderIcon('table') }));

    function buildPicker() {
      const label = el('div', { class: 'doc-tablegrid__label' }, 'Insert table');
      const grid = el('div', { class: 'doc-tablegrid__grid', style: `grid-template-columns: repeat(${COLS}, 16px)` });
      const cells = [];
      for (let r = 1; r <= ROWS; r += 1) {
        for (let c = 1; c <= COLS; c += 1) {
          const cell = el('span', {
            class: 'doc-tablegrid__cell', dataset: { c, r },
            onMouseenter: () => hover(c, r),
            onClick: (ev) => { ev.stopPropagation(); close(); editor.insertTable(r, c); },
          });
          cells.push(cell);
          grid.appendChild(cell);
        }
      }
      // Highlight the top-left R×C rectangle — just toggle classes, no re-render.
      const hover = (c, r) => {
        for (const cell of cells) cell.classList.toggle('is-on', +cell.dataset.c <= c && +cell.dataset.r <= r);
        label.textContent = `${c} × ${r}`;
      };
      return el('div', {
        class: 'app-menu doc-tablegrid', role: 'menu',
        onMousedown: (e) => e.preventDefault(), // keep the editor selection
      }, [grid, label]);
    }
    return btn;
  }

  // The Download control is a compact two-tier menu: a primary "Quick Export"
  // (the existing, unchanged PDF/Word/HTML formats) and "Advanced Export", which
  // opens the professional panel of document tools. The advanced options are
  // never dumped into this dropdown — it stays small.
  function mkExportMenu() {
    let menu = null;
    const close = () => { if (menu) { menu.remove(); menu = null; document.removeEventListener('click', close); } };
    const btn = el('button', {
      class: 'doc-btn doc-btn--wide doc-btn--export-glow', type: 'button', 'data-tip': 'Export',
      onClick: (e) => {
        e.stopPropagation();
        if (menu) return close();
        menu = el('div', {
          class: 'app-menu doc-export-menu doc-export-menu--rich', role: 'menu',
          // Swallow in-menu clicks so navigating between views doesn't reach the
          // document listener that closes the popover; only outside clicks close.
          onClick: (e) => e.stopPropagation(),
        });
        render();
        btn.parentElement.appendChild(menu);
        setTimeout(() => document.addEventListener('click', close), 0);
      },
    }, [
      el('span', { class: 'doc-btn__ico', html: renderIcon('export') }),
      el('span', { class: 'doc-btn__txt' }, 'Export'),
    ]);

    // A single popover with two choices: Quick Export (one-click Word download) and
    // Advanced Export (the full format/tools panel).
    function render() {
      if (!menu) return;
      menu.replaceChildren(...mainView());
      menu.querySelector('button')?.focus();
    }

    function mainView() {
      return [
        el('div', { class: 'doc-xmenu__title' }, 'Export'),
        // Quick Export = one click → download Word (.docx). No second step; other
        // formats live under Advanced Export.
        richRow('word', 'Quick Export', 'Download Word (.docx)', () => { close(); doExport('docx'); }),
        richRow('sparkle', 'Advanced Export', 'More formats and document tools', () => { close(); openAdvancedExport(); }, 'doc-xmenu__row--glow'),
      ];
    }

    function richRow(icon, label, desc, onPick, extraClass) {
      return el('button', {
        class: `doc-xmenu__row${extraClass ? ' ' + extraClass : ''}`, type: 'button', role: 'menuitem', onClick: onPick,
      }, [
        el('span', { class: 'doc-xmenu__row-ico', html: renderIcon(icon), 'aria-hidden': 'true' }),
        el('span', { class: 'doc-xmenu__row-txt' }, [
          el('span', { class: 'doc-xmenu__row-lbl' }, label),
          el('span', { class: 'doc-xmenu__row-desc' }, desc),
        ]),
        el('span', { class: 'doc-xmenu__row-chev', html: renderIcon('chevron'), 'aria-hidden': 'true' }),
      ]);
    }

    return btn;
  }

  // Quick Export — unchanged: hand the chosen format to the shared export manager.
  function doExport(format) {
    const base = (store.getState().docName || 'document').replace(/\.[^.]+$/, '');
    const ext = format === 'docx' ? 'docx' : format;
    services.exportManager.run({ format, filename: `${base}.${ext}` });
  }

  function openAdvancedExport() {
    if (!editor || !hasDoc) { bus.emit('toast', 'Create or open a document first.'); return; }
    if (!advExportPanel) {
      advExportPanel = createDocExportPanel({
        getModel: () => editor.getModel(),
        getDocName: () => store.getState().docName || 'document',
        downloadBlob: triggerDownload,
        toast: (m) => bus.emit('toast', m),
      });
    }
    advExportPanel.open();
  }

  function pickImage() {
    const inp = el('input', { type: 'file', accept: 'image/*' });
    inp.addEventListener('change', () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => editor.insertImage(reader.result);
      reader.readAsDataURL(file);
    });
    inp.click();
  }

  // Insert → Shape: open the full Office-style shape library and drop the chosen
  // shape as an SVG image (so it round-trips + exports via the image pipeline).
  function insertShape() {
    if (!editor) return;
    openShapePicker({
      onPick: ({ id, fill, stroke }) => {
        // Insert as a recolourable shape (right-click → Fill/Border/Line colour).
        editor.insertShape({ id, fill, stroke, width: 180 });
      },
    });
  }

  // Insert → Stamp: open the shared stamp library and drop the chosen stamp as an
  // SVG image (so it round-trips + exports via the image pipeline, exactly like a
  // shape). Same stamp designs as the PDF editor.
  function insertStamp() {
    if (!editor || !hasDoc) { bus.emit('toast', 'Create or open a document first.'); return; }
    openStampPicker({
      onPick: (def) => {
        const src = `data:image/svg+xml,${encodeURIComponent(stampSvgMarkup(def))}`;
        editor.insertImage(src, def.w);
      },
    });
  }

  // Insert → Professional Library: a SEPARATE tool from Shapes. Opens the chart &
  // graph library; picking a type inserts a real editable chart object.
  function openProLibrary() {
    if (!editor || !hasDoc) { bus.emit('toast', 'Create or open a document first.'); return; }
    openChartPicker({ onPick: (typeId) => editor.insertChart(defaultChart(typeId)) });
  }
  function openSymbols() {
    if (!editor || !hasDoc) { bus.emit('toast', 'Create or open a document first.'); return; }
    openSymbolLibrary({
      insert: (ch) => editor.insertText(ch),
      restore: () => editor.restoreCaret(),
    });
  }

  /* ------------------------ selection reflection ------------------------ */
  function reflectSelection(fmt) {
    if (!fmt) return;
    toggle(ui.bold, fmt.bold);
    toggle(ui.italic, fmt.italic);
    toggle(ui.underline, fmt.underline);
    toggle(ui.strike, fmt.strike);
    toggle(ui.superscript, fmt.superscript);
    toggle(ui.subscript, fmt.subscript);
    if (ui.lineSpacing) {
      const opts = ['1', '1.15', '1.5', '2'];
      const lh = fmt.lineHeight != null ? String(fmt.lineHeight) : '';
      ui.lineSpacing.value = opts.includes(lh) ? lh : '';
    }
    toggle(ui.alignLeft, fmt.align === 'left');
    toggle(ui.alignCenter, fmt.align === 'center');
    toggle(ui.alignRight, fmt.align === 'right');
    toggle(ui.alignJustify, fmt.align === 'justify');
    toggle(ui.bullet, fmt.unordered);
    toggle(ui.number, fmt.ordered);
    highlightOn = !!fmt.highlight;
    toggle(ui.highlight, highlightOn);
    if (ui.style) ui.style.value = /^(h1|h2|h3)$/.test(fmt.blockTag) ? fmt.blockTag : 'p';
    if (ui.size && fmt.fontSize) ui.size.value = String(fmt.fontSize);
    if (ui.font && fmt.fontFamily) matchFontOption(ui.font, fmt.fontFamily);
    if (ui.color && fmt.color) ui.color.value = normHex(fmt.color);
    // Keep the shared properties panel showing typography for the caret.
    bus.emit('selection:change', textSelection(fmt));
  }

  const toggle = (btn, on) => btn && btn.classList.toggle('is-active', !!on);
  const textSelection = (fmt) => selection(SelectionKind.TEXT, { label: 'Text', values: fmt || {} });

  function matchFontOption(select, family) {
    const first = family.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
    const opt = Array.from(select.options).find((o) => o.value.toLowerCase().includes(first));
    if (opt) select.value = opt.value;
  }
  function normHex(c) {
    if (/^#[0-9a-f]{6}$/i.test(c)) return c;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(c || '');
    if (!m) return '#111111';
    const h = (n) => Number(n).toString(16).padStart(2, '0');
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
  }

  /* ------------------------------ open files ---------------------------- */
  async function openFile(file) {
    const name = file.name || 'Document';
    if (/\.docx$/i.test(name)) {
      const buf = await file.arrayBuffer();
      loadDoc(await docxToBlockModel(buf, name.replace(/\.docx$/i, '')), name);
    } else if (/\.(txt|md|markdown)$/i.test(name) || (file.type || '').startsWith('text/')) {
      loadDoc(textToDoc(await file.text(), name), name);
    } else if (/\.doc$/i.test(name)) {
      bus.emit('toast', 'Legacy .doc isn’t supported — save it as .docx and try again.');
    } else {
      bus.emit('toast', 'Open a Word (.docx), text or Markdown file in the Document editor.');
    }
  }

  function textToDoc(text, name) {
    const paras = String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/);
    const blocks = paras.map((p) => createParagraph({ runs: [createRun(p.replace(/\n/g, ' '))] }));
    return createDocument({ title: name.replace(/\.[^.]+$/, ''), source: 'blank', blocks: blocks.length ? blocks : undefined });
  }

  /* --------------------- shared properties-panel bridge ----------------- */
  // A few advanced controls in the right panel drive the live editor. We only
  // react while this workspace owns the document, and only for text controls.
  bus.on('property:change', ({ kind, key, value }) => {
    if (!editor || !hasDoc || kind !== SelectionKind.TEXT) return;
    if (key === 'lineHeight') editor.setBlockStyle('lineHeight', value);
    else if (key === 'letterSpacing') editor.setInlineStyle('letterSpacing', `${value}px`);
    else if (key === 'highlight') editor.setInlineStyle('backgroundColor', value);
    else if (key === 'textCase') editor.setInlineStyle('textTransform', value === 'none' ? 'none' : value);
  });

  /* ------------------------------ contract ------------------------------ */
  return {
    id: 'document',
    label: 'Document',
    icon: 'document',
    accepts: (f) => f && /\.(docx?|txt|md|markdown)$/i.test(f.name || '') || /^text\//.test((f && f.type) || ''),

    mount,
    activate() {
      // Word-processor takeover only while a document is open; the empty screen
      // keeps the normal shell so the nav stays reachable.
      store.setState({ homeMode: false, blankMode: false, docMode: hasDoc });
      if (editor && hasDoc) editor.setEditable(true);
      bus.emit('selection:change', hasDoc ? textSelection() : emptySelection());
    },
    deactivate() {
      closeMenu();
      closeHighlightPalette();
      closePageSetup();
      closeHfSettings();
      if (editor) editor.setEditable(false);
      // Restore the shared chrome for whatever workspace comes next.
      setDocMode(false);
    },
    onActivate(payload) {
      if (payload?.intent === 'new' && !hasDoc) newBlank();
    },

    getToolbar: () => ({ groups: [] }), // the workspace renders its own formatting bar
    getTools: () => [],

    handleAction(action) {
      switch (action) {
        case 'undo': editor?.undo(); return true;
        case 'redo': editor?.redo(); return true;
        case 'zoom-in': return applyDocZoom(editor?.zoomIn());
        case 'zoom-out': return applyDocZoom(editor?.zoomOut());
        case 'zoom-fit': return applyDocZoom(editor?.setZoom(1));
        case 'save-project': return saveProject();
        case 'open-project': return openProject();
        default: return false;
      }
    },

    async open(file) { await openFile(file); },

    // Open an already-built Document model in place (no file, no import). Used by the
    // PDF editor's "Transfer to Doc" to hand over a positioned exact-layout document
    // it built from the PDF's own coordinates. Reuses the normal load path, so the
    // editor enters word-processor mode with the document ready to edit.
    openModel(model, name) { loadDoc(model, name || (model && model.title) || 'Document'); },

    // Called by the export manager. Returns a Blob (downloaded) or nothing.
    async export(options = {}) {
      if (!editor || !hasDoc) { bus.emit('toast', 'Create or open a document first.'); return; }
      const model = editor.getModel();
      const fmt = options.format || 'pdf';
      if (fmt === 'docx' || fmt === 'word') return blockModelToDocx(model);
      if (fmt === 'html') return htmlBlob(model);
      return blockModelToPdf(model);
    },

    getSelection: () => (hasDoc ? textSelection() : emptySelection()),
    destroy() { closeMenu(); closeHighlightPalette(); closePageSetup(); closeHfSettings(); advExportPanel?.destroy(); editor?.destroy(); },
  };

  /* ------------------- local project persistence (.dmdoc) --------------- */
  function saveProject() {
    if (!editor || !hasDoc) { bus.emit('toast', 'Nothing to save yet.'); return true; }
    const json = JSON.stringify({ v: 1, kind: 'document', model: editor.getModel() });
    const blob = new Blob([json], { type: 'application/json' });
    const base = (store.getState().docName || 'document').replace(/\.[^.]+$/, '');
    triggerDownload(blob, `${base}.dmdoc`);
    bus.emit('toast', 'Saved a local document project (.dmdoc).');
    return true;
  }

  function openProject() {
    const inp = el('input', { type: 'file', accept: '.dmdoc,application/json' });
    inp.addEventListener('change', async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data.kind !== 'document' || !data.model) throw new Error('bad');
        loadDoc(data.model, file.name.replace(/\.dmdoc$/i, ''));
      } catch {
        bus.emit('toast', 'That isn’t an Advance Office Doc document project.');
      }
    });
    inp.click();
    return true;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
