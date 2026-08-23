/**
 * Renderer — the incremental, layered paint pipeline.
 *
 * One `Renderer` drives every page's object/selection overlay. It does not touch
 * the existing page/background canvas (the PDF or raster still paints there); it
 * owns a transparent **overlay canvas** stacked on top of each page, onto which
 * the engine draws objects, markup and selection handles. That keeps this an
 * additive layer over the current UI rather than a rewrite of it.
 *
 * Design goals from the brief, made concrete here:
 *
 *   - **Only changed regions repaint.** Edits report dirty rects; at frame time
 *     the renderer clips to those rects, clears them and redraws just the
 *     objects that intersect. A full repaint happens only on structural change,
 *     mount or when damage becomes too fragmented (see DirtyTracker).
 *   - **One rAF for the whole document.** All pages share a single animation
 *     frame, so N dirty pages cost one scheduling hop, not N.
 *   - **Low memory on huge documents.** Only pages the viewport marks *active*
 *     keep a painted bitmap; scrolled-away pages release their backing store.
 *     The object *data* always lives in the model, so nothing is lost.
 *   - **Layer order is honoured.** Objects paint per the layer stack (content →
 *     annotation → markup), then selection handles on top.
 */

import { LAYERS } from './layers.js';
import { rectsIntersect, unionRect } from './geometry.js';
import { createDirtyTracker } from './dirtyTracker.js';

