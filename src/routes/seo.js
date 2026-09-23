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

// Per-path crawl hints. Homepage + tool pages are the money pages (crawl often,
// highest priority); legal pages change rarely and matter less for ranking.
function sitemapHints(path) {
  if (path === '/') return { changefreq: 'weekly', priority: '1.0' };
  if (path === '/tools' || path.startsWith('/tools/')) return { changefreq: 'weekly', priority: '0.9' };
  if (path === '/pricing') return { changefreq: 'monthly', priority: '0.8' };
  if (['/privacy', '/terms', '/cookies', '/security'].includes(path)) return { changefreq: 'yearly', priority: '0.3' };
  return { changefreq: 'monthly', priority: '0.6' };
}

router.get('/sitemap.xml', (req, res) => {
  const toolPaths = getAllTools().map((t) => `/tools/${t.slug}`);
  const allPaths = [...STATIC_PATHS, ...toolPaths];
  // One shared timestamp; good enough for a config-generated sitemap and better
  // than omitting <lastmod> entirely.
  const lastmod = new Date().toISOString().slice(0, 10);

  const urls = allPaths
    .map((p) => {
      const { changefreq, priority } = sitemapHints(p);
      return (
        '  <url>' +
        `<loc>${config.site.url}${p}</loc>` +
        `<lastmod>${lastmod}</lastmod>` +
        `<changefreq>${changefreq}</changefreq>` +
        `<priority>${priority}</priority>` +
        '</url>'
      );
    })
    .join('\n');

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls +
    '\n</urlset>\n';

  res.type('application/xml').send(xml);
});

module.exports = router;
