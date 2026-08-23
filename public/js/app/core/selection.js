/**
 * Selection model — the contract that drives the contextual properties panel.
 *
 * A workspace never talks to the panel directly. Instead it emits a
 * `SelectionDescriptor` on the bus (`selection:change`); the shell looks the
 * descriptor's `kind` up in the property registry and renders the matching
 * controls. This is what lets ONE panel serve every workspace:
 *
 *   Text   → typography controls
 *   Image  → image controls
 *   Page   → page controls
 *   (none) → document properties
 *
 * `kind` is an open string, not an enum, so a workspace can introduce new
 * selection kinds (e.g. `shape`, `annotation`) just by registering a provider.
 */

/** Well-known selection kinds shared across workspaces. */
export const SelectionKind = Object.freeze({
  NONE: 'none',
  TEXT: 'text',
  IMAGE: 'image',
  PAGE: 'page',
});

/**
 * Build a normalized selection descriptor.
 * @param {string} kind        one of SelectionKind (or a custom kind)
 * @param {object} [detail]
 * @param {string} [detail.label]   human label shown in the panel header
 * @param {object} [detail.target]  the underlying object (page, node, …)
 * @param {object} [detail.values]  current property values for the panel
 */
export function selection(kind, detail = {}) {
  return {
    kind: kind || SelectionKind.NONE,
    label: detail.label || null,
    target: detail.target || null,
    values: detail.values || {},
  };
}

/** The empty selection — resolves to the "document properties" panel. */
export const emptySelection = () => selection(SelectionKind.NONE);
