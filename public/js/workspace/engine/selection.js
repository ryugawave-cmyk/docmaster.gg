/**
 * Selection — the set of currently-targeted objects.
 *
 * Selection is deliberately its own small model, separate from the document and
 * from the store, because many systems read it and it changes constantly:
 * the renderer draws handles for it, tools transform it, the properties panel
 * reflects it, keyboard deletes it. It is scoped to a single page (the common
 * case for a paged document) and observable so those systems stay in sync
 * without polling.
 *
 * It holds only ids, not object references, so it can never pin a deleted object
 * in memory; it prunes itself when the document reports a removal.
 *
 * Emits `change` with `{ pageIndex, ids, dirty }`, where `dirty` is the union of
 * the old and new selection footprints — exactly the region whose handles must
 * be repainted.
 */

import { unionRect, inflateRect } from './geometry.js';

/** Extra px around selected bounds so handles/outline are included in redraws. */
const HANDLE_PAD = 10;

export function createSelection({ document }) {
  let pageIndex = 0;
  /** @type {Set<string>} */
  let ids = new Set();
  let primary = null; // the "anchor" object — drives the properties panel
  const listeners = new Set();

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** Union footprint of the current selection (for handle redraws), or null. */
  function bounds(forIds = ids, onPage = pageIndex) {
    let box = null;
    for (const id of forIds) {
      const obj = document.getObject(onPage, id);
      if (obj) box = unionRect(box, document.indexRect(obj));
    }
    return box ? inflateRect(box, HANDLE_PAD) : null;
  }

  function emit(prevIds, prevPage) {
    const dirty = unionRect(bounds(prevIds, prevPage), bounds());
    const payload = { pageIndex, ids: [...ids], primary, dirty };
    listeners.forEach((fn) => fn(payload));
  }

  /* ------------------------------ mutators ----------------------------- */
  function set(nextIds, onPage = pageIndex, anchor = null) {
    const prevIds = ids;
    const prevPage = pageIndex;
    pageIndex = onPage;
    ids = new Set(nextIds);
    primary = anchor ?? (ids.size ? [...ids][ids.size - 1] : null);
    emit(prevIds, prevPage);
  }

  function selectOne(id, onPage = pageIndex) {
    set(id ? [id] : [], onPage, id);
  }

  function add(id, onPage = pageIndex) {
    if (onPage !== pageIndex) return set([id], onPage, id); // cross-page → replace
    const prev = new Set(ids);
    ids.add(id);
    primary = id;
    emit(prev, pageIndex);
  }

  function toggle(id, onPage = pageIndex) {
    if (onPage !== pageIndex) return selectOne(id, onPage);
    const prev = new Set(ids);
    if (ids.has(id)) {
      ids.delete(id);
      if (primary === id) primary = ids.size ? [...ids][ids.size - 1] : null;
    } else {
      ids.add(id);
      primary = id;
    }
    emit(prev, pageIndex);
  }

  function clear() {
    if (!ids.size) return;
    const prev = ids;
    ids = new Set();
    primary = null;
    emit(prev, pageIndex);
  }

  /* ------------------------------ queries ------------------------------ */
  const has = (id) => ids.has(id);
  const isEmpty = () => ids.size === 0;
  const list = () => [...ids];
  const size = () => ids.size;
  const getPrimaryObject = () => (primary ? document.getObject(pageIndex, primary) : null);

  /** Keep the set valid when objects vanish (delete / undo). */
  document.on('objectRemoved', ({ pageIndex: pi, id }) => {
    if (pi === pageIndex && ids.has(id)) {
      const prev = new Set(ids);
      ids.delete(id);
      if (primary === id) primary = ids.size ? [...ids][ids.size - 1] : null;
      emit(prev, pageIndex);
    }
  });
  // A brand-new document invalidates any lingering selection.
  document.on('loaded', () => clear());

  return {
    onChange,
    set,
    selectOne,
    add,
    toggle,
    clear,
    has,
    isEmpty,
    list,
    size,
    bounds,
    getPrimaryObject,
    get pageIndex() {
      return pageIndex;
    },
    get primaryId() {
      return primary;
    },
  };
}
