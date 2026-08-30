/**
 * DocMaster — unified application shell entry point.
 *
 * Assembles the shared shell (nav, toolbar, contextual properties, status bar)
 * and the workspace system, then wires the command router. This file owns NO
 * PDF- or Document-specific logic: it only knows the workspace contract and the
 * bus. Adding a workspace = register it here; adding a nav item = edit
 * `config/navigation.js`. See ARCHITECTURE.md.
 */
import { hydrateIcons, renderIcon } from '../workspace/icons.js';
import { el } from '../workspace/utils/dom.js';
import { keyboard } from './core/keyboard.js';
import { logCapabilities } from './core/capabilities.js';
import { registerTesseractOcr } from './core/ai/ocrTesseract.js';
import { createEventBus } from './core/eventBus.js';
import { createAppStore } from './core/appStore.js';
import { createWorkspaceRegistry } from './core/workspaceRegistry.js';
import { createWorkspaceManager } from './core/workspaceManager.js';
import { createPropertyRegistry } from './core/propertyRegistry.js';
import { createFileManager } from './services/fileManager.js';
import { createExportManager } from './services/exportManager.js';
import { builtinPropertyProviders } from './properties/index.js';
import { assertWorkspace } from './workspaces/workspaceContract.js';
import { createHomeWorkspace } from './workspaces/home/homeWorkspace.js';
import { createPdfWorkspace } from './workspaces/pdf/pdfWorkspace.js';
import { createDocumentWorkspace } from './workspaces/document/documentWorkspace.js';
import { initNavSidebar } from './shell/navSidebar.js';
import { initToolbar } from './shell/toolbar.js';
import { initPropertiesPanel } from './shell/propertiesPanel.js';
import { initStatusBar } from './shell/statusBar.js';
import { initToasts } from './shell/toast.js';

const root = document.getElementById('app');
if (root) boot(root);

// Detect runtime capabilities (WebGPU / WASM threads / cross-origin isolation)
// and log a one-line report. Fire-and-forget; the compute layer consumes the
// cached result. See core/capabilities.js and docs/ARCHITECTURE.md (Phase 1/2).
logCapabilities();

// Register the on-device OCR engine behind "Make editable" (the Exact-layout AI
// layer that turns baked text — e.g. Hindi the PDF stored scrambled — back into
// editable text). This only INSTALLS a lazy loader; nothing is imported or
// downloaded until the user first recognises a region. Self-hosted + same-origin
// to satisfy the strict CSP. See core/ai/ocr.js and core/ai/ocrTesseract.js.
registerTesseractOcr();

// Step 1 of the in-browser PDF→Word AI: a manual AI-engine smoke test. Run
// `window.__dmTestAI()` in the DevTools console — it loads ONNX Runtime Web on
// demand (~27 MB, then cached) and runs a tiny model, logging whether on-device
// inference works in this browser and on which backend (WebGPU/WASM). Kept
// manual so the runtime is never downloaded on a normal page load.
window.__dmTestAI = () =>
  import('./core/onnx/smoketest.js')
    .then((m) => m.testAI())
    .catch((e) => { console.error('[DocMaster] ❌ AI engine FAILED:', e); throw e; });

