import { formatZoom } from '../utils/format.js';

/**
 * Top toolbar. Binds declarative `[data-action]` buttons to `ctx.doAction` and
 * keeps the zoom readout and undo/redo availability in sync with the store.
 */
export function initToolbar(ctx) {
  const { root, store } = ctx;

  // Note: [data-action] clicks are handled by a single delegated listener in
  // the app entry point, so this component only owns the toolbar's read model.
  const zoomEl = root.querySelector('[data-bind="zoom"]');
  const undoBtn = root.querySelector('[data-action="undo"]');
  const redoBtn = root.querySelector('[data-action="redo"]');

  function apply(state) {
    if (zoomEl) zoomEl.textContent = formatZoom(state.zoom);
    if (undoBtn) undoBtn.disabled = !state.canUndo;
    if (redoBtn) redoBtn.disabled = !state.canRedo;
  }

  store.subscribe((state, prev) => {
    if (
      state.zoom !== prev.zoom ||
      state.canUndo !== prev.canUndo ||
      state.canRedo !== prev.canRedo
    ) {
      apply(state);
    }
  });
  apply(store.getState());
}
