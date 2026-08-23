/**
 * EngineDocument — the live, indexed view over a plain document.
 *
 * The workspace store already holds a plain, serialisable document (pages, each
 * with an `objects` array). That plain shape stays the source of truth for
 * save/export/undo. EngineDocument wraps it and adds the machinery interactive
 * editing needs:
 *
 *   - fast id lookup per page (Map)
 *   - a per-page spatial index for hit testing / marquee / dirty redraws
 *   - mutation *primitives* (add/remove/update/reorder objects, page ops) that
 *     keep the array, the lookup and the index in sync
 *   - change events carrying the **dirty page-space rect** so the renderer can
 *     repaint only what moved, and selection/tools can react
 *
 * Commands (undo/redo) are built on these primitives; nothing else mutates the
 * document. That single choke-point is what keeps history, rendering and the
 * spatial index from ever drifting out of sync.
 *
 * Indexes are built **lazily per page** and only for pages that are touched, so
 * opening a 5,000-page document costs almost nothing until you actually edit a
 * page.
 */

import { createSpatialIndex } from './spatialIndex.js';
import { rotatedBounds, unionRect } from './geometry.js';
import { recomputeInkBounds } from './objectModel.js';

export function createEngineDocument({ model }) {
  /** @type {object|null} the plain document from the store */
  let doc = null;
  /** Per-page derived state, keyed by page id. Built on demand. */
  const pageState = new Map();
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();

  /* ------------------------------ events ------------------------------- */
  function on(event, fn) {
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }
  function emit(event, payload) {
    listeners.get(event)?.forEach((fn) => fn(payload));
    // '*' subscribers see every event (used by the renderer's damage router).
    listeners.get('*')?.forEach((fn) => fn(event, payload));
  }

  /* ---------------------------- lifecycle ------------------------------ */
  function load(nextDoc) {
    doc = nextDoc;
    pageState.clear();
    emit('loaded', { doc });
  }

  /** The page-space box the spatial index / renderer should track for an object. */
  function indexRect(obj) {
    const b = model.bounds(obj);
    return obj.rotation ? rotatedBounds(b, obj.rotation) : b;
  }

  /** Lazily build (or fetch) the derived state for a page index. */
  function stateFor(pageIndex) {
    const page = doc?.pages[pageIndex];
    if (!page) return null;
    let st = pageState.get(page.id);
    if (!st) {
      st = { page, byId: new Map(), index: createSpatialIndex(), built: false };
      pageState.set(page.id, st);
    }
    if (!st.built) {
      st.byId.clear();
      st.index.clear();
      page.objects = page.objects || [];
      for (const obj of page.objects) {
        st.byId.set(obj.id, obj);
        st.index.insert(obj.id, indexRect(obj));
      }
      st.built = true;
    }
    return st;
  }

  /* ---------------------------- accessors ------------------------------ */
  function pageCount() {
    return doc ? doc.pages.length : 0;
  }
  function page(pageIndex) {
    return doc?.pages[pageIndex] || null;
  }
  function getObject(pageIndex, id) {
    return stateFor(pageIndex)?.byId.get(id) || null;
  }
  /** Objects on a page in paint order (array order === z order within a layer). */
  function objects(pageIndex) {
    return page(pageIndex)?.objects || [];
  }

  /** Broad-phase: ids whose boxes intersect `rect` on a page. */
  function objectsInRect(pageIndex, rect) {
    const st = stateFor(pageIndex);
    return st ? [...st.index.queryRect(rect)].map((id) => st.byId.get(id)) : [];
  }
  function objectsAtPoint(pageIndex, point) {
    const st = stateFor(pageIndex);
    return st ? [...st.index.queryPoint(point)].map((id) => st.byId.get(id)) : [];
  }

  /* -------------------------- object mutations ------------------------- */
  function addObject(pageIndex, obj, at) {
    const st = stateFor(pageIndex);
    if (!st) return null;
    const list = st.page.objects;
    const index = at == null ? list.length : at;
    list.splice(index, 0, obj);
    st.byId.set(obj.id, obj);
    st.index.insert(obj.id, indexRect(obj));
    emit('objectAdded', { pageIndex, id: obj.id, object: obj, dirty: indexRect(obj) });
    return obj;
  }

  function removeObject(pageIndex, id) {
    const st = stateFor(pageIndex);
    if (!st) return null;
    const obj = st.byId.get(id);
    if (!obj) return null;
    const at = st.page.objects.indexOf(obj);
    if (at >= 0) st.page.objects.splice(at, 1);
    st.byId.delete(id);
    st.index.remove(id);
    emit('objectRemoved', { pageIndex, id, object: obj, at, dirty: indexRect(obj) });
    return obj;
  }

  /**
   * Apply a shallow patch to an object. `patch.data` is merged (not replaced) so
   * callers can tweak a single field. Returns the union of the object's old and
   * new footprints as the dirty rect — both must be repainted.
   */
  function updateObject(pageIndex, id, patch) {
    const st = stateFor(pageIndex);
    const obj = st?.byId.get(id);
    if (!obj) return null;
    const before = indexRect(obj);
    if (patch.data) {
      obj.data = { ...obj.data, ...patch.data };
      for (const k of Object.keys(patch)) if (k !== 'data') obj[k] = patch[k];
    } else {
      Object.assign(obj, patch);
    }
    if (obj.type === 'ink' && patch.data?.points) recomputeInkBounds(obj);
    const after = indexRect(obj);
    st.index.update(id, after);
    const dirty = unionRect(before, after);
    emit('objectChanged', { pageIndex, id, object: obj, dirty });
    return obj;
  }

  /** Move an object within its page's paint order (z-ordering). */
  function reorderObject(pageIndex, id, toIndex) {
    const st = stateFor(pageIndex);
    const obj = st?.byId.get(id);
    if (!obj) return null;
    const list = st.page.objects;
    const from = list.indexOf(obj);
    if (from < 0) return null;
    list.splice(from, 1);
    list.splice(Math.max(0, Math.min(toIndex, list.length)), 0, obj);
    emit('objectChanged', { pageIndex, id, object: obj, dirty: indexRect(obj) });
    return from;
  }

  /* --------------------------- page mutations -------------------------- */
  function insertPage(atIndex, pageObj) {
    doc.pages.splice(atIndex, 0, pageObj);
    emit('structureChanged', { kind: 'insertPage', pageIndex: atIndex, page: pageObj });
  }
  function removePage(atIndex) {
    const [removed] = doc.pages.splice(atIndex, 1);
    if (removed) pageState.delete(removed.id);
    emit('structureChanged', { kind: 'removePage', pageIndex: atIndex, page: removed });
    return removed;
  }
  function movePage(from, to) {
    const [p] = doc.pages.splice(from, 1);
    doc.pages.splice(to, 0, p);
    emit('structureChanged', { kind: 'movePage', from, to });
  }
  function rotatePage(atIndex, delta) {
    const p = doc.pages[atIndex];
    if (!p) return;
    p.rotation = (((p.rotation || 0) + delta) % 360 + 360) % 360;
    emit('pageChanged', { pageIndex: atIndex, page: p });
  }

  /** Invalidate a page's derived index (e.g. after a bulk external edit). */
  function invalidatePage(pageIndex) {
    const p = page(pageIndex);
    const st = p && pageState.get(p.id);
    if (st) st.built = false;
  }

  return {
    load,
    on,
    get doc() {
      return doc;
    },
    pageCount,
    page,
    getObject,
    objects,
    objectsInRect,
    objectsAtPoint,
    indexRect,
    addObject,
    removeObject,
    updateObject,
    reorderObject,
    insertPage,
    removePage,
    movePage,
    rotatePage,
    invalidatePage,
  };
}
