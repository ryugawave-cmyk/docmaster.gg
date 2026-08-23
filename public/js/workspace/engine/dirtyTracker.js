/**
 * DirtyTracker — accumulates the regions that need repainting.
 *
 * The renderer's promise ("update only changed regions") lives or dies here. As
 * edits happen, each reports a small dirty rect. The tracker collects them and,
 * at paint time, hands back a minimal set of rects to clear+redraw instead of
 * repainting the whole page.
 *
 * Two guards keep this a net win rather than a liability:
 *   - **Coalescing**: rects that overlap or nearly touch are merged, so we never
 *     clip-and-clear the same pixels twice in one frame.
 *   - **Fragmentation cap**: past a rect budget, the bookkeeping and per-rect
 *     clip/clear overhead exceeds a single full clear — so the tracker flips to
 *     "full" and the renderer repaints the page once. This bounds worst-case
 *     cost and memory no matter how scattered the edits are.
 */

import { rectsIntersect, unionRect, roundRectOut } from './geometry.js';

const MAX_RECTS = 12; // beyond this, a full repaint is cheaper than many clips
const MERGE_SLOP = 24; // px; rects closer than this merge (avoids seams)

export function createDirtyTracker() {
  /** @type {object[]} */
  let rects = [];
  let full = false;

  /** Mark a page-space rect dirty. Null/empty rects are ignored. */
  function mark(rect) {
    if (full || !rect || rect.width <= 0 || rect.height <= 0) return;
    const padded = {
      x: rect.x - MERGE_SLOP / 2,
      y: rect.y - MERGE_SLOP / 2,
      width: rect.width + MERGE_SLOP,
      height: rect.height + MERGE_SLOP,
    };
    // Merge into any rect it touches, cascading so chained merges collapse.
    let merged = { ...rect };
    const survivors = [];
    for (const r of rects) {
      if (rectsIntersect(r, padded)) merged = unionRect(merged, r);
      else survivors.push(r);
    }
    survivors.push(merged);
    rects = survivors;
    if (rects.length > MAX_RECTS) markFull();
  }

  /** The whole page is dirty (structure change, first paint, resize). */
  function markFull() {
    full = true;
    rects = [];
  }

  const isDirty = () => full || rects.length > 0;
  const isFull = () => full;

  /** Consume the accumulated damage, returning rounded rects and resetting. */
  function flush() {
    const result = full ? { full: true, rects: [] } : { full: false, rects: rects.map(roundRectOut) };
    rects = [];
    full = false;
    return result;
  }

  return { mark, markFull, isDirty, isFull, flush };
}
