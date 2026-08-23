/**
 * PDF viewer canvas — page-stack layout, zoom, pan, scroll and page selection.
 *
 * Ported from the original single-workspace canvas, trimmed to a pure VIEWER:
 * no editing engine, no tool cursors. It builds the `.ws-page` stack the PDF.js
 * layer paints into (`pdf/pdfViewer.js`), owns all interaction (wheel/pinch
 * zoom, space-to-pan, scroll → current page) and reports page selection via the
 * `onSelectPage` callback so the shell's contextual properties panel can react.
 *
 * It talks only to a workspace-LOCAL store (never the shell store), which is why
 * zoom/scroll survive workspace switches: nothing outside this module mutates it.
 */
import { clamp } from '../../../workspace/utils/format.js';
import { keyboard } from '../../core/keyboard.js';

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 5;
const ZOOM_STEP = 1.2;
const SCROLL_PADDING = 40;

/**
 * @param {object} opts
 * @param {{root:HTMLElement,scroll:HTMLElement,stage:HTMLElement,empty:HTMLElement,loading:HTMLElement}} opts.els
 * @param {ReturnType<import('../../../workspace/core/store.js').createStore>} opts.store  workspace-local store
 * @param {ReturnType<import('../../../workspace/pdf/pdfViewer.js').createPdfViewer>} opts.pdf
 * @param {(index:number|null)=>void} opts.onSelectPage
 */