function boot(root) {
  const q = (sel) => root.querySelector(sel);
  const els = {
    root,
    toolbar: q('[data-region="toolbar"]'),
    nav: q('[data-region="nav"]'),
    stage: q('[data-region="stage"]'),
    panel: q('[data-region="panel"]'),
    status: q('[data-region="status"]'),
  };

  hydrateIcons(root);

  // Install the single global keyboard arbiter before any workspace/editor wires
  // its shortcuts or editing sessions. See core/keyboard.js.
  keyboard.install();

  // ---- shared kernel ----
  const bus = createEventBus();
  const store = createAppStore();
  const properties = createPropertyRegistry();
  properties.registerAll(builtinPropertyProviders);

  const services = {};
  services.fileManager = createFileManager({ store, bus });

  const registry = createWorkspaceRegistry();
  const manager = createWorkspaceManager({ registry, store, bus, stageEl: els.stage });
  services.exportManager = createExportManager({ manager, store, bus });

  // ---- workspaces ----
  const wsCtx = { bus, store, services };
  [createHomeWorkspace(wsCtx), createPdfWorkspace(wsCtx), createDocumentWorkspace(wsCtx)].forEach((ws) =>
    registry.register(assertWorkspace(ws))
  );

  // ---- shared shell UI ----
  initToasts({ bus });
  initNavSidebar({ root: els.nav, store, bus });
  initToolbar({ root: els.toolbar, store, bus, manager });
  initPropertiesPanel({ root: els.panel, store, bus, properties });
  initStatusBar({ root: els.status, store });

  // Panel open state / responsive default. Kept in sync reactively so any
  // workspace can show/hide the contextual panel via store.setState({ panelOpen })
  // — e.g. the blank PDF editor reveals it only when an object is selected.
  const syncPanel = (open) => root.classList.toggle('is-panel-collapsed', !open);
  syncPanel(store.getState().panelOpen);
  // The blank PDF editor hides the global nav for a single unified sidebar.
  const syncNav = (hidden) => root.classList.toggle('is-nav-hidden', hidden);
  syncNav(store.getState().navHidden);
  // Blank editor takes over the whole window: collapse ALL shared chrome.
  const syncBlank = (on) => root.classList.toggle('is-blank-mode', on);
  syncBlank(store.getState().blankMode);
  // Minimal home launcher: also collapse ALL shared chrome.
  const syncHome = (on) => root.classList.toggle('is-home-mode', on);
  syncHome(store.getState().homeMode);
  // Document word-processor mode: collapse the shared toolbar/nav/panel (the
  // Document workspace renders its own menu + formatting bars) but KEEP the
  // status bar. See workspaces/document/documentWorkspace.js.
  const syncDoc = (on) => root.classList.toggle('is-doc-mode', on);
  syncDoc(store.getState().docMode);
  store.subscribe((s, p) => {
    if (s.panelOpen !== p.panelOpen) syncPanel(s.panelOpen);
    if (s.navHidden !== p.navHidden) syncNav(s.navHidden);
    if (s.blankMode !== p.blankMode) syncBlank(s.blankMode);
    if (s.homeMode !== p.homeMode) syncHome(s.homeMode);
    if (s.docMode !== p.docMode) syncDoc(s.docMode);
  });

  wireCommands({ root, els, bus, store, manager, services });

  // Start on Home.
  manager.activate('home', { view: 'home' });
}

