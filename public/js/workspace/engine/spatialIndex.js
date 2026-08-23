/**
 * Uniform-grid spatial index for one page.
 *
 * Hit testing, marquee selection and dirty-region redraws all need to answer
 * "which objects touch this rect/point?" fast. Scanning every object is fine for
 * ten annotations but not for a page with thousands (dense forms, OCR word
 * boxes, heavy markup). A uniform grid buckets objects into fixed cells so those
 * queries touch only the handful of objects near the query — the difference
 * between O(n) and roughly O(1) per query on large pages.
 *
 * A grid (not a quadtree) is deliberate: document objects are small relative to
 * the page and fairly evenly spread, insert/remove are O(1) amortised, and there
 * is no rebalancing — which keeps churn cheap while the user drags things around.
 *
 * The index stores only ids and boxes (a few numbers per object), never the
 * objects themselves, so its memory cost stays low even on huge pages.
 */

import { rectsIntersect, rectContainsPoint } from './geometry.js';

const DEFAULT_CELL = 256; // page px; ~a few cells across an A4 page

export function createSpatialIndex({ cellSize = DEFAULT_CELL } = {}) {
  /** @type {Map<number, Set<string>>} cellKey → ids */
  const cells = new Map();
  /** @type {Map<string, {rect:object, keys:number[]}>} id → its box + occupied cells */
  const entries = new Map();

  const col = (v) => Math.floor(v / cellSize);
  const key = (cx, cy) => cx * 100000 + cy; // pack (col,row) into one number

  function cellKeysFor(r) {
    const keys = [];
    const c0 = col(r.x);
    const r0 = col(r.y);
    const c1 = col(r.x + r.width);
    const r1 = col(r.y + r.height);
    for (let cx = c0; cx <= c1; cx += 1) {
      for (let cy = r0; cy <= r1; cy += 1) keys.push(key(cx, cy));
    }
    return keys;
  }

  function insert(id, rect) {
    if (entries.has(id)) remove(id);
    const keys = cellKeysFor(rect);
    for (const k of keys) {
      let set = cells.get(k);
      if (!set) cells.set(k, (set = new Set()));
      set.add(id);
    }
    entries.set(id, { rect, keys });
  }

  function remove(id) {
    const entry = entries.get(id);
    if (!entry) return;
    for (const k of entry.keys) {
      const set = cells.get(k);
      if (set) {
        set.delete(id);
        if (!set.size) cells.delete(k);
      }
    }
    entries.delete(id);
  }

  /** Cheap update: only re-bucket when the object crossed a cell boundary. */
  function update(id, rect) {
    const entry = entries.get(id);
    if (!entry) return insert(id, rect);
    const keys = cellKeysFor(rect);
    entry.rect = rect;
    if (sameKeys(keys, entry.keys)) return; // stayed in the same cells — done
    remove(id);
    insert(id, rect);
  }

  /** Candidate ids whose boxes lie in cells overlapping `rect` (broad phase). */
  function queryRect(rect) {
    const found = new Set();
    for (const k of cellKeysFor(rect)) {
      const set = cells.get(k);
      if (!set) continue;
      for (const id of set) {
        // Narrow with the actual box so cell-neighbours don't leak through.
        if (rectsIntersect(entries.get(id).rect, rect)) found.add(id);
      }
    }
    return found;
  }

  /** Candidate ids whose boxes contain `point`. */
  function queryPoint(point) {
    const found = new Set();
    const set = cells.get(key(col(point.x), col(point.y)));
    if (set) {
      for (const id of set) {
        if (rectContainsPoint(entries.get(id).rect, point)) found.add(id);
      }
    }
    return found;
  }

  function has(id) {
    return entries.has(id);
  }

  function clear() {
    cells.clear();
    entries.clear();
  }

  return { insert, remove, update, queryRect, queryPoint, has, clear, get size() { return entries.size; } };
}

function sameKeys(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
