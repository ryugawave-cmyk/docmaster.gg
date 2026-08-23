/**
 * Thumbnail rail (PDF only).
 *
 * A lazy, virtualized page navigator that overlays the left edge of the canvas
 * — it does not alter the workspace grid, so the existing chrome is untouched.
 * Thumbnails render on demand (via the PDF viewer) as they scroll into the rail,
 * mirroring the main viewer's performance model so even a 1,000-page document
 * costs almost nothing until a thumbnail is actually visible.
 *
 * Clicking a thumbnail scrolls the main canvas to that page (fast navigation),
 * and the rail keeps the current page highlighted from the store.
 */

import { el } from '../utils/dom.js';

export function initThumbnails(ctx) {
  const { store, pdf, el: dom } = ctx;
  const root = dom.root;
  const rail = root.querySelector('[data-region="thumbs"]');
  const openBtn = root.querySelector('.ws-thumbs__open');
  const list = root.querySelector('[data-region="thumbs-list"]');
  const scroll = dom.scroll;
  const stage = dom.stage;
  if (!rail || !list) return { toggle() {} };

  let observer = null;
  let items = []; // index → { el, canvas, rendered }
  let open = false;

  /** Show/hide the rail; first open builds the thumbnails for the current PDF. */
  function toggle(force) {
    open = typeof force === 'boolean' ? force : !open;
    rail.hidden = !open;
    if (openBtn) openBtn.hidden = open || !isPdf();
    root.classList.toggle('is-thumbs-open', open);
    if (open) build();
  }

  const isPdf = () => pdf?.isPdf(store.getState().document);

  /** (Re)build the thumbnail list for the active document. */
  function build() {
    teardown();
    const doc = store.getState().document;
    if (!isPdf() || !doc) return;

    observer = new IntersectionObserver(onVisible, { root: rail, rootMargin: '300px' });
    items = doc.pages.map((_, index) => {
      const canvas = el('canvas', { class: 'ws-thumb__canvas' });
      const label = el('span', { class: 'ws-thumb__num' }, String(index + 1));
      const node = el(
        'button',
        {
          class: 'ws-thumb',
          type: 'button',
          dataset: { page: String(index + 1) },
          onclick: () => goToPage(index),
        },
        [canvas, label]
      );
      list.appendChild(node);
      observer.observe(node);
      return { el: node, canvas, rendered: false };
    });
    highlight(store.getState().currentPage);
  }

  function onVisible(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const index = Number(entry.target.dataset.page) - 1;
      const item = items[index];
      if (item && !item.rendered) {
        item.rendered = true;
        pdf.renderThumbnail(index, item.canvas, 148).catch(() => {
          item.rendered = false; // allow a retry if it failed mid-flight
        });
      }
    }
  }

  /** Scroll the main canvas so the target page is at the top of the viewport. */
  function goToPage(index) {
    const wrap = stage.querySelector(`.ws-page[data-page="${index + 1}"]`);
    if (wrap) scroll.scrollTo({ top: wrap.offsetTop - 24, behavior: 'smooth' });
  }

  function highlight(pageNo) {
    items.forEach((item, i) => item.el.classList.toggle('is-current', i === pageNo - 1));
    const current = items[pageNo - 1];
    if (open && current) current.el.scrollIntoView({ block: 'nearest' });
  }

  function teardown() {
    observer?.disconnect();
    observer = null;
    list.replaceChildren();
    items = [];
  }

  // React to document + current-page changes.
  store.subscribe((state, prev) => {
    if (state.document !== prev.document) {
      const pdfNow = isPdf();
      if (openBtn) openBtn.hidden = !pdfNow || open;
      if (!pdfNow) toggle(false);
      else if (open) build();
    }
    if (state.currentPage !== prev.currentPage) highlight(state.currentPage);
  });

  return { toggle };
}
