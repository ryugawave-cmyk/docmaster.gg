'use strict';

/**
 * Application shell controller.
 *
 * Renders the single, unified workspace shell that hosts both the PDF and the
 * Document workspaces (plus the Home hub). Switching between them happens
 * entirely on the client without navigating away. An optional `?view=` query
 * (`home` | `recent` | `projects` | `pdf` | `document`) preselects a starting
 * view so links can deep-link into a workspace.
 */
exports.show = (req, res) => {
  const initialView = typeof req.query.view === 'string' ? req.query.view : null;

  res.render('workspace/index', {
    layout: 'layouts/workspace',
    pageTitle: 'Workspace',
    metaDescription:
      'A unified PDF and document workspace — view, edit, organize and export, all in one place.',
    // The workspace is an application surface, not a page to be indexed.
    robots: 'noindex, nofollow',
    initialView,
  });
};
