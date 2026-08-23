/**
 * Workspace manager — owns which workspace is active in the center stage.
 *
 * Switching workspaces NEVER reloads the app. Each workspace mounts its DOM
 * once into its own layer inside the stage and is then just shown/hidden, so
 * its state (open file, zoom, scroll, selection) survives switches untouched.
 *
 * The manager is deliberately dumb about what a workspace *is* — it only knows
 * the lifecycle contract (mount/activate/deactivate) and broadcasts changes on
 * the bus. PDF- and Document-specific behaviour lives entirely in the
 * workspaces themselves.
 */
export function createWorkspaceManager({ registry, store, bus, stageEl }) {
  /** id -> the per-workspace layer element we mounted it into. */
  const layers = new Map();
  let activeId = null;

  function ensureMounted(ws) {
    if (layers.has(ws.id)) return layers.get(ws.id);
    const layer = document.createElement('div');
    layer.className = 'app-wslayer';
    layer.dataset.workspace = ws.id;
    layer.hidden = true;
    stageEl.appendChild(layer);
    ws.mount(layer);
    layers.set(ws.id, layer);
    return layer;
  }

  /**
   * Make `id` the active workspace. Returns the workspace, or null if unknown.
   * @param {string} id
   * @param {object} [payload] forwarded to the workspace's `onActivate`
   */
  function activate(id, payload) {
    const ws = registry.get(id);
    if (!ws) return null;
    if (activeId === id) {
      ws.onActivate?.(payload);
      bus.emit('workspace:change', { id, workspace: ws, reactivated: true });
      return ws;
    }

    const current = activeId && registry.get(activeId);
    if (current) {
      current.deactivate?.();
      const layer = layers.get(current.id);
      if (layer) layer.hidden = true;
    }

    const layer = ensureMounted(ws);
    layer.hidden = false;
    activeId = id;

    store.setState({ activeWorkspaceId: id });
    ws.activate?.();
    ws.onActivate?.(payload);
    bus.emit('workspace:change', { id, workspace: ws, reactivated: false });
    return ws;
  }

  const current = () => (activeId ? registry.get(activeId) : null);

  return { activate, current, get: registry.get, ensureMounted };
}
