/**
 * PDF viewer — the isolated PDF.js rendering layer.
 *
 * This is the *only* module that knows PDF.js exists. It turns an uploaded PDF
 * into an engine-compatible document and then paints each page onto that page's
 * existing background canvas (`.ws-page__canvas`) — the engine's BACKGROUND
 * layer — while every annotation/shape/selection stays on the overlay above it.
 * The engine architecture is untouched: the viewer only fills a canvas the
 * canvas UI already created.
 *
 * Performance is the whole point, so rendering is driven by an
 * IntersectionObserver over the real page elements:
 *
 *   - **Virtualized + lazy**: a page renders only when it scrolls into view
 *     (plus an overscan band); off-screen pages never decode.
 *   - **Cancellable**: a page that leaves the viewport mid-render cancels its
 *     PDF.js render task immediately.
 *   - **Cached with cleanup**: only visible/overscan pages keep a painted
 *     bitmap; leaving pages release their canvas backing store and text layer,
 *     bounding memory even on 1,000+ page files.
 *   - **High-DPI**: pages render at `devicePixelRatio`, capped so a single
 *     canvas can never blow past a safe pixel budget.
 *   - **Background**: all decoding happens in the PDF.js worker; the UI thread
 *     only schedules and paints.
 *   - **Re-render on zoom**: visible pages re-rasterize (debounced) at the new
 *     scale so text stays crisp instead of being CSS-upscaled.
 *   - **Selectable text**: a real text layer is built under the annotation
 *     overlay, keeping text copyable and search-ready.
 */

import {
  getDocument,
  TextLayer,
  RenderingCancelledException,
  CSS_UNITS,
  PDF_DOCUMENT_DEFAULTS,
} from './pdfjs.js';
import { createPage } from '../core/documentModel.js';

const OVERSCAN = '800px'; // render this far outside the viewport (lazy band)
const MAX_CONCURRENT = 3; // parallel render jobs (keeps the worker responsive)
const MAX_CANVAS_PIXELS = 12_000_000; // ~48MB backing store cap per page canvas
const ZOOM_DEBOUNCE_MS = 140;

