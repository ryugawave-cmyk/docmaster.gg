/**
 * Left sidebar navigation — the single source of truth for the app rail.
 *
 * Each item declares a `command` (and optional `arg`) that the shell dispatches
 * on the bus as `nav:command`. The command router in `index.js` decides what a
 * command does (switch workspace, open a file dialog, select a tool, …), so the
 * sidebar itself stays purely declarative and knows nothing about PDF- or
 * Document-specific behaviour.
 *
 * `workspace` marks which workspace a section belongs to, so the shell can
 * highlight the section that matches the active workspace.
 */
export const navSections = [
  {
    id: 'app',
    label: null, // top-level, no header
    items: [
      { id: 'home', label: 'Home', icon: 'home', command: 'view', arg: 'home', workspace: 'home' },
      { id: 'recent', label: 'Recent', icon: 'recent', command: 'view', arg: 'recent', workspace: 'home' },
      { id: 'projects', label: 'Projects', icon: 'projects', command: 'view', arg: 'projects', workspace: 'home' },
    ],
  },
  {
    id: 'pdf',
    label: 'PDF',
    workspace: 'pdf',
    items: [
      { id: 'open-pdf', label: 'Open PDF', icon: 'open', command: 'open', arg: 'pdf' },
      { id: 'edit-pdf', label: 'Edit PDF', icon: 'edit', command: 'edit-pdf' },
      { id: 'merge', label: 'Merge', icon: 'merge', command: 'pdf-tool', arg: 'merge' },
      { id: 'split', label: 'Split', icon: 'split', command: 'pdf-tool', arg: 'split' },
      { id: 'compress', label: 'Compress', icon: 'compress', command: 'pdf-tool', arg: 'compress' },
    ],
  },
  {
    id: 'documents',
    label: 'Documents',
    workspace: 'document',
    items: [
      { id: 'new-doc', label: 'New Document', icon: 'new-doc', command: 'new-document' },
      { id: 'open-doc', label: 'Open Document', icon: 'open', command: 'open', arg: 'document' },
      { id: 'templates', label: 'Templates', icon: 'template', command: 'doc-tool', arg: 'templates' },
    ],
  },
];