export function createViewerCanvas({ els, store, pdf, onSelectPage }) {
  const { root, scroll, stage, empty, loading } = els;

  let spaceDown = false;
  let panning = null;
  let rafPending = false;
  let wheelTimer = null;
  let selectedPage = null;

  /* ------------------------------ rendering ----------------------------- */
  function render(state) {
    const doc = state.document;
    stage.replaceChildren();
    selectedPage = null;

    if (!doc) {
      empty.hidden = false;
      scroll.setAttribute('aria-hidden', 'true');
      return;
    }
    empty.hidden = true;
    scroll.removeAttribute('aria-hidden');

    doc.pages.forEach((page, index) => {
      const wrap = document.createElement('div');
      wrap.className = 'ws-page';
      wrap.dataset.page = String(index + 1);
      wrap.dataset.pw = String(page.width);
      wrap.dataset.ph = String(page.height);

      const c = document.createElement('canvas');
      c.className = 'ws-page__canvas';
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(page.width * dpr);
      c.height = Math.round(page.height * dpr);
      const g = c.getContext('2d');
      g.scale(dpr, dpr);
      drawPage(g, page);
      wrap.appendChild(c);

      // Placeholder overlay so the PDF.js text layer inserts beneath it (and so
      // a future engine has a mount point) — purely additive, no interaction.
      const overlay = document.createElement('div');
      overlay.className = 'ws-page__overlay';
      wrap.appendChild(overlay);

      const num = document.createElement('span');
      num.className = 'ws-page__num';
      num.textContent = String(index + 1);
      wrap.appendChild(num);

      wrap.addEventListener('click', (e) => onPageClick(e, index));
      stage.appendChild(wrap);
    });

    stage.classList.add('no-anim');
    applyZoom(state.zoom);

    // Hand the rebuilt page stack to the PDF viewer (or release it for non-PDFs).
    pdf.isPdf(doc) ? pdf.refresh() : pdf.reset();

    requestAnimationFrame(() => stage.classList.remove('no-anim'));
  }

  /** Correct a PDF page's laid-out size once its true size is known. */
  function resizePage(index, cssW, cssH) {
    const wrap = pageEl(index);
    if (!wrap) return;
    wrap.dataset.pw = String(cssW);
    wrap.dataset.ph = String(cssH);
    const zoom = store.getState().zoom;
    wrap.style.width = `${cssW * zoom}px`;
    wrap.style.height = `${cssH * zoom}px`;
    const page = store.getState().document?.pages[index];
    if (page) {
      page.width = cssW;
      page.height = cssH;
    }
  }

  function drawPage(g, page) {
    const w = page.width;
    const h = page.height;
    // PDF pages are painted by the PDF.js viewer straight onto this canvas.
    if (page.kind === 'pdf') return;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    if (page.kind === 'image' && page.source) {
      const img = new Image();
      img.onload = () => g.drawImage(img, 0, 0, w, h);
      img.src = page.source;
    }
  }

  /* ------------------------------ selection ----------------------------- */
  function onPageClick(e, index) {
    // A text drag-selection shouldn't count as a page pick.
    if (String(window.getSelection?.() || '').length) return;
    selectPage(index);
  }

  function selectPage(index) {
    selectedPage = index;
    stage.querySelectorAll('.ws-page').forEach((w) =>
      w.classList.toggle('is-selected', Number(w.dataset.page) - 1 === index)
    );
    onSelectPage?.(index);
  }

  function clearSelection() {
    selectedPage = null;
    stage.querySelectorAll('.ws-page.is-selected').forEach((w) => w.classList.remove('is-selected'));
    onSelectPage?.(null);
  }

  /* -------------------------------- zoom -------------------------------- */
  function applyZoom(zoom) {
    stage.querySelectorAll('.ws-page').forEach((wrap) => {
      wrap.style.width = `${Number(wrap.dataset.pw) * zoom}px`;
      wrap.style.height = `${Number(wrap.dataset.ph) * zoom}px`;
    });
    pdf.onZoomChanged();
  }

  const zoomTo = (zoom) => store.setState({ zoom: clamp(zoom, ZOOM_MIN, ZOOM_MAX) });
  const zoomIn = () => zoomTo(store.getState().zoom * ZOOM_STEP);
  const zoomOut = () => zoomTo(store.getState().zoom / ZOOM_STEP);

  function fit() {
    const first = stage.querySelector('.ws-page');
    if (!first) return;
    const available = scroll.clientWidth - SCROLL_PADDING * 2;
    zoomTo(available / Number(first.dataset.pw));
  }
  function fitPage() {
    const first = stage.querySelector('.ws-page');
    if (!first) return;
    const availW = scroll.clientWidth - SCROLL_PADDING * 2;
    const availH = scroll.clientHeight - SCROLL_PADDING * 2;
    zoomTo(Math.min(availW / Number(first.dataset.pw), availH / Number(first.dataset.ph)));
  }

  /* -------------------------- current page track ------------------------ */
  function updateCurrentPage() {
    const pages = stage.children;
    if (!pages.length) return;
    const rect = scroll.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    let best = 1;
    let bestDist = Infinity;
    for (let i = 0; i < pages.length; i += 1) {
      const r = pages[i].getBoundingClientRect();
      const dist = Math.abs(r.top + r.height / 2 - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = i + 1;
      }
    }
    if (best !== store.getState().currentPage) store.setState({ currentPage: best });
  }

  /** Scroll so page `index` sits near the top of the viewport. */
  function goToPage(index) {
    const wrap = pageEl(index);
    if (wrap) scroll.scrollTo({ top: wrap.offsetTop - 24, behavior: 'smooth' });
  }

  scroll.addEventListener(
    'scroll',
    () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        updateCurrentPage();
      });
    },
    { passive: true }
  );

  /* -------------------------------- pan --------------------------------- */
  scroll.addEventListener('pointerdown', (e) => {
    if (!spaceDown || e.button !== 0) return;
    panning = { x: e.clientX, y: e.clientY, left: scroll.scrollLeft, top: scroll.scrollTop, id: e.pointerId };
    scroll.setPointerCapture(e.pointerId);
    scroll.classList.add('is-panning');
    e.preventDefault();
  });
  scroll.addEventListener('pointermove', (e) => {
    if (!panning) return;
    scroll.scrollLeft = panning.left - (e.clientX - panning.x);
    scroll.scrollTop = panning.top - (e.clientY - panning.y);
  });
  function endPan() {
    if (!panning) return;
    try {
      scroll.releasePointerCapture(panning.id);
    } catch {
      /* already released */
    }
    panning = null;
    scroll.classList.remove('is-panning');
    updateCursor();
  }
  scroll.addEventListener('pointerup', endPan);
  scroll.addEventListener('pointercancel', endPan);

  /* --------------------------- wheel / pinch ---------------------------- */
  scroll.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return; // trackpad pinch → ctrl+wheel
      e.preventDefault();
      stage.classList.add('no-anim');
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => stage.classList.remove('no-anim'), 180);
      zoomTo(store.getState().zoom * (e.deltaY < 0 ? 1.08 : 0.92));
    },
    { passive: false }
  );

  /* ------------------------------ cursor -------------------------------- */
  function updateCursor() {
    if (panning) return;
    scroll.style.cursor = spaceDown ? 'grab' : 'default';
  }

  // Space-to-pan is a WORKSPACE shortcut: it registers through the central
  // keyboard manager, which suspends it automatically whenever a text editor is
  // active (so Space types a space instead of panning). It is additionally armed
  // only while this workspace is active (see setActive).
  let active = false;
  const unbindKeys = keyboard.register({
    match: (e) => e.code === 'Space',
    onKeyDown: (e) => {
      if (!active || spaceDown) return false;
      spaceDown = true;
      updateCursor();
      // Suppress the page's native space-scroll while panning the viewer.
      if (root.contains(document.activeElement) || document.activeElement === document.body) e.preventDefault();
      return true;
    },
    onKeyUp: () => {
      if (!spaceDown) return;
      spaceDown = false;
      updateCursor();
    },
  });

  /* ---------------------------- store wiring ---------------------------- */
  store.subscribe((state, prev) => {
    if (state.status !== prev.status && loading) {
      loading.hidden = state.status !== 'loading';
      loading.setAttribute('aria-hidden', String(state.status !== 'loading'));
    }
    if (state.document !== prev.document) render(state);
    else if (state.zoom !== prev.zoom) applyZoom(state.zoom);
  });

  // Bind the PDF viewer to this live DOM (page rendering + text layer).
  pdf.attach({ scrollEl: scroll, stageEl: stage, rootEl: root, resizePage });

  render(store.getState());
  updateCursor();

  /* ------------------------------ helpers ------------------------------- */
  function pageEl(index) {
    return stage.querySelector(`.ws-page[data-page="${index + 1}"]`) || null;
  }

  return {
    render,
    applyZoom,
    zoomIn,
    zoomOut,
    zoomTo,
    fit,
    fitPage,
    goToPage,
    selectPage,
    clearSelection,
    getSelectedPage: () => selectedPage,
    setActive: (on) => {
      active = on;
      if (!on) {
        spaceDown = false;
        endPan();
      }
    },
    destroy() {
      unbindKeys();
    },
  };
}
