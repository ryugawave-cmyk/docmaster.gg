import navigate from './navigate.js';
import annotate from './annotate.js';
import pages from './pages.js';
import documentOps from './document.js';

/**
 * The complete, ordered list of workspace tools. Grouped by area for the
 * sidebar. To add a new tool, drop a definition into the relevant group file
 * (or a new one) — no other code needs to change.
 */
export const toolDefinitions = [...navigate, ...annotate, ...pages, ...documentOps];

/** Human labels for sidebar group headers, in display order. */
export const groupLabels = {
  navigate: 'Navigate',
  annotate: 'Annotate',
  pages: 'Pages',
  document: 'Document',
};

/**
 * Register every tool into a registry.
 * @param {ReturnType<import('../core/toolRegistry.js').createToolRegistry>} registry
 */
export function registerTools(registry) {
  registry.registerAll(toolDefinitions);
}
