/**
 * Canonical DocumentModel — the single in-memory source of truth.
 *
 * Today the app has three overlapping shapes (PDF import descriptors, the editor
 * object model, and the export model). This unifies them: the editor mutates ONE
 * model, and every exporter reads it. A document is pages, each page is a raster
 * backdrop (optional, for imported PDFs) plus z-ordered layer nodes (text, image,
 * table, shape).
 *
 * **Every mutation goes through a Command** (do/undo), giving uniform undo/redo
 * and a single place the keyboard manager and UI dispatch edits. Mutations emit
 * change events so the view/toolbar can react (e.g. enable/disable undo).
 *
 * This module is DOM-free and fully unit-testable in Node. Binary assets (page
 * rasters, image bitmaps) are referenced by id and live in a separate asset
 * store; serialization drops non-serializable handles (see serialize()).
 *
 * @typedef {{x:number,y:number,w:number,h:number}} Box
 * @typedef {{ id:string, type:'text'|'image'|'table'|'shape', box:Box, [k:string]:any }} Node
 * @typedef {{ id:string, size:{w:number,h:number}, rasterRef?:string, layers:Node[] }} Page
 */

let _seq = 0;
export function uid(prefix = 'id') {
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}${_seq.toString(36)}`;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ------------------------------ normalisation ---------------------------- */

export function normalizePage(page = {}) {
  return {
    id: page.id || uid('pg'),
    size: { w: (page.size && page.size.w) || page.w || 794, h: (page.size && page.size.h) || page.h || 1123 },
    rasterRef: page.rasterRef || null,
    layers: Array.isArray(page.layers) ? page.layers.map(normalizeNode) : [],
    // Embedded PDF images recovered at import (logos/signatures/seals/photos) —
    // kept OFF the editable layer stack (they're already in the raster), but
    // carried on the page so exporters/serialization don't lose them.
    images: Array.isArray(page.images) ? page.images.map((im) => ({ ...im })) : [],
  };
}

export function normalizeNode(node = {}) {
  const box = node.box || { x: node.x || 0, y: node.y || 0, w: node.w || 0, h: node.h || 0 };
  const base = { id: node.id || uid('nd'), type: node.type || 'text', box: { ...box } };
  const { id, type, box: _b, x, y, w, h, ...rest } = node; // eslint-disable-line no-unused-vars
  return { ...base, ...rest };
}

/* ------------------------------ command stack ---------------------------- */

class CommandStack {
  constructor(limit = 200) { this.past = []; this.future = []; this.limit = limit; }
  push(cmd) {
    this.past.push(cmd);
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
  }
  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }
  undo(model) { const c = this.past.pop(); if (!c) return null; c.undo(model); this.future.push(c); return c; }
  redo(model) { const c = this.future.pop(); if (!c) return null; c.do(model); this.past.push(c); return c; }
  clear() { this.past.length = 0; this.future.length = 0; }
}

/* ------------------------------- the model ------------------------------- */

export class DocumentModel {
  constructor(init = {}) {
    this.meta = { id: init.id || uid('doc'), title: init.title || 'Untitled', created: init.created || Date.now() };
    this.pages = (init.pages || []).map(normalizePage);
    this.history = new CommandStack();
    this._listeners = new Set();
    // Optional whole-document snapshot source (used when an existing editor
    // delegates its undo/redo here — see useSnapshotSource / recordSnapshot).
    this._getState = null;
    this._setState = null;
    this._onHistoryChange = null;
  }

  /* --- events --- */
  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit(change) { for (const fn of this._listeners) fn(change, this); }

  /* --- lookups --- */
  page(id) { return this.pages.find((p) => p.id === id) || null; }
  pageIndex(id) { return this.pages.findIndex((p) => p.id === id); }
  node(pageId, nodeId) { const p = this.page(pageId); return p ? (p.layers.find((n) => n.id === nodeId) || null) : null; }

  /* --- command runner + history --- */
  _run(cmd) { cmd.do(this); this.history.push(cmd); this._emit({ type: 'do', label: cmd.label }); this._fireHistory(); return cmd.result; }
  undo() { const c = this.history.undo(this); if (c) { this._emit({ type: 'undo', label: c.label }); this._fireHistory(); } return !!c; }
  redo() { const c = this.history.redo(this); if (c) { this._emit({ type: 'redo', label: c.label }); this._fireHistory(); } return !!c; }
  canUndo() { return this.history.canUndo(); }
  canRedo() { return this.history.canRedo(); }
  _fireHistory() { if (this._onHistoryChange) this._onHistoryChange({ canUndo: this.canUndo(), canRedo: this.canRedo() }); }

  /* --- whole-document snapshot history (editor bridge) ---
   * Lets an existing snapshot-based editor delegate its undo/redo to THIS model's
   * `history` (the single source of truth), without a node-by-node rewrite. The
   * editor provides `getState` (serialize its live state) and `setState` (restore
   * it); `recordSnapshot()` is called BEFORE each mutation (like the editor's old
   * pushUndo). Each checkpoint becomes a real Command on `history`, so undo/redo,
   * depth limits and the canUndo/canRedo flags all flow through DocumentModel. */
  useSnapshotSource({ getState, setState, onChange } = {}) {
    this._getState = getState || null;
    this._setState = setState || null;
    this._onHistoryChange = onChange || null;
    return this;
  }

  /** Record a restore point before a mutation. No-op if no source configured. */
  recordSnapshot(label = 'edit') {
    const getState = this._getState; const setState = this._setState;
    if (!getState || !setState) return;
    const pre = getState();
    // Pushed but NOT executed (CommandStack.push does not call do): the mutation
    // is applied by the editor itself right after. `undo` captures the post-state
    // lazily (mirrors the old `future.push(snapshot())`), `do` re-applies it.
    const cmd = {
      label,
      _post: undefined,
      do() { if (this._post !== undefined) setState(this._post); },
      undo() { this._post = getState(); setState(pre); },
    };
    this.history.push(cmd);
    this._fireHistory();
  }

  /** Clear history (e.g. on loading a new document). */
  resetHistory() { this.history.clear(); this._fireHistory(); }

  /** Replace the page structure with a fresh snapshot (a mirror sync from the
   *  live editor — NOT an undoable edit). Keeps `doc.pages` as the canonical,
   *  always-current structural view of the document. */
  setStructure(pages) {
    this.pages = (pages || []).map(normalizePage);
    this._emit({ type: 'structure' });
    return this;
  }

  /* --- page operations --- */
  addPage(page, at) {
    const pg = normalizePage(page);
    const index = at == null ? this.pages.length : clamp(at, 0, this.pages.length);
    return this._run({ label: 'Add page', result: pg,
      do(m) { m.pages.splice(index, 0, pg); },
      undo(m) { m.pages.splice(index, 1); } });
  }

  removePage(pageId) {
    const index = this.pageIndex(pageId);
    if (index < 0) return false;
    const removed = this.pages[index];
    return this._run({ label: 'Remove page', result: true,
      do(m) { m.pages.splice(index, 1); },
      undo(m) { m.pages.splice(index, 0, removed); } });
  }

  movePage(from, to) {
    const n = this.pages.length;
    if (from < 0 || from >= n) return false;
    to = clamp(to, 0, n - 1);
    if (from === to) return false;
    return this._run({ label: 'Reorder page', result: true,
      do(m) { const [p] = m.pages.splice(from, 1); m.pages.splice(to, 0, p); },
      undo(m) { const [p] = m.pages.splice(to, 1); m.pages.splice(from, 0, p); } });
  }

  /* --- node operations --- */
  addNode(pageId, node, at) {
    const p = this.page(pageId); if (!p) return null;
    const nd = normalizeNode(node);
    const index = at == null ? p.layers.length : clamp(at, 0, p.layers.length);
    return this._run({ label: `Add ${nd.type}`, result: nd,
      do(m) { m.page(pageId).layers.splice(index, 0, nd); },
      undo(m) { m.page(pageId).layers.splice(index, 1); } });
  }

  removeNode(pageId, nodeId) {
    const p = this.page(pageId); if (!p) return false;
    const index = p.layers.findIndex((n) => n.id === nodeId);
    if (index < 0) return false;
    const removed = p.layers[index];
    return this._run({ label: `Remove ${removed.type}`, result: true,
      do(m) { m.page(pageId).layers.splice(index, 1); },
      undo(m) { m.page(pageId).layers.splice(index, 0, removed); } });
  }

  /** Shallow-merge `props` into a node. Pass whole nested objects (e.g. a new
   *  `box`), not in-place mutations, so undo can restore the previous values. */
  updateNode(pageId, nodeId, props) {
    const nd = this.node(pageId, nodeId); if (!nd) return false;
    const keys = Object.keys(props);
    const prev = {}; for (const k of keys) prev[k] = nd[k];
    return this._run({ label: `Edit ${nd.type}`, result: true,
      do(m) { Object.assign(m.node(pageId, nodeId), props); },
      undo(m) { Object.assign(m.node(pageId, nodeId), prev); } });
  }

  /** Convenience: move/resize a node (an `updateNode` on its box). */
  moveNode(pageId, nodeId, box) { return this.updateNode(pageId, nodeId, { box: { ...box } }); }

  /** Change a node's z-order within its page. */
  reorderNode(pageId, nodeId, toIndex) {
    const p = this.page(pageId); if (!p) return false;
    const from = p.layers.findIndex((n) => n.id === nodeId);
    if (from < 0) return false;
    const to = clamp(toIndex, 0, p.layers.length - 1);
    if (from === to) return false;
    return this._run({ label: 'Reorder', result: true,
      do(m) { const l = m.page(pageId).layers; const [x] = l.splice(from, 1); l.splice(to, 0, x); },
      undo(m) { const l = m.page(pageId).layers; const [x] = l.splice(to, 1); l.splice(from, 0, x); } });
  }

  /* --- serialization --- */

  /** Plain-JSON snapshot (drops non-serializable handles; assets ride by ref). */
  serialize() {
    return {
      v: 1,
      meta: { ...this.meta },
      pages: this.pages.map((p) => ({
        id: p.id, size: { ...p.size }, rasterRef: p.rasterRef || null,
        layers: p.layers.map((n) => JSON.parse(JSON.stringify(n))),
        images: (p.images || []).map((im) => ({ ...im })),
      })),
    };
  }

  static deserialize(json) {
    const model = new DocumentModel({
      id: json && json.meta ? json.meta.id : undefined,
      title: json && json.meta ? json.meta.title : undefined,
      created: json && json.meta ? json.meta.created : undefined,
      pages: (json && json.pages) || [],
    });
    return model;
  }
}

export function createDocument(init) { return new DocumentModel(init); }
