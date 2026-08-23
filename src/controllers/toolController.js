'use strict';

const { getToolBySlug, getAllTools, workspaceHref } = require('../data/tools');
const { getToolPage, CLIENT_PRIVACY } = require('../data/toolPages');

/**
 * `/tools/:slug` renders a content-rich, crawlable overview page for a tool:
 * what it does, who it is for, how to use it, supported file types, limitations,
 * a privacy note and an FAQ — plus a clear call to action that opens the tool in
 * the workspace. If a slug is unknown, control falls through to the 404 handler.
 */
exports.show = (req, res, next) => {
  const tool = getToolBySlug(req.params.slug);

  if (!tool) {
    return next(); // Falls through to the 404 handler.
  }

  const content = getToolPage(tool.slug) || {};

  // A few related tools (same category first, then others) for internal linking.
  const related = getAllTools()
    .filter((t) => t.slug !== tool.slug)
    .sort((a, b) => (a.category === tool.category ? -1 : 0) - (b.category === tool.category ? -1 : 0))
    .slice(0, 3);

  res.render('pages/tool', {
    pageTitle: tool.name,
    metaDescription: content.lead || tool.description,
    tool,
    content,
    clientPrivacy: CLIENT_PRIVACY,
    openHref: workspaceHref(tool),
    related,
  });
};
