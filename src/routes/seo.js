'use strict';

const express = require('express');
const config = require('../config');
const { getAllTools } = require('../data/tools');

const router = express.Router();

/**
 * SEO endpoints generated from configuration, so they stay correct in every
 * environment. Only indexable, public pages are listed — the workspace is an
 * application surface (noindex). Per-tool overview pages (`/tools/:slug`) are
 * added automatically from the tool catalog.
 */
const STATIC_PATHS = [
  '/',
  '/tools',
  '/pricing',
  '/about',
  '/contact',
  '/security',
  '/privacy',
  '/cookies',
  '/terms',
];

router.get('/robots.txt', (req, res) => {
  const body = [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${config.site.url}/sitemap.xml`,
    '',
  ].join('\n');

  res.type('text/plain').send(body);
});

router.get('/sitemap.xml', (req, res) => {
  const toolPaths = getAllTools().map((t) => `/tools/${t.slug}`);
  const allPaths = [...STATIC_PATHS, ...toolPaths];

  const urls = allPaths
    .map((p) => `  <url><loc>${config.site.url}${p}</loc></url>`)
    .join('\n');

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls +
    '\n</urlset>\n';

  res.type('application/xml').send(xml);
});

module.exports = router;
