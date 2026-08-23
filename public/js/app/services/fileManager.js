/**
 * File management service.
 *
 * Owns everything about getting a file INTO the app: the native file picker,
 * drag-and-drop, MIME sniffing/routing to the right workspace, and the "recent"
 * list. Workspaces never touch `<input type=file>` themselves — they receive a
 * `File` via their `open(file)` method. This keeps file acquisition in one place
 * and independent of any particular workspace.
 */
const ACCEPT = {
  pdf: 'application/pdf',
  document: 'application/pdf,image/*,.txt,.md,.doc,.docx',
  any: 'application/pdf,image/*',
};

export function createFileManager({ store, bus }) {
  // One reusable hidden input.
  const input = document.createElement('input');
  input.type = 'file';
  input.hidden = true;
  input.multiple = false;
  document.body.appendChild(input);

  let pending = null;
  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    input.value = '';
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(files);
    }
  });

  /**
   * Open the native picker filtered by `kind` ('pdf' | 'document' | 'any').
   * Resolves with the selected File(s) (or []).
   */
  function pick(kind = 'any', { multiple = false } = {}) {
    input.accept = ACCEPT[kind] || ACCEPT.any;
    input.multiple = multiple;
    return new Promise((resolve) => {
      pending = resolve;
      input.click();
    });
  }

  /** Classify a file into the workspace best suited to open it. */
  function classify(file) {
    if (!file) return null;
    if (file.type === 'application/pdf') return 'pdf';
    if (file.type.startsWith('image/')) return 'pdf'; // images render in the PDF/canvas workspace
    return 'document';
  }

  /** Record a file in the recent list (most-recent first, de-duplicated). */
  function remember(file, workspaceId) {
    const entry = {
      name: file.name,
      size: file.size,
      type: file.type,
      workspaceId,
      openedAt: Date.now(),
    };
    store.setState((s) => ({
      recent: [entry, ...s.recent.filter((r) => r.name !== entry.name)].slice(0, 20),
    }));
    bus.emit('recent:change', store.getState().recent);
    return entry;
  }

  /** Wire drag-and-drop onto an element; drops emit `file:dropped`. */
  function enableDropZone(zone, onFiles) {
    ['dragenter', 'dragover'].forEach((t) =>
      zone.addEventListener(t, (e) => {
        e.preventDefault();
        zone.classList.add('is-dragover');
      })
    );
    ['dragleave', 'drop'].forEach((t) =>
      zone.addEventListener(t, (e) => {
        e.preventDefault();
        if (t === 'dragleave' && zone.contains(e.relatedTarget)) return;
        zone.classList.remove('is-dragover');
      })
    );
    zone.addEventListener('drop', (e) => {
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) onFiles(files);
    });
  }

  return { pick, classify, remember, enableDropZone };
}
