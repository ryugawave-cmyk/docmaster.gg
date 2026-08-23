/**
 * DocMaster — Document Workspace entry point.
 *
 * Bootstraps the store, tool registry, history and UI components, then wires
 * global actions (open/save/export, zoom, undo/redo), file loading, keyboard
 * shortcuts and the properties panel together. Every feature plugs into these
 * shared systems; adding a tool never requires touching this file.
 */
import { createStore } from './core/store.js';
import { createToolRegistry } from './core/toolRegistry.js';
import { createEngine } from './engine/index.js';
import { builtinPlugins } from './engine/builtins/index.js';
import { createBlankDocument, createImageDocument } from './core/documentModel.js';
import { createPdfViewer } from './pdf/pdfViewer.js';
import { registerTools } from './tools/index.js';
import { hydrateIcons } from './icons.js';
import { initSidebar } from './ui/sidebar.js';
import { initToolbar } from './ui/toolbar.js';
import { initPropertiesPanel } from './ui/propertiesPanel.js';
import { initStatusBar } from './ui/statusBar.js';
import { initCanvas } from './ui/canvas.js';
import { initThumbnails } from './ui/thumbnails.js';

const root = document.getElementById('workspace');
if (root) boot(root);

function boot(root) {
  const q = (sel) => root.querySelector(sel);
  const els = {
    root,
    toolbar: q('[data-region="toolbar"]'),
    sidebar: q('[data-region="sidebar"]'),
    canvas: q('[data-region="canvas"]'),
    scroll: q('[data-region="scroll"]'),
    stage: q('[data-region="stage"]'),
    empty: q('[data-region="empty"]'),
    loading: q('[data-region="loading"]'),
    panel: q('[data-region="panel"]'),
    status: q('[data-region="status"]'),
    fileInput: q('[data-region="file-input"]'),
    docName: q('[data-bind="docName"]'),
  };

  hydrateIcons(root);

  const registry = createToolRegistry();
  registerTools(registry);

  const panelOpen = window.innerWidth > 1024;
  root.classList.toggle('is-panel-collapsed', !panelOpen);

  const store = createStore({
    file: null,
    document: null,
    status: 'idle',
    statusMessage: 'Ready',
    activeToolId: 'selection',
    toolSettings: {},
    zoom: 1,
    currentPage: 1,
    totalPages: 0,
    panelOpen,
    canUndo: false,
    canRedo: false,
  });

  // The document engine: shared by every tool. Owns the object model, layered
  // incremental rendering, selection, hit testing and the reversible command
  // stack. Its stack doubles as the workspace `history`, so the existing
  // toolbar/keyboard undo-redo wiring drives it unchanged.
  const engine = createEngine({ store, toolRegistry: registry });
  engine.plugins.useAll(builtinPlugins);
  const history = engine.asHistory();

  // PDF rendering (PDF.js) — isolated in its own module; paints real pages onto
  // the engine's background layer while annotations stay on the overlay above.
  const pdfViewer = createPdfViewer({ store });

  let api = null;

  const ctx = {
    store,
    registry,
    history,
    engine,
    pdf: pdfViewer,
    el: els,
    setActiveTool,
    setToolSetting,
    doAction,
    openFile,
    notify,
  };

  // UI components (each receives its own root where relevant).
  initSidebar({ ...ctx, root: els.sidebar });
  initToolbar({ ...ctx, root: els.toolbar });
  initPropertiesPanel({ ...ctx, root: els.panel });
  initStatusBar({ ...ctx, root: els.status });
  api = initCanvas(ctx);

  // Bind the engine to the live canvas: pointer→tool interaction on the stage
  // and viewport virtualization on the scroll container.
  engine.attach({ scrollEl: els.scroll, stageEl: els.stage });

  const thumbs = initThumbnails(ctx);

  bindGlobalActions();
  bindFileHandling();
  bindKeyboard();

  // Preselect a tool from ?tool=… (deep link from marketing pages).
  const initialTool = root.dataset.initialTool;
  if (initialTool && registry.has(initialTool)) setActiveTool(initialTool);

  /* ---------------- actions ---------------- */
  function setActiveTool(id) {
    if (!registry.has(id)) return;
    const state = store.getState();
    if (state.activeToolId === id) return;
    registry.get(state.activeToolId)?.onDeactivate?.(ctx);
    store.setState({ activeToolId: id });
    registry.get(id)?.onActivate?.(ctx);
  }

  function setToolSetting(toolId, key, value) {
    store.setState((state) => ({
      toolSettings: {
        ...state.toolSettings,
        [toolId]: { ...(state.toolSettings[toolId] || {}), [key]: value },
      },
    }));
  }

  function togglePanel(force) {
    const open = typeof force === 'boolean' ? force : !store.getState().panelOpen;
    store.setState({ panelOpen: open });
    root.classList.toggle('is-panel-collapsed', !open);
  }

  function doAction(action) {
    switch (action) {
      case 'open':
        return openFile();
      case 'new-blank':
        return openBlank();
      case 'undo':
        return history.undo();
      case 'redo':
        return history.redo();
      case 'zoom-in':
        return api.zoomIn();
      case 'zoom-out':
        return api.zoomOut();
      case 'zoom-fit':
        return api.fit();
      case 'zoom-fit-page':
        return api.fitPage();
      case 'rotate-cw':
        return pdfViewer.rotateAll(1);
      case 'rotate-ccw':
        return pdfViewer.rotateAll(-1);
      case 'toggle-thumbs':
        return thumbs.toggle();
      case 'toggle-panel':
        return togglePanel();
      case 'print':
        return window.print();
      case 'save':
        return notify('Saved to your browser (demo).');
      case 'export':
        return notify('Export is coming soon.');
      case 'search':
        return notify('Search is coming soon.');
      case 'account':
        return notify('Accounts are coming soon.');
      default:
        return notify(`${humanize(action)} — coming soon.`);
    }
  }

  /* ---------------- documents / files ---------------- */
  function openFile() {
    els.fileInput.value = '';
    els.fileInput.click();
  }

  function openBlank() {
    loadDocument(
      () =>
        Promise.resolve({
          doc: createBlankDocument(3),
          fileInfo: { name: 'Untitled document', size: 0, type: 'application/pdf' },
          message: 'New blank document',
        }),
      'Creating blank document…'
    );
  }

  // Show the loading skeleton for a short minimum so opening always feels smooth.
  const MIN_LOADING_MS = 440;

  function loadDocument(producer, loadingMessage) {
    store.setState({ status: 'loading', statusMessage: loadingMessage || 'Loading…' });
    const started = performance.now();
    Promise.resolve()
      .then(producer)
      .then((result) => {
        const wait = Math.max(0, MIN_LOADING_MS - (performance.now() - started));
        setTimeout(() => commitDocument(result.doc, result.fileInfo, result.message), wait);
      })
      .catch(() => {
        store.setState({ status: 'error', statusMessage: 'Could not open the file.' });
      });
  }

  function commitDocument(doc, fileInfo, message) {
    // Load into the engine first so the canvas can paint object overlays as it
    // rebuilds the page stack in response to the document change below.
    engine.load(doc);
    store.setState({
      document: doc,
      file: fileInfo,
      totalPages: doc.pages.length,
      currentPage: 1,
      status: 'ready',
      statusMessage: message || 'Ready',
    });
    els.docName.textContent = doc.name;
    requestAnimationFrame(() => api && api.fit());
  }

  function bindFileHandling() {
    els.fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

    // Drag & drop onto the canvas area.
    const dz = els.canvas;
    ['dragenter', 'dragover'].forEach((type) =>
      dz.addEventListener(type, (e) => {
        e.preventDefault();
        els.empty.classList.add('is-dragover');
      })
    );
    ['dragleave', 'drop'].forEach((type) =>
      dz.addEventListener(type, (e) => {
        e.preventDefault();
        if (type === 'dragleave' && dz.contains(e.relatedTarget)) return;
        els.empty.classList.remove('is-dragover');
      })
    );
    dz.addEventListener('drop', (e) => {
      if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
    });
  }

  function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const images = files.filter((f) => f.type.startsWith('image/'));
    const pdf = files.find((f) => f.type === 'application/pdf');
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    loadDocument(() => {
      if (images.length && !pdf) {
        return loadImages(images).then((loaded) => {
          const name = files.length > 1 ? `${files.length} images` : files[0].name;
          return {
            doc: createImageDocument(loaded, { name, size: totalSize, type: 'image' }),
            fileInfo: { name, size: totalSize, type: 'image' },
            message: 'Ready',
          };
        });
      }
      // Decode the PDF with PDF.js into a real, renderable document.
      if (pdf) return pdfViewer.load(pdf);
      throw new Error('Unsupported file type');
    }, `Opening ${files[0].name}…`);
  }

  /* ---------------- keyboard ---------------- */
  function bindKeyboard() {
    const shortcuts = {};
    registry.all().forEach((tool) => {
      if (tool.shortcut) shortcuts[tool.shortcut.toLowerCase()] = tool.id;
    });

    window.addEventListener('keydown', (e) => {
      if (isTyping(e.target)) return;
      const key = e.key.toLowerCase();

      // Let the active tool handle keys first (e.g. Delete removes the selection).
      engine.tools?.onKeyDown(e);
      if (e.defaultPrevented) return;

      if (e.ctrlKey || e.metaKey) {
        if (key === 'z') {
          e.preventDefault();
          e.shiftKey ? history.redo() : history.undo();
        } else if (key === 'y') {
          e.preventDefault();
          history.redo();
        } else if (key === '0') {
          e.preventDefault();
          api.fit();
        } else if (key === '9') {
          e.preventDefault();
          api.fitPage();
        } else if (key === ']') {
          e.preventDefault();
          pdfViewer.rotateAll(1);
        } else if (key === '[') {
          e.preventDefault();
          pdfViewer.rotateAll(-1);
        } else if (key === '=' || key === '+') {
          e.preventDefault();
          api.zoomIn();
        } else if (key === '-') {
          e.preventDefault();
          api.zoomOut();
        }
        return;
      }

      if (shortcuts[key]) {
        e.preventDefault();
        setActiveTool(shortcuts[key]);
      }
    });
  }

  /* ---------------- global click delegation ---------------- */
  function bindGlobalActions() {
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (btn && root.contains(btn)) doAction(btn.dataset.action, btn);
    });
  }

  /* ---------------- toasts ---------------- */
  function notify(message) {
    let host = document.querySelector('.ws-toasts');
    if (!host) {
      host = document.createElement('div');
      host.className = 'ws-toasts';
      document.body.appendChild(host);
    }
    const toast = document.createElement('div');
    toast.className = 'ws-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    host.appendChild(toast);
    setTimeout(() => toast.remove(), 2600);
  }
}

/* ---------------- helpers ---------------- */
function loadImages(files) {
  const MAX_W = 1600;
  return Promise.all(
    files.map(
      (file) =>
        new Promise((resolve, reject) => {
          const src = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
            const scale = Math.min(1, MAX_W / img.naturalWidth);
            resolve({
              src,
              width: Math.round(img.naturalWidth * scale),
              height: Math.round(img.naturalHeight * scale),
            });
          };
          img.onerror = reject;
          img.src = src;
        })
    )
  );
}

function isTyping(target) {
  if (!target) return false;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true;
  // contentEditable surfaces (e.g. the in-place PDF text-edit boxes) own every
  // key while focused — Space, Backspace, Delete, Enter and Arrows must reach
  // the editor, not workspace shortcuts. isContentEditable is also true for any
  // descendant of an editable region (nested styled spans), so this covers the
  // caret sitting inside a child element too.
  return target.isContentEditable === true;
}

function humanize(action) {
  return action
    .replace(/-run$/, '')
    .replace(/-/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}