export function createPdfViewer({ store }) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  let pdfDoc = null; // PDFDocumentProxy
  let els = null; // { scrollEl, stageEl, rootEl }
  let hooks = {}; // { resizePage(index, cssW, cssH) } supplied by the canvas UI
  let observer = null;
  let unsubscribe = null;

  const pageProxies = new Map(); // index → Promise<PDFPageProxy>
  const pointSize = new Map(); // index → { w, h } in PDF points (unrotated)
  const userRotation = new Map(); // index → extra rotation degrees (0/90/180/270)
  const rendered = new Map(); // index → { key, renderTask, textTask }
  const visible = new Set(); // indices currently intersecting

  const queue = []; // indices waiting to render
  let inflight = 0;
  let zoomTimer = 0;

  /* ----------------------------- detection ----------------------------- */
  const isPdf = (doc) => doc?.pages?.[0]?.kind === 'pdf';

  /* ------------------------------- loading ----------------------------- */
  /**
   * Parse a PDF file and build an engine document with one `kind: 'pdf'` page
   * per PDF page. Page 1's size seeds the layout instantly; each page's exact
   * size is confirmed lazily when it first renders (so huge files open fast and
   * stay light). Returns `{ doc, fileInfo, message }` for the workspace loader.
   */
  async function load(file) {
    await reset();
    const data = new Uint8Array(await file.arrayBuffer());
    pdfDoc = await getDocument({ data, ...PDF_DOCUMENT_DEFAULTS }).promise;

    const first = await getPageProxy(0);
    const base = cssViewport(first, 0, 1);

    const doc = {
      id: `doc-${Date.now()}`,
      name: file.name,
      size: file.size,
      type: 'application/pdf',
      pages: Array.from({ length: pdfDoc.numPages }, () =>
        createPage({ kind: 'pdf', width: Math.round(base.width), height: Math.round(base.height) })
      ),
    };
    return {
      doc,
      fileInfo: { name: file.name, size: file.size, type: file.type || 'application/pdf' },
      message: `${pdfDoc.numPages} page${pdfDoc.numPages === 1 ? '' : 's'} · rendered with PDF.js`,
    };
  }

  function getPageProxy(index) {
    let p = pageProxies.get(index);
    if (!p) {
      p = pdfDoc.getPage(index + 1).then((page) => {
        const vp = page.getViewport({ scale: 1, rotation: 0 });
        pointSize.set(index, { w: vp.width, h: vp.height });
        return page;
      });
      pageProxies.set(index, p);
    }
    return p;
  }

  /** CSS-pixel viewport (72→96dpi) at a given zoom, honouring page rotation. */
  function cssViewport(page, index, zoom) {
    const rotation = totalRotation(page, index);
    return page.getViewport({ scale: CSS_UNITS * zoom, rotation });
  }

  function totalRotation(page, index) {
    return (((page.rotate || 0) + (userRotation.get(index) || 0)) % 360 + 360) % 360;
  }

  /* ------------------------------ attaching ---------------------------- */
  /** Bind the viewer to the live canvas DOM once (persists across doc loads). */
  function attach({ scrollEl, stageEl, rootEl, resizePage }) {
    els = { scrollEl, stageEl, rootEl };
    hooks = { resizePage };
    // Text is selectable only under the Select tool, so drawing tools can draw
    // over text and the Hand tool can pan across it.
    unsubscribe?.();
    unsubscribe = store.subscribe((state, prev) => {
      if (state.activeToolId !== prev.activeToolId) reflectTextSelectable(state.activeToolId);
    });
    reflectTextSelectable(store.getState().activeToolId);
  }

  function reflectTextSelectable(toolId) {
    els?.rootEl?.classList.toggle('is-text-selectable', toolId === 'selection');
  }

  /**
   * (Re)observe the page elements. The canvas UI calls this after it rebuilds
   * the page stack, so the observer always tracks the current DOM.
   */
  function refresh() {
    if (!els || !pdfDoc) return;
    teardownObserver();
    observer = new IntersectionObserver(onIntersect, { root: els.scrollEl, rootMargin: OVERSCAN });
    for (const wrap of els.stageEl.querySelectorAll('.ws-page')) observer.observe(wrap);
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      const index = Number(entry.target.dataset.page) - 1;
      if (entry.isIntersecting) {
        visible.add(index);
        enqueue(index);
      } else {
        visible.delete(index);
        releasePage(index);
      }
    }
  }

  /* --------------------------- render scheduling ----------------------- */
  function enqueue(index) {
    if (!pdfDoc || visible.has(index) === false) return;
    if (rendered.get(index)?.key === desiredKey(index) && rendered.get(index)?.renderTask == null) return;
    if (!queue.includes(index)) queue.push(index);
    pump();
  }

  function pump() {
    while (inflight < MAX_CONCURRENT && queue.length) {
      const index = queue.shift();
      if (!visible.has(index)) continue; // scrolled away before we got to it
      inflight += 1;
      renderPage(index).finally(() => {
        inflight -= 1;
        pump();
      });
    }
  }

  /** The identity of a page's current desired output (scale + rotation). */
  function desiredKey(index) {
    return `${store.getState().zoom.toFixed(3)}|${userRotation.get(index) || 0}`;
  }

  async function renderPage(index) {
    const wrap = pageEl(index);
    if (!wrap || !visible.has(index)) return;
    const canvas = wrap.querySelector('.ws-page__canvas');
    if (!canvas) return;

    const page = await getPageProxy(index);
    if (!visible.has(index)) return; // left viewport while awaiting the proxy

    const zoom = store.getState().zoom;
    const key = desiredKey(index);
    const rotation = totalRotation(page, index);

    // Correct the page's laid-out size from page 1's seed if this page differs.
    const css = page.getViewport({ scale: CSS_UNITS * zoom, rotation });
    const cssBase = page.getViewport({ scale: CSS_UNITS, rotation });
    syncPageSize(index, wrap, Math.round(cssBase.width), Math.round(cssBase.height));

    // High-DPI raster scale, capped to a safe pixel budget.
    const outScale = cappedScale(index, CSS_UNITS * zoom * dpr, rotation, page);
    const viewport = page.getViewport({ scale: outScale, rotation });

    // Cancel any superseded render of this page.
    rendered.get(index)?.renderTask?.cancel();

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    // Opaque canvas defaults to black; PDFs assume white paper behind content.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const renderTask = page.render({ canvasContext: ctx, viewport });
    const record = { key, renderTask, textTask: null };
    rendered.set(index, record);

    try {
      await renderTask.promise;
    } catch (err) {
      if (err instanceof RenderingCancelledException) return;
      throw err;
    }
    if (record.renderTask === renderTask) record.renderTask = null;

    // Text layer at *display* scale (DOM, unaffected by devicePixelRatio).
    await renderTextLayer(index, wrap, page, css, record);
  }

  async function renderTextLayer(index, wrap, page, cssViewport, record) {
    if (!visible.has(index)) return;
    let layer = wrap.querySelector('.ws-textlayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'ws-textlayer';
      // Sit under the annotation overlay, above the page bitmap.
      const overlay = wrap.querySelector('.ws-page__overlay');
      wrap.insertBefore(layer, overlay || null);
    }
    layer.replaceChildren();
    layer.style.width = `${Math.round(cssViewport.width)}px`;
    layer.style.height = `${Math.round(cssViewport.height)}px`;
    layer.style.setProperty('--scale-factor', String(cssViewport.scale));

    const textLayer = new TextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: true }),
      container: layer,
      viewport: cssViewport,
    });
    record.textTask = textLayer;
    try {
      await textLayer.render();
    } catch {
      /* text layer is best-effort; a failure never blocks page rendering */
    }
  }

  /** Free a page's bitmap + text when it scrolls out of view (memory cleanup). */
  function releasePage(index) {
    const record = rendered.get(index);
    if (record) {
      record.renderTask?.cancel();
      record.textTask?.cancel?.();
      rendered.delete(index);
    }
    const wrap = pageEl(index);
    if (!wrap) return;
    const canvas = wrap.querySelector('.ws-page__canvas');
    if (canvas) {
      canvas.width = 0; // drop the backing store
      canvas.height = 0;
    }
    wrap.querySelector('.ws-textlayer')?.remove();
  }

  /* ------------------------------- zoom -------------------------------- */
  /** Re-render visible pages at the new zoom (debounced so pinch stays smooth). */
  function onZoomChanged() {
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      for (const index of visible) {
        if (rendered.get(index)?.key !== desiredKey(index)) enqueue(index);
      }
    }, ZOOM_DEBOUNCE_MS);
  }

  /* ------------------------------ rotation ----------------------------- */
  /** Rotate a page by ±90°; re-lays-out and re-renders it. */
  function rotatePage(index, dir = 1) {
    const next = (((userRotation.get(index) || 0) + dir * 90) % 360 + 360) % 360;
    userRotation.set(index, next);
    getPageProxy(index).then((page) => {
      const wrap = pageEl(index);
      if (!wrap) return;
      const base = page.getViewport({ scale: CSS_UNITS, rotation: totalRotation(page, index) });
      syncPageSize(index, wrap, Math.round(base.width), Math.round(base.height));
      rendered.delete(index); // force a fresh raster
      if (visible.has(index)) enqueue(index);
    });
  }

  function rotateAll(dir = 1) {
    for (let i = 0; i < (pdfDoc?.numPages || 0); i += 1) rotatePage(i, dir);
  }

  /* ---------------------------- thumbnails ----------------------------- */
  /** Render a small preview of a page into `canvas` (for a thumbnail rail). */
  async function renderThumbnail(index, canvas, maxSize = 150) {
    if (!pdfDoc) return;
    const page = await getPageProxy(index);
    const unit = page.getViewport({ scale: 1, rotation: totalRotation(page, index) });
    const scale = maxSize / Math.max(unit.width, unit.height);
    const viewport = page.getViewport({ scale: scale * dpr, rotation: totalRotation(page, index) });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.round(viewport.width / dpr)}px`;
    canvas.style.height = `${Math.round(viewport.height / dpr)}px`;
    const tctx = canvas.getContext('2d', { alpha: false });
    tctx.fillStyle = '#ffffff';
    tctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: tctx, viewport }).promise;
  }

  /* ------------------------------ helpers ------------------------------ */
  function pageEl(index) {
    return els?.stageEl.querySelector(`.ws-page[data-page="${index + 1}"]`) || null;
  }

  /** Cap the raster scale so a single canvas never exceeds the pixel budget. */
  function cappedScale(index, wanted, rotation, page) {
    const pt = pointSize.get(index) || { w: page.getViewport({ scale: 1 }).width, h: page.getViewport({ scale: 1 }).height };
    const swap = rotation === 90 || rotation === 270;
    const w = swap ? pt.h : pt.w;
    const h = swap ? pt.w : pt.h;
    const area = w * wanted * (h * wanted);
    return area > MAX_CANVAS_PIXELS ? wanted * Math.sqrt(MAX_CANVAS_PIXELS / area) : wanted;
  }

  /** Update the page's laid-out size when its true size differs from the seed. */
  function syncPageSize(index, wrap, cssW, cssH) {
    if (Number(wrap.dataset.pw) === cssW && Number(wrap.dataset.ph) === cssH) return;
    hooks.resizePage?.(index, cssW, cssH);
  }

  /* ------------------------------ teardown ----------------------------- */
  function teardownObserver() {
    observer?.disconnect();
    observer = null;
  }

  /** Tear everything down for a new document (or when leaving a PDF). */
  async function reset() {
    teardownObserver();
    clearTimeout(zoomTimer);
    for (const record of rendered.values()) {
      record.renderTask?.cancel();
      record.textTask?.cancel?.();
    }
    rendered.clear();
    visible.clear();
    queue.length = 0;
    inflight = 0;
    pageProxies.clear();
    pointSize.clear();
    userRotation.clear();
    if (pdfDoc) {
      try {
        await pdfDoc.cleanup();
        await pdfDoc.destroy();
      } catch {
        /* already torn down */
      }
      pdfDoc = null;
    }
  }

  return {
    isPdf,
    load,
    attach,
    refresh,
    onZoomChanged,
    rotatePage,
    rotateAll,
    renderThumbnail,
    reset,
    get numPages() {
      return pdfDoc?.numPages || 0;
    },
  };
}
