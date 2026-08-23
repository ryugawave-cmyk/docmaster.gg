'use strict';

/**
 * Single source of truth for the Alvion Office tool catalog (marketing surface).
 *
 * These entries power the landing-page grid, the tools overview and the footer.
 * Each has a content-rich overview page at `/tools/<slug>` (crawlable, with an
 * "Open in editor" call to action) and maps to a tool inside the Document
 * Workspace via `workspaceTool` (`/workspace?tool=<id>`).
 */

const tools = [
  {
    slug: 'merge-pdf',
    name: 'Merge PDF',
    tagline: 'Combine multiple PDFs into one',
    description:
      'Bring several PDF files together into a single, perfectly ordered document in seconds.',
    icon: 'merge',
    category: 'Organize',
    accent: '#6366f1',
    workspaceTool: 'merge',
  },
  {
    slug: 'split-pdf',
    name: 'Split PDF',
    tagline: 'Separate pages into new files',
    description:
      'Extract pages or split one PDF into multiple documents exactly how you need them.',
    icon: 'split',
    category: 'Organize',
    accent: '#8b5cf6',
    workspaceTool: 'split',
  },
  {
    slug: 'compress-pdf',
    name: 'Compress PDF',
    tagline: 'Reduce file size, keep quality',
    description:
      'Shrink large PDFs for easy sharing while preserving crisp, readable quality.',
    icon: 'compress',
    category: 'Optimize',
    accent: '#ec4899',
    workspaceTool: 'compress',
  },
  {
    slug: 'edit-pdf',
    name: 'Edit PDF',
    tagline: 'Add text, images and shapes',
    description:
      'Annotate and modify your PDFs directly in the browser — text, highlights, images and more.',
    icon: 'edit',
    category: 'Edit',
    accent: '#f59e0b',
    workspaceTool: 'text',
  },
  {
    slug: 'organize-pdf',
    name: 'Organize PDF',
    tagline: 'Reorder, rotate and delete pages',
    description:
      'Drag, drop, rotate and remove pages to arrange your document exactly the way you want.',
    icon: 'organize',
    category: 'Organize',
    accent: '#10b981',
    workspaceTool: 'reorder-pages',
  },
  {
    slug: 'convert-pdf',
    name: 'Convert PDF',
    tagline: 'To and from Word, Excel, images',
    description:
      'Convert PDFs to and from Word, Excel, PowerPoint, JPG and more with a single click.',
    icon: 'convert',
    category: 'Convert',
    accent: '#06b6d4',
    workspaceTool: null,
  },
  {
    slug: 'sign-pdf',
    name: 'Sign PDF',
    tagline: 'Add legally binding signatures',
    description:
      'Sign documents yourself or request signatures from others — secure and effortless.',
    icon: 'sign',
    category: 'Security',
    accent: '#14b8a6',
    workspaceTool: 'signature',
  },
  {
    slug: 'new-document',
    name: 'New Document',
    tagline: 'Write and format rich documents',
    description:
      'A clean, Google Docs-style editor to create letters, reports and notes with headings, tables, images and page layout.',
    icon: 'edit',
    category: 'Create',
    accent: '#3b82f6',
    workspaceTool: 'document',
    view: 'document',
  },
  {
    slug: 'charts-graphs',
    name: 'Charts & Graphs',
    tagline: 'Insert editable data charts',
    description:
      'Build bar, line, pie and other charts from your own data and drop them straight into a document.',
    icon: 'organize',
    category: 'Create',
    accent: '#0ea5e9',
    workspaceTool: 'document',
    view: 'document',
  },
  {
    slug: 'excel-spreadsheet',
    name: 'Excel & Spreadsheets',
    tagline: 'Convert and export to Excel',
    description:
      'Turn PDF tables and documents into Excel (.xlsx) spreadsheets, and export your work for further analysis.',
    icon: 'convert',
    category: 'Convert',
    accent: '#22c55e',
    badge: 'Beta',
    locked: true,
    workspaceTool: null,
    view: 'document',
  },
  {
    slug: 'ai-document-tools',
    name: 'AI Document Tools',
    tagline: 'On-device document assistance',
    description:
      'Assistive features that run on-device in your browser — no cloud servers, no API keys and no document uploads.',
    icon: 'ai',
    category: 'AI',
    accent: '#a855f7',
    badge: 'Preview',
    locked: true,
    workspaceTool: 'ai',
    view: 'document',
  },
];

/**
 * Build the workspace deep-link for a marketing tool card.
 *
 * The workspace shell honours a `?view=` query (`pdf` | `document` | `home`),
 * so links open straight into the correct editor surface. PDF tools default to
 * the PDF view; everything else can declare its own `view`.
 * @param {object} tool
 * @returns {string}
 */
function workspaceHref(tool) {
  const view = tool && (tool.view || (tool.category !== 'Create' && tool.category !== 'AI' ? 'pdf' : 'document'));
  return view ? `/workspace?view=${view}` : '/workspace';
}

/**
 * URL of the content-rich overview page for a tool.
 * @param {object} tool
 * @returns {string}
 */
function toolPageHref(tool) {
  return `/tools/${tool.slug}`;
}

/**
 * Return the full tool catalog.
 * @returns {Array<object>}
 */
function getAllTools() {
  return tools;
}

/**
 * Find a single tool by its URL slug.
 * @param {string} slug
 * @returns {object|undefined}
 */
function getToolBySlug(slug) {
  return tools.find((tool) => tool.slug === slug);
}

/**
 * Group tools by their category for grouped displays.
 * @returns {Record<string, Array<object>>}
 */
function getToolsByCategory() {
  return tools.reduce((groups, tool) => {
    (groups[tool.category] = groups[tool.category] || []).push(tool);
    return groups;
  }, {});
}

module.exports = {
  getAllTools,
  getToolBySlug,
  getToolsByCategory,
  workspaceHref,
  toolPageHref,
};
