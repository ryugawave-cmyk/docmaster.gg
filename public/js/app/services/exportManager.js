/**
 * Export system.
 *
 * A thin, workspace-agnostic dispatcher. Each workspace implements its own
 * `export(options)` (a PDF workspace writes PDF bytes, a Document workspace can
 * emit PDF/DOCX/HTML). The export manager just resolves the active workspace,
 * asks it to produce output, and handles the shared bits (progress status,
 * triggering the browser download). Concrete exporters are a NEXT-PHASE concern;
 * this establishes the seam so neither workspace hard-codes download logic.
 */
export function createExportManager({ manager, store, bus }) {
  /**
   * Export the active workspace's document.
   * @param {object} [options] forwarded to the workspace's exporter (e.g. { format })
   */
  async function run(options = {}) {
    const ws = manager.current();
    if (!ws || typeof ws.export !== 'function') {
      bus.emit('toast', 'Nothing to export yet.');
      return;
    }
    store.setState({ status: 'processing', statusMessage: 'Exporting…' });
    try {
      const result = await ws.export(options);
      // A workspace returns no Blob when it declined to export (e.g. nothing to
      // export) — it will have surfaced its own message, so don't download a file
      // or claim success. Just return to a ready state.
      if (!(result instanceof Blob)) {
        store.setState({ status: 'ready', statusMessage: 'Ready' });
        return;
      }
      download(result, options.filename || suggestName(store, options));
      store.setState({ status: 'ready', statusMessage: 'Exported' });
      bus.emit('export:done', { workspaceId: ws.id, options });
    } catch (err) {
      console.error('[export]', err);
      store.setState({ status: 'error', statusMessage: 'Export failed' });
      bus.emit('toast', 'Export failed.');
    }
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function suggestName(store, options) {
    const base = (store.getState().docName || 'document').replace(/\.[^.]+$/, '');
    const ext = options.format || 'pdf';
    return `${base}.${ext}`;
  }

  return { run };
}
