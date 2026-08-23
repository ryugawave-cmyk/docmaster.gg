/**
 * Viewport — page virtualization for very large documents.
 *
 * A 2,000-page document must not paint 2,000 overlays. The viewport watches the
 * scroll container and decides which pages are visible (plus a small overscan
 * band above/below so scrolling never reveals an unpainted page). It tells the
 * renderer to keep only those pages *active*; everything else releases its
 * backing bitmap. Combined with the model's lazy per-page indexing, this keeps
 * both CPU and memory roughly constant as the document grows.
 *
 * It reads geometry straight from the DOM page wrappers the canvas already
 * builds (`.ws-page`), so it needs no parallel layout model and stays in lock-
 * step with what the user actually sees — including at any zoom.
 */

const OVERSCAN_PX = 600; // paint this far beyond the viewport edges

export function createViewport({ scrollEl, stageEl, renderer }) {
  let active = new Set();
  let rafPending = false;

  /** Recompute the visible page set and hand activation to the renderer. */
  function update() {
    const pages = stageEl.children;
    if (!pages.length) return;
    const view = scrollEl.getBoundingClientRect();
    const top = view.top - OVERSCAN_PX;
    const bottom = view.bottom + OVERSCAN_PX;

    const next = new Set();
    for (let i = 0; i < pages.length; i += 1) {
      const r = pages[i].getBoundingClientRect();
      if (r.bottom >= top && r.top <= bottom) next.add(i);
    }

    // Diff against the previous set so we only toggle pages that changed state.
    for (const i of active) if (!next.has(i)) renderer.setPageActive(i, false);
    for (const i of next) if (!active.has(i)) renderer.setPageActive(i, true);
    active = next;
  }

  function onScroll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      update();
    });
  }

  scrollEl.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  return {
    update,
    activePages: () => [...active],
    destroy: () => {
      scrollEl.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    },
  };
}
