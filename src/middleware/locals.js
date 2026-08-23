'use strict';

const config = require('../config');
const { getAllTools, workspaceHref, toolPageHref } = require('../data/tools');

/**
 * Injects globally-available view data into `res.locals` for every request.
 *
 * Anything set here is accessible in all EJS templates (site metadata, the tool
 * catalog for navigation, the current path for active-link highlighting, etc.)
 * without each controller having to pass it explicitly.
 */
module.exports = function locals(req, res, next) {
  res.locals.site = config.site;
  res.locals.features = config.features;
  res.locals.navigation = config.navigation;
  res.locals.footerLinks = config.footerLinks;
  res.locals.tools = getAllTools();
  res.locals.workspaceHref = workspaceHref;
  res.locals.toolPageHref = toolPageHref;
  res.locals.currentPath = req.path;
  res.locals.currentYear = new Date().getFullYear();

  // Sensible per-page SEO defaults; individual pages can override these.
  res.locals.pageTitle = null;
  res.locals.metaDescription = config.site.description;
  // Canonical URL intentionally uses the path only (no query string) so
  // filtered/tracked variants of a page don't fragment its SEO signals.
  res.locals.canonicalUrl = config.site.url + req.path;

  next();
};
