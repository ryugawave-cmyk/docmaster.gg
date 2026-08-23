/**
 * ============================================================================
 *  THE WORKSPACE CONTRACT
 * ============================================================================
 *
 * A workspace is the center stage of the app (PDF, Document, or the Home hub).
 * The shell hosts any object that implements this contract; it never imports a
 * concrete workspace, so PDF and Document logic never leak into each other or
 * into the chrome.
 *
 * A workspace factory receives shared services and returns an object shaped:
 *
 *   createXWorkspace({ bus, store, services }) => {
 *     id:      string,                  // unique, e.g. 'pdf'
 *     label:   string,                  // toolbar / status label
 *     icon:    string,                  // icon key
 *
 *     // ---- lifecycle (called by the workspace manager) ----
 *     mount(container): void,           // build DOM once into `container`
 *     activate(): void,                 // becoming visible (state preserved)
 *     deactivate(): void,               // hidden; keep everything in memory
 *     onActivate(payload): void,        // (optional) per-activation intent
 *     destroy(): void,                  // (optional) release resources
 *
 *     // ---- capabilities the shell asks about ----
 *     accepts(file): boolean,           // can it open this file? (routing)
 *     getToolbar(): ToolbarModel,       // workspace-specific toolbar group(s)
 *     getTools(): ToolDefinition[],     // (optional) in-center tool rail
 *
 *     // ---- actions & data ----
 *     handleAction(action, payload): boolean,  // toolbar/nav actions; true=handled
 *     open(file): Promise<void>,        // load a file into the workspace
 *     export(options): Promise<Blob|void>,     // via the export system
 *   }
 *
 * A workspace COMMUNICATES OUTWARD only through the bus + store:
 *   - store.setState(...)              to surface docName/zoom/pages/undo state
 *   - bus.emit('selection:change', d)  to drive the contextual properties panel
 *   - bus.emit('toast', message)       for user feedback
 *
 * ToolbarModel shape (consumed by shell/toolbar.js):
 *   { groups: [ { id, items: [ ToolbarItem ] } ] }
 * ToolbarItem:
 *   { id, type?: 'button'|'toggle'|'separator'|'label',
 *     icon?, label?, action?, tip?, accent?: boolean, active?: boolean }
 *
 * This file exports nothing but the documentation above plus a small helper to
 * assert a workspace looks right during development.
 */

const REQUIRED = ['id', 'mount', 'activate', 'deactivate', 'getToolbar'];

/** Dev-time sanity check that an object implements the contract. */
export function assertWorkspace(ws) {
  const missing = REQUIRED.filter((k) => typeof ws?.[k] === 'undefined');
  if (missing.length) {
    throw new Error(`Workspace "${ws?.id || '?'}" is missing: ${missing.join(', ')}`);
  }
  return ws;
}