/* -------------------------------------------------------------------------- */
/*  Command router — the single place that turns intents into effects.        */
/* -------------------------------------------------------------------------- */
function wireCommands({ root, els, bus, store, manager, services }) {
  const { fileManager, exportManager } = services;

  // Navigation commands from the sidebar / hub cards.
  bus.on('nav:command', async ({ command, arg }) => {
    switch (command) {
      case 'view': // Home / Recent / Projects
        store.setState({ homeView: arg });
        manager.activate('home', { view: arg });
        break;

      case 'workspace':
        manager.activate(arg);
        break;

      case 'edit-pdf': {
        // "Edit PDF" now opens a PDF straight into the single modern editor.
        const [file] = await fileManager.pick('pdf');
        if (file) openInWorkspace(file, 'pdf');
        break;
      }

      case 'open': {
        const kind = arg === 'pdf' ? 'pdf' : 'document';
        const [file] = await fileManager.pick(kind);
        if (file) openInWorkspace(file, arg === 'pdf' ? 'pdf' : classifyTarget(file));
        break;
      }

      case 'new-pdf':
        // Brand-new blank A4 authoring canvas — no picker, no sample document.
        // The PDF workspace boots its blank editor (see blankPdfEditor.js).
        manager.activate('pdf', { intent: 'blank' });
        break;

      case 'new-document':
        manager.activate('document', { intent: 'new' });
        break;

      case 'pdf-tool':
        // Showcase-only on the home grid — no action, no toast.
        break;

      case 'doc-tool':
        // Showcase-only on the home grid — no action, no toast.
        break;

      case 'reopen':
        bus.emit('toast', `Reopening "${arg?.name}" — coming soon.`);
        break;

      default:
        bus.emit('toast', `${command} — coming soon.`);
    }
  });

  // Files dropped anywhere in a workspace.
  bus.on('file:dropped', (files) => {
    const file = files[0];
    if (file) openInWorkspace(file, classifyTarget(file));
  });

  // An in-memory file handed off by a workspace (e.g. the PDF editor's "Edit in
  // Document editor" converts the PDF to a .docx and asks us to open it in the
  // Document workspace). Same effect as a drop/open, but the target workspace is
  // explicit and the file never touches the disk or network.
  bus.on('workspace:open-file', ({ file, workspaceId } = {}) => {
    if (file) openInWorkspace(file, workspaceId || classifyTarget(file));
  });

  // An already-built document MODEL handed off by a workspace (the PDF editor's
  // "Transfer to Doc" builds a positioned exact-layout Document and passes it
  // straight to the Document workspace — no file, no import round-trip).
  bus.on('workspace:open-doc-model', ({ model, name } = {}) => {
    if (!model) return;
    const ws = manager.activate('document') || manager.current();
    ws?.openModel?.(model, name);
  });

  // Fixed toolbar chrome buttons (data-action) via one delegated listener.
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !root.contains(btn)) return;
    if (btn.dataset.action === 'file-menu') { e.stopPropagation(); toggleFileMenu(btn); return; }
    doAction(btn.dataset.action);
  });

  // Ctrl/Cmd+O opens a file from anywhere (matches the toolbar's File → Open).
  // Registered through the central keyboard manager, so it is automatically
  // suspended while a text editor owns the keyboard. See core/keyboard.js.
  keyboard.register({
    match: (e) => (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'o' || e.key === 'O'),
    onKeyDown: (e) => {
      e.preventDefault();
      bus.emit('nav:command', { command: 'open', arg: 'any' });
      return true;
    },
  });

  // Property-panel button actions and the like.
  bus.on('action', doAction);

  /* ------------------------------ File menu ------------------------------- */
  // A small popover anchored under the toolbar's "File" button. Today it holds a
  // single "Open…" item (Ctrl+O); it is the standard-menu home for file actions
  // now that opening no longer lives on the landing screen.
  let fileMenu = null;
  const closeFileMenu = () => {
    if (!fileMenu) return;
    fileMenu.anchor.setAttribute('aria-expanded', 'false');
    fileMenu.el.remove();
    fileMenu = null;
  };
  document.addEventListener('click', closeFileMenu);

  function toggleFileMenu(anchor) {
    const wasOpen = fileMenu && fileMenu.anchor === anchor;
    closeFileMenu();
    if (wasOpen) return;
    const menu = el('div', { class: 'app-menu app-menu--file', role: 'menu' }, [
      el('button', {
        class: 'app-menu__item', type: 'button', role: 'menuitem',
        onClick: (e) => { e.stopPropagation(); closeFileMenu(); bus.emit('nav:command', { command: 'open', arg: 'any' }); },
      }, [
        el('span', { class: 'app-menu__icon', html: renderIcon('open') }),
        el('span', { class: 'app-menu__label' }, 'Open…'),
        el('span', { class: 'app-menu__shortcut' }, 'Ctrl+O'),
      ]),
      // Local project persistence — save/reopen the full editable document as a
      // .dmz (client-side, in the browser; no upload). Handled by the active
      // workspace via handleAction → the editor shell.
      el('button', {
        class: 'app-menu__item', type: 'button', role: 'menuitem',
        onClick: (e) => { e.stopPropagation(); closeFileMenu(); bus.emit('action', 'open-project'); },
      }, [
        el('span', { class: 'app-menu__icon', html: renderIcon('open') }),
        el('span', { class: 'app-menu__label' }, 'Open project'),
        el('span', { class: 'app-menu__shortcut' }, '.dmz'),
      ]),
      el('button', {
        class: 'app-menu__item', type: 'button', role: 'menuitem',
        onClick: (e) => { e.stopPropagation(); closeFileMenu(); bus.emit('action', 'save-project'); },
      }, [
        el('span', { class: 'app-menu__icon', html: renderIcon('save') }),
        el('span', { class: 'app-menu__label' }, 'Save project'),
        el('span', { class: 'app-menu__shortcut' }, '.dmz'),
      ]),
    ]);
    anchor.setAttribute('aria-expanded', 'true');
    anchor.parentElement.appendChild(menu);
    fileMenu = { el: menu, anchor };
  }

  function doAction(action) {
    switch (action) {
      case 'open':
        return bus.emit('nav:command', { command: 'open', arg: 'any' });
      case 'export':
        return exportManager.run();
      case 'save':
        return bus.emit('toast', 'Saved to your browser (demo).');
      case 'undo':
      case 'redo':
        return manager.current()?.handleAction?.(action) || bus.emit('toast', 'Nothing to ' + action);
      case 'toggle-panel':
        return togglePanel();
      case 'print':
        return window.print();
      case 'search':
        return bus.emit('toast', 'Search — coming soon.');
      case 'account':
        return bus.emit('toast', 'Accounts — coming soon.');
      default:
        return manager.current()?.handleAction?.(action);
    }
  }

  async function openInWorkspace(file, workspaceId) {
    const ws = manager.activate(workspaceId) || manager.current();
    fileManager.remember(file, ws.id);
    store.setState({ status: 'loading', statusMessage: `Opening ${file.name}…` });
    try {
      await ws.open(file);
    } catch {
      store.setState({ status: 'error', statusMessage: 'Could not open the file.' });
    }
  }

  function classifyTarget(file) {
    return fileManager.classify(file) || 'document';
  }

  function togglePanel() {
    const open = !store.getState().panelOpen;
    store.setState({ panelOpen: open });
    root.classList.toggle('is-panel-collapsed', !open);
  }
}
