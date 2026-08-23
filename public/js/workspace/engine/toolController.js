/**
 * ToolController — the bridge between raw pointer input and engine edits.
 *
 * Tools stay declarative data in the registry. Their *behaviour* on the canvas
 * is registered separately as an interaction handler set, so a tool can gain
 * real editing power without the tool definition growing DOM or event code:
 *
 *   engine.tools.setInteraction('shapes', {
 *     onPointerDown(api) { … }, onPointerMove(api) { … }, onPointerUp(api) { … }
 *   })
 *
 * The controller owns the messy parts every tool would otherwise duplicate:
 *   - mapping a screen pointer to **page-space** coordinates at any zoom,
 *   - figuring out *which page* was hit,
 *   - a drag lifecycle (down → move* → up) with pointer capture,
 *   - handing each handler a rich, ready-to-use interaction API.
 *
 * It never fights the existing canvas: when the hand tool or space-pan is
 * engaged, the controller stands down and lets the canvas pan.
 */

export function createToolController({ store, registry, engine, stageEl, interactions = new Map() }) {
  // `interactions` is passed in and shared so a controller can be re-bound to a
  // new stage element (after the canvas rebuilds) without losing behaviour that
  // plugins registered earlier.
  let drag = null;

  function setInteraction(toolId, handlers) {
    interactions.set(toolId, handlers);
  }
  function getInteraction(toolId) {
    return interactions.get(toolId) || registry.get(toolId)?.interaction || null;
  }

  /** Convert a pointer event over a `.ws-page` into { pageIndex, point }. */
  function locate(event) {
    const wrap = event.target.closest?.('.ws-page');
    if (!wrap || !stageEl.contains(wrap)) return null;
    const pageIndex = Number(wrap.dataset.page) - 1;
    const pageW = Number(wrap.dataset.pw);
    const rect = wrap.getBoundingClientRect();
    const scale = rect.width / pageW; // == current zoom (CSS scale of the wrapper)
    return {
      pageIndex,
      point: { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale },
      scale,
    };
  }

  /**
   * The interaction API handed to every handler — the tool's whole toolkit.
   * `session` is a stable per-gesture object (created on pointerdown) so a tool
   * can stash drag state that survives across down → move → up.
   */
  function makeApi(hit, event, session) {
    const toolId = store.getState().activeToolId;
    return {
      event,
      toolId,
      session,
      pageIndex: hit.pageIndex,
      point: hit.point,
      scale: hit.scale,
      settings: store.getState().toolSettings[toolId] || {},
      // Engine surfaces:
      engine,
      model: engine.objectModel,
      document: engine.document,
      selection: engine.selection,
      commands: engine.commands,
      hitTest: engine.hitTest,
      renderer: engine.renderer,
      stack: engine.stack,
      // Edit helpers:
      execute: (cmd) => engine.stack.execute(cmd),
      transaction: (label, fn) => engine.stack.run(label, fn),
      createObject: (type, props) => engine.objectModel.create(type, props),
    };
  }

  /** Whether the canvas (not a tool) should own this gesture. */
  function panActive() {
    const state = store.getState();
    return state.activeToolId === 'hand' || !!engine.panGuard?.();
  }

  /* ----------------------------- lifecycle ----------------------------- */
  function onPointerDown(event) {
    if (event.button !== 0 || panActive()) return;
    const handlers = getInteraction(store.getState().activeToolId);
    if (!handlers?.onPointerDown) return;
    const hit = locate(event);
    if (!hit) return;
    drag = { pointerId: event.pointerId, handlers, pageIndex: hit.pageIndex, session: {} };
    try {
      stageEl.setPointerCapture(event.pointerId);
    } catch {
      /* capture is best-effort */
    }
    handlers.onPointerDown(makeApi(hit, event, drag.session));
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!drag) return;
    const hit = locate(event) || lastKnownHit(event);
    if (!hit) return;
    drag.handlers.onPointerMove?.(makeApi(hit, event, drag.session));
  }

  function onPointerUp(event) {
    if (!drag) return;
    const hit = locate(event) || lastKnownHit(event);
    const { handlers, session } = drag;
    try {
      stageEl.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
    drag = null;
    if (hit) handlers.onPointerUp?.(makeApi(hit, event, session));
  }

  /**
   * During a drag the pointer can leave the page box; fall back to projecting
   * onto the drag's origin page so moves keep flowing (clamped by the tool).
   */
  function lastKnownHit(event) {
    if (!drag) return null;
    const wrap = stageEl.querySelector(`.ws-page[data-page="${drag.pageIndex + 1}"]`);
    if (!wrap) return null;
    const pageW = Number(wrap.dataset.pw);
    const rect = wrap.getBoundingClientRect();
    const scale = rect.width / pageW;
    return {
      pageIndex: drag.pageIndex,
      point: { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale },
      scale,
    };
  }

  function onKeyDown(event) {
    const handlers = getInteraction(store.getState().activeToolId);
    handlers?.onKeyDown?.({ event, engine, selection: engine.selection, stack: engine.stack });
  }

  // Bind pointer input only when attached to a real stage. Before the canvas
  // exists the controller still accepts interaction registrations (shared map).
  if (stageEl) {
    stageEl.addEventListener('pointerdown', onPointerDown);
    stageEl.addEventListener('pointermove', onPointerMove);
    stageEl.addEventListener('pointerup', onPointerUp);
    stageEl.addEventListener('pointercancel', onPointerUp);
  }

  return {
    setInteraction,
    getInteraction,
    onKeyDown,
    interactions,
    hasInteraction: (toolId) => !!getInteraction(toolId),
  };
}
