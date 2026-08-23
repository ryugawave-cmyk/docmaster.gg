/**
 * Hit testing — turning a page-space point (or rect) into the object(s) under it.
 *
 * Two-phase, so it stays fast on crowded pages:
 *   1. **Broad phase** — the spatial index returns the few candidates whose
 *      bounding boxes contain the point / touch the rect.
 *   2. **Narrow phase** — each candidate's own `hitTest` (via the object model)
 *      confirms a precise hit: a line only hits near its stroke, an ellipse only
 *      inside its curve, ink only near the path.
 *
 * Results respect **paint order and layers**: the topmost hit wins, matching
 * what the user sees. Layers marked non-hit-testable (selection handles, UI
 * overlays) are skipped, so clicking a handle never "selects the handle".
 */

export function createHitTester({ document, model, layers }) {
  /**
   * Topmost object at `point` on a page, or null. Honours layer order (front to
   * back) and, within a layer, later-painted objects win.
   * @param {number} pageIndex
   * @param {{x:number,y:number}} point
   * @param {{ layerFilter?: (layerId:string)=>boolean }} [opts]
   */
  function objectAt(pageIndex, point, opts = {}) {
    const candidates = document.objectsAtPoint(pageIndex, point);
    if (!candidates.length) return null;

    const hitLayers = layers.hitOrder(); // front-to-back
    const layerRank = new Map(hitLayers.map((l, i) => [l.id, i]));
    const order = document.objects(pageIndex);
    const paintRank = new Map(order.map((o, i) => [o.id, i]));

    let best = null;
    let bestKey = -Infinity;
    for (const obj of candidates) {
      if (obj.hidden || obj.locked) continue;
      const rank = layerRank.get(obj.layer);
      if (rank == null) continue; // layer not hit-testable
      if (opts.layerFilter && !opts.layerFilter(obj.layer)) continue;
      if (!model.hitTest(obj, point)) continue;
      // Sort key: front layers first (lower rank), then later paint order wins.
      const key = -rank * 1e6 + (paintRank.get(obj.id) ?? 0);
      if (key > bestKey) {
        bestKey = key;
        best = obj;
      }
    }
    return best;
  }

  /**
   * All objects touching `rect` on a page (marquee selection).
   * @param {number} pageIndex
   * @param {object} rect  page-space rect
   * @param {{ enclose?: boolean }} [opts]  enclose=true → only fully-contained
   */
  function objectsIn(pageIndex, rect, opts = {}) {
    const hits = document.objectsInRect(pageIndex, rect);
    const out = [];
    for (const obj of hits) {
      if (obj.hidden || obj.locked) continue;
      const layer = layers.get(obj.layer);
      if (!layer || !layer.hitTestable) continue;
      if (opts.enclose) {
        const b = document.indexRect(obj);
        const inside =
          b.x >= rect.x &&
          b.y >= rect.y &&
          b.x + b.width <= rect.x + rect.width &&
          b.y + b.height <= rect.y + rect.height;
        if (!inside) continue;
      }
      out.push(obj);
    }
    return out;
  }

  return { objectAt, objectsIn };
}
