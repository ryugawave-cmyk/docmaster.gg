import { clamp } from '../utils/format.js';

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 5;
const ZOOM_STEP = 1.2;
const SCROLL_PADDING = 32;

/**
 * Center document canvas: renders pages, handles zoom, panning and multi-page
 * navigation. Rendering is intentionally abstracted (`drawPage`) so a real PDF
 * engine can be dropped in later without touching interaction code.
 *
 * Returns an API used by the toolbar and keyboard shortcuts.
 */
export function initCanvas(ctx) {
  const { store, registry, engine, pdf, el } = ctx;
  const canvas = el.canvas;
  const scroll = el.scroll;
  const stage = el.stage;
  const empty = el.empty;
  const loading = el.loading;

  let spaceDown = false;
  let panning = null;
  let rafPending = false;
  let wheelTimer = null;

  // Tell the engine to defer tool interaction while the canvas owns the gesture
  // (space-drag or hand-tool panning), so the two input paths never collide.
  engine?.setPanGuard(() => spaceDown || !!panning);

  function setLoading(on) {
    if (!loading) return;
    loading.hidden = !on;
    loading.setAttribute('aria-hidden', String(!on));
  }

  /* ---------- rendering ---------- */
  function render(state) {
    const doc = state.document;
    stage.replaceChildren();

    if (!doc) {
      empty.hidden = false;
      scroll.setAttribute('aria-hidden', 'true');
      return;
    }
    empty.hidden = true;
    scroll.removeAttribute('aria-hidden');

    // The engine re-mounts its object overlays as the page stack is rebuilt.
    engine?.renderer.resetPages();

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
      drawPage(g, page, index);
      wrap.appendChild(c);

      // Transparent overlay the engine paints objects/selection/markup onto.
      // Purely additive — the page's own content still renders on `c` above.
      if (engine) {
        const overlay = document.createElement('canvas');
        overlay.className = 'ws-page__overlay';
        wrap.appendChild(overlay);
        engine.renderer.mountPage(index, overlay, page.width, page.height);
      }

      const num = document.createElement('span');
      num.className = 'ws-page__num';
      num.textContent = String(index + 1);
      wrap.appendChild(num);

      stage.appendChild(wrap);
    });

    // Size pages without animating the initial layout.
    stage.classList.add('no-anim');
    applyZoom(state.zoom);

    // Hand the rebuilt page stack to the PDF viewer (or release it for non-PDFs).
    if (pdf) pdf.isPdf(doc) ? pdf.refresh() : pdf.reset();

    requestAnimationFrame(() => {
      stage.classList.remove('no-anim');
      // Recompute which pages the viewport keeps painted (large-doc virtualization).
      engine?.viewport?.update();
    });
  }

  /**
   * Correct a PDF page's laid-out size when its true size differs from the
   * page-1 seed. Keeps the wrapper, the engine model and the annotation overlay
   * in sync so objects stay aligned to the rendered page.
   */
  function resizePage(index, cssW, cssH) {
    const wrap = stage.querySelector(`.ws-page[data-page="${index + 1}"]`);
    if (!wrap) return;
    wrap.dataset.pw = String(cssW);
    wrap.dataset.ph = String(cssH);
    const zoom = store.getState().zoom;
    wrap.style.width = `${cssW * zoom}px`;
    wrap.style.height = `${cssH * zoom}px`;
    const page = engine?.document.page(index);
    if (page) {
      page.width = cssW;
      page.height = cssH;
    }
    const overlay = wrap.querySelector('.ws-page__overlay');
    if (overlay && engine) engine.renderer.mountPage(index, overlay, cssW, cssH);
  }

  function drawPage(g, page) {
    const w = page.width;
    const h = page.height;

    // PDF pages are painted by the PDF viewer straight onto this canvas (the
    // engine BACKGROUND layer); leave it untouched so its bitmap survives.
    if (page.kind === 'pdf') return;

    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);

    if (page.kind === 'image' && page.source) {
      const img = new Image();
      img.onload = () => g.drawImage(img, 0, 0, w, h);
      img.src = page.source;
      return;
    }

    // Blank page — light faux content so the canvas reads as a document.
    const m = 72;
    g.fillStyle = '#eef0f6';
    g.fillRect(m, m, w - m * 2, 26); // title bar
    g.fillStyle = '#f2f4fa';
    let y = m + 60;
    for (let i = 0; i < 16 && y < h - m; i += 1) {
      const lineW = i % 4 === 3 ? (w - m * 2) * 0.55 : w - m * 2;
      g.fillRect(m, y, lineW, 12);
      y += 30;
    }
  }

  /* ---------- zoom ---------- */
  function applyZoom(zoom) {
    stage.querySelectorAll('.ws-page').forEach((wrap) => {
      wrap.style.width = `${Number(wrap.dataset.pw) * zoom}px`;
      wrap.style.height = `${Number(wrap.dataset.ph) * zoom}px`;
    });
    // Re-rasterize visible PDF pages at the new scale (debounced inside).
    pdf?.onZoomChanged();
  }

  function zoomTo(zoom) {
    store.setState({ zoom: clamp(zoom, ZOOM_MIN, ZOOM_MAX) });
  }
  function zoomIn() {
    zoomTo(store.getState().zoom * ZOOM_STEP);
  }
  function zoomOut() {
    zoomTo(store.getState().zoom / ZOOM_STEP);
  }
  function fit() {
    const first = stage.querySelector('.ws-page');
    if (!first) return;
    const available = scroll.clientWidth - SCROLL_PADDING * 2;
    zoomTo(available / Number(first.dataset.pw));
  }
  /** Fit Page: scale so a whole page fits within the viewport (width & height). */
  function fitPage() {
    const first = stage.querySelector('.ws-page');
    if (!first) return;
    const availW = scroll.clientWidth - SCROLL_PADDING * 2;
    const availH = scroll.clientHeight - SCROLL_PADDING * 2;
    zoomTo(Math.min(availW / Number(first.dataset.pw), availH / Number(first.dataset.ph)));
  }

  /* ---------- current page tracking ---------- */
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

  /* ---------- cursor ---------- */
  function updateCursor(toolId) {
    if (panning) return;
    const tool = registry.get(toolId);
    scroll.style.cursor = spaceDown ? 'grab' : tool?.cursor || 'default';
  }

  /* ---------- panning ---------- */
  function canPan() {
    return spaceDown || store.getState().activeToolId === 'hand';
  }

  scroll.addEventListener('pointerdown', (e) => {
    if (!canPan() || e.button !== 0) return;
    panning = {
      x: e.clientX,
      y: e.clientY,
      left: scroll.scrollLeft,
      top: scroll.scrollTop,
      id: e.pointerId,
    };
    scroll.setPointerCapture(e.pointerId);
    scroll.classList.add('is-panning');
    e.preventDefault();
  });

  scroll.addEventListener('pointermove', (e) => {
    if (!panning) return;
    scroll.scrollLeft = panning.left - (e.clientX - panning.x);
    scroll.scrollTop = panning.top - (e.clientY - panning.y);
  });

  function endPan(e) {
    if (!panning) return;
    try {
      scroll.releasePointerCapture(panning.id);
    } catch {
      /* pointer already released */
    }
    panning = null;
    scroll.classList.remove('is-panning');
    updateCursor(store.getState().activeToolId);
  }
  scroll.addEventListener('pointerup', endPan);
  scroll.addEventListener('pointercancel', endPan);

  /* ---------- wheel / pinch zoom ---------- */
  scroll.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return; // trackpad pinch sends ctrl+wheel
      e.preventDefault();
      // Pinch zoom should track the fingers instantly (no transition).
      stage.classList.add('no-anim');
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => stage.classList.remove('no-anim'), 180);
      zoomTo(store.getState().zoom * (e.deltaY < 0 ? 1.08 : 0.92));
    },
    { passive: false }
  );

  /* ---------- space-to-pan ---------- */
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isTyping(e.target) && !spaceDown) {
      spaceDown = true;
      updateCursor(store.getState().activeToolId);
      if (canvas.contains(document.activeElement) || document.activeElement === document.body) {
        e.preventDefault();
      }
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceDown = false;
      updateCursor(store.getState().activeToolId);
    }
  });

  /* ---------- store wiring ---------- */
  store.subscribe((state, prev) => {
    if (state.status !== prev.status) setLoading(state.status === 'loading');
    if (state.document !== prev.document) render(state);
    else if (state.zoom !== prev.zoom) applyZoom(state.zoom);
    if (state.activeToolId !== prev.activeToolId) updateCursor(state.activeToolId);
  });

  // Bind the PDF viewer to the live canvas DOM (page rendering + text layer).
  if (pdf) {
    pdf.attach({ scrollEl: scroll, stageEl: stage, rootEl: el.root, resizePage });
  }

  render(store.getState());
  updateCursor(store.getState().activeToolId);
  setLoading(store.getState().status === 'loading');

  return { render, applyZoom, zoomIn, zoomOut, zoomTo, fit, fitPage };
}

function isTyping(target) {
  if (!target) return false;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true;
  // contentEditable surfaces (e.g. the in-place PDF text-edit boxes) own every
  // key while focused — Space, Backspace, Delete, Enter and Arrows must reach
  // the editor, not workspace shortcuts. isContentEditable is also true for any
  // descendant of an editable region (nested styled spans), so this covers the
  // caret sitting inside a child element too.
  return target.isContentEditable === true;
}
