/**
 * Thumbnail rail (PDF only) — lazy, virtualized page navigator.
 *
 * Ported from the original workspace thumbnails, rebound to the workspace-LOCAL
 * store and the viewer canvas. Thumbnails render on demand as they scroll into
 * the rail (mirroring the main viewer's performance model), so even a 1,000-page
 * document stays cheap. Clicking one navigates the main canvas.
 */
import { el } from '../../../workspace/utils/dom.js';

export function createThumbnailRail({ els, store, pdf, onGoToPage }) {
  const { rail, list, openBtn } = els;
  let observer = null;
  let items = [];
  let open = false;

  const isPdf = () => pdf.isPdf(store.getState().document);

  function toggle(force) {
    open = typeof force === 'boolean' ? force : !open;
    rail.hidden = !open;
    if (openBtn) openBtn.hidden = open || !isPdf();
    if (open) build();
  }

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
        { class: 'ws-thumb', type: 'button', dataset: { page: String(index + 1) }, onclick: () => onGoToPage(index) },
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
          item.rendered = false;
        });
      }
    }
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
