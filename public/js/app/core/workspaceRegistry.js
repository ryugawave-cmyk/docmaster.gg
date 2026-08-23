/**
 * Workspace registry — the set of workspaces the shell knows how to host.
 *
 * A workspace is a self-contained module (its own rendering, engine, tools,
 * selection and export) that conforms to the contract documented in
 * `workspaces/workspaceContract.js`. Registering one makes it reachable by id;
 * the workspace manager handles mounting/activation.
 */
export function createWorkspaceRegistry() {
  const byId = new Map();
  const order = [];

  function register(workspace) {
    if (!workspace || !workspace.id) throw new Error('Workspace must have an id');
    if (byId.has(workspace.id)) throw new Error(`Duplicate workspace id: ${workspace.id}`);
    byId.set(workspace.id, workspace);
    order.push(workspace.id);
    return workspace;
  }

  const get = (id) => byId.get(id);
  const has = (id) => byId.has(id);
  const all = () => order.map((id) => byId.get(id));

  /** First workspace whose `accepts(file)` returns true, if any. */
  function forFile(file) {
    return all().find((ws) => typeof ws.accepts === 'function' && ws.accepts(file)) || null;
  }

  return { register, get, has, all, forFile };
}