export function createRenderer({ document, model, layers, selection }) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  /** @type {Map<number, object>} pageIndex → page render target */
  const pages = new Map();
  /** Decoded-image cache shared across pages (keyed by src). */
  const images = new Map();
  /** Transient per-page tool feedback (drag rubber-band, marquee). */
  const previews = new Map();
  let frame = 0;

  // Layer ids that hold paintable document objects, in paint order.
  const contentLayerIds = () =>
    layers
      .ordered()
      .filter((l) => l.visible && l.id !== LAYERS.SELECTION && l.id !== LAYERS.BACKGROUND)
      .map((l) => l.id);

  /* -------------------------- image resolution ------------------------- */
  function resolveImage(src) {
    if (!src) return null;
    let img = images.get(src);
    if (!img) {
      img = new Image();
      img.onload = () => markAllDirty(); // decoded → repaint pages showing it
      img.src = src;
      images.set(src, img);
    }
    return img;
  }
  const drawEnv = { resolveImage, dpr };

  /* ---------------------------- page targets --------------------------- */
  /**
   * Attach an overlay canvas to a page wrapper. Called by the canvas UI as it
   * builds each `.ws-page`, so the engine never owns layout — only its overlay.
   */
  function mountPage(pageIndex, canvas, cssWidth, cssHeight) {
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const ctx = canvas.getContext('2d');
    const target = {
      pageIndex,
      canvas,
      ctx,
      width: cssWidth,
      height: cssHeight,
      tracker: createLocalTracker(),
      active: true,
    };
    pages.set(pageIndex, target);
    target.tracker.markFull();
    schedule();
    return target;
  }

  /** Forget all page targets (called before the canvas rebuilds the stage). */
  function resetPages() {
    pages.clear();
  }

  /**
   * Mark a page active/inactive from the viewport. Inactive pages drop their
   * backing bitmap to save memory; reactivating triggers a full repaint.
   */
  function setPageActive(pageIndex, active) {
    const target = pages.get(pageIndex);
    if (!target || target.active === active) return;
    target.active = active;
    if (!active) {
      // Releasing the backing store frees GPU/CPU memory for off-screen pages.
      target.canvas.width = 0;
      target.canvas.height = 0;
    } else {
      target.canvas.width = Math.round(target.width * dpr);
      target.canvas.height = Math.round(target.height * dpr);
      target.tracker.markFull();
      schedule();
    }
  }

  /* ----------------------------- damage in ----------------------------- */
  function markDirty(pageIndex, rect) {
    const target = pages.get(pageIndex);
    if (!target) return;
    rect ? target.tracker.mark(rect) : target.tracker.markFull();
    schedule();
  }
  function markPageFull(pageIndex) {
    pages.get(pageIndex)?.tracker.markFull();
    schedule();
  }
  function markAllDirty() {
    for (const t of pages.values()) t.tracker.markFull();
    schedule();
  }

  /**
   * Set (or clear) transient tool feedback for a page — a drag rubber-band, a
   * marquee, a snap guide. A preview is `{ bounds, paint(ctx) }` and lives only
   * in the overlay, never in the document, so it costs nothing to undo and is
   * wiped the instant the tool clears it. Only the union of the old and new
   * footprints is repainted.
   * @param {number} pageIndex
   * @param {{bounds:object, paint:(ctx:CanvasRenderingContext2D)=>void}|null} preview
   */
  function setPreview(pageIndex, preview) {
    const prev = previews.get(pageIndex);
    const dirty = unionRect(prev?.bounds || null, preview?.bounds || null);
    if (preview) previews.set(pageIndex, preview);
    else previews.delete(pageIndex);
    if (dirty) markDirty(pageIndex, dirty);
    else markPageFull(pageIndex);
  }

  /* ------------------------------ scheduler ---------------------------- */
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const target of pages.values()) {
        if (target.active && target.tracker.isDirty()) paint(target);
      }
    });
  }

  /* ------------------------------- paint ------------------------------- */
  function paint(target) {
    const { ctx } = target;
    const { full, rects } = target.tracker.flush();
    const clips = full ? [{ x: 0, y: 0, width: target.width, height: target.height }] : rects;
    const layerIds = contentLayerIds();
    const order = document.objects(target.pageIndex);

    for (const clip of clips) {
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.beginPath();
      ctx.rect(clip.x, clip.y, clip.width, clip.height);
      ctx.clip();
      ctx.clearRect(clip.x, clip.y, clip.width, clip.height);

      // Paint objects layer-by-layer; within a layer, document order = z order.
      for (const layerId of layerIds) {
        for (const obj of order) {
          if (obj.layer !== layerId || obj.hidden) continue;
          if (!rectsIntersect(document.indexRect(obj), clip)) continue;
          model.draw(ctx, obj, drawEnv);
        }
      }

      // Selection handles sit above everything, only if this page is selected.
      if (selection.pageIndex === target.pageIndex && !selection.isEmpty()) {
        paintSelection(ctx, target.pageIndex, clip);
      }

      // Transient tool preview (rubber-band / marquee) tops the overlay.
      const preview = previews.get(target.pageIndex);
      if (preview && rectsIntersect(preview.bounds, clip)) preview.paint(ctx);
      ctx.restore();
    }
  }

  /** Draw the selection outline + resize handles for selected objects. */
  function paintSelection(ctx, pageIndex, clip) {
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 1;
    for (const id of selection.list()) {
      const obj = document.getObject(pageIndex, id);
      if (!obj) continue;
      const b = document.indexRect(obj);
      if (!rectsIntersect(b, clip)) continue;
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.width - 1, b.height - 1);
      // Corner handles.
      const hs = 4;
      ctx.fillStyle = '#ffffff';
      for (const [hx, hy] of [
        [b.x, b.y],
        [b.x + b.width, b.y],
        [b.x + b.width, b.y + b.height],
        [b.x, b.y + b.height],
      ]) {
        ctx.fillRect(hx - hs, hy - hs, hs * 2, hs * 2);
        ctx.strokeRect(hx - hs + 0.5, hy - hs + 0.5, hs * 2 - 1, hs * 2 - 1);
      }
    }
  }

  /* -------------------------- event wiring ----------------------------- */
  // Route document mutations to the right page's dirty tracker.
  document.on('*', (event, payload) => {
    if (!payload) return;
    if (event === 'objectAdded' || event === 'objectRemoved' || event === 'objectChanged') {
      markDirty(payload.pageIndex, payload.dirty);
    } else if (event === 'pageChanged') {
      markPageFull(payload.pageIndex);
    } else if (event === 'structureChanged' || event === 'loaded') {
      // The canvas UI rebuilds page elements on structure/load; targets reset then.
    }
  });
  // Repaint the union of old+new selection footprints when selection changes.
  selection.onChange(({ pageIndex, dirty }) => markDirty(pageIndex, dirty));

  return {
    mountPage,
    resetPages,
    setPageActive,
    markDirty,
    markPageFull,
    markAllDirty,
    setPreview,
    resolveImage,
    get dpr() {
      return dpr;
    },
  };
}

/** Each page target owns its own dirty tracker (independent damage regions). */
function createLocalTracker() {
  return createDirtyTracker();
}
