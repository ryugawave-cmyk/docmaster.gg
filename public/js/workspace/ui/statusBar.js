import { formatBytes, formatZoom } from '../utils/format.js';

/**
 * Bottom status bar. Reflects document/zoom/processing state. Pure read model:
 * it only ever renders from the store.
 */
export function initStatusBar(ctx) {
  const { root, store } = ctx;

  const bind = (name) => root.querySelector(`[data-bind="${name}"]`);
  const els = {
    status: bind('status'),
    statusDot: bind('statusDot'),
    docType: bind('docType'),
    currentPage: bind('currentPage'),
    totalPages: bind('totalPages'),
    zoom: bind('zoomStatus'),
    fileSize: bind('fileSize'),
  };

  function apply(state) {
    if (els.status) els.status.textContent = state.statusMessage || 'Ready';
    if (els.statusDot) {
      els.statusDot.classList.toggle('is-busy', state.status === 'loading' || state.status === 'processing');
      els.statusDot.classList.toggle('is-error', state.status === 'error');
    }
    if (els.docType) els.docType.textContent = docTypeLabel(state.file);
    if (els.currentPage) els.currentPage.textContent = state.totalPages ? state.currentPage : '–';
    if (els.totalPages) els.totalPages.textContent = state.totalPages || '–';
    if (els.zoom) els.zoom.textContent = formatZoom(state.zoom);
    if (els.fileSize) els.fileSize.textContent = state.file ? formatBytes(state.file.size) : '—';
  }

  store.subscribe((state) => apply(state));
  apply(store.getState());
}

/** Short, friendly label for the current file type. */
function docTypeLabel(file) {
  if (!file) return 'No file';
  const type = file.type || '';
  if (type === 'application/pdf') return 'PDF';
  if (type.startsWith('image/')) {
    const sub = type.split('/')[1] || 'image';
    return (sub === 'jpeg' ? 'jpg' : sub).toUpperCase();
  }
  const ext = (file.name || '').split('.').pop();
  return ext ? ext.toUpperCase() : 'File';
}
