/**
 * PDF workspace — the single, modern PDF editor.
 *
 * This is a thin wrapper around the self-contained editor shell
 * (`editor/blankEditorShell.js`). There is exactly ONE PDF editing experience:
 *
 *   • "New PDF"      → a blank A4 page in the editor.
 *   • "Open/Import"  → the SAME editor, with the imported PDF's pages rendered as
 *                      editable backgrounds (annotate/add text/shapes on top).
 *
 * The legacy PDF.js viewer + in-place/document editors have been retired; all PDF
 * editing routes here. When active, the editor takes over the whole window
 * (`store.blankMode` → the shared shell chrome collapses).
 */
import { el } from '../../../workspace/utils/dom.js';
import { createBlankEditorShell } from '../../editor/blankEditorShell.js';

export function createPdfWorkspace({ bus, store, services }) {
  let shell = null;
  let stage = null;
  let rootEl = null;

  const isPdf = (f) => !!f && ((f.type || '') === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
  const isImage = (f) => !!f && (f.type || '').startsWith('image/');

  function ensureShell() {
    if (!shell) shell = createBlankEditorShell({ container: stage, bus });
    return shell;
  }

  function mount(container) {
    stage = el('div', { class: 'app-blank__stage' });
    rootEl = el('div', { class: 'app-blank' }, [stage]);
    container.appendChild(rootEl);
    ensureShell();
    // Drag-and-drop a PDF/image anywhere in the editor to open it.
    services.fileManager.enableDropZone(rootEl, (files) => bus.emit('file:dropped', files));
  }

  function enter() {
    ensureShell();
    shell.setActive(true);
    store.setState({ blankMode: true });
  }

  return {
    id: 'pdf',
    label: 'PDF',
    icon: 'pdf',
    accepts: (f) => isPdf(f) || isImage(f),

    mount,
    activate() { shell?.setActive(true); store.setState({ blankMode: true }); },
    deactivate() { shell?.setActive(false); store.setState({ blankMode: false }); },
    onActivate(payload) {
      enter();
      // "New PDF" starts a fresh blank document; plain (re)activation keeps work.
      if (payload?.intent === 'blank') {
        shell.newDocument();
        store.setState({ docName: 'Untitled.pdf', file: { name: 'Untitled.pdf', size: 0, type: 'application/pdf' } });
      }
    },

    getToolbar: () => ({ groups: [] }), // the editor renders its own toolbar
    getTools: () => [],
    handleAction: (action) => {
      // Local project persistence (.dmz) — routed from the File menu.
      if (action === 'save-project') { shell?.saveProject(); return true; }
      if (action === 'open-project') { shell?.openProject(); return true; }
      return false;
    },

    async open(file) {
      enter();
      store.setState({ docName: file.name, file: { name: file.name, size: file.size, type: file.type } });
      if (isPdf(file)) await shell.loadPdf(file);
      else if (isImage(file)) shell.loadImage(file);
      else bus.emit('toast', 'Open a PDF or image in the editor.');
    },

    // Flatten the editor (background + edited text) into a downloadable PDF.
    export: async () => {
      if (!shell) { bus.emit('toast', 'Open or create a PDF first.'); return; }
      return shell.exportPdf();
    },

    getSelection: () => ({ kind: 'none' }),
    destroy() { shell?.destroy(); },
  };
}
