'use strict';

const config = require('../config');
const { getToolBySlug, getAllTools, workspaceHref, toolPageHref } = require('../data/tools');
const { getToolPage, CLIENT_PRIVACY } = require('../data/toolPages');

/**
 * Build the JSON-LD `@graph` for a tool overview page: SoftwareApplication (so
 * the tool is eligible for rich results and AI answer engines), BreadcrumbList
 * (matches the visible breadcrumb), plus FAQPage and HowTo when the page has that
 * content. Returned as a plain object so the view can JSON.stringify it safely.
 */
function buildToolJsonLd(tool, content) {
  const base = config.site.url;
  const pageUrl = `${base}${toolPageHref(tool)}`;
  const graph = [];

  graph.push({
    '@type': 'SoftwareApplication',
    '@id': `${pageUrl}#app`,
    name: `${tool.name} — ${config.site.name}`,
    url: pageUrl,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web browser (Chrome, Edge, Firefox, Safari)',
    description: content.lead || tool.description,
    browserRequirements: 'Requires a modern web browser with JavaScript enabled.',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    publisher: { '@id': `${base}/#organization` },
    isAccessibleForFree: true,
  });

  graph.push({
    '@type': 'BreadcrumbList',
    '@id': `${pageUrl}#breadcrumb`,
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${base}/` },
      { '@type': 'ListItem', position: 2, name: 'Tools', item: `${base}/tools` },
      { '@type': 'ListItem', position: 3, name: tool.name, item: pageUrl },
    ],
  });

  if (Array.isArray(content.faq) && content.faq.length) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${pageUrl}#faq`,
      mainEntity: content.faq.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })),
    });
  }

  if (Array.isArray(content.howTo) && content.howTo.length) {
    graph.push({
      '@type': 'HowTo',
      '@id': `${pageUrl}#howto`,
      name: `How to use ${tool.name}`,
      step: content.howTo.map((step, i) => ({
        '@type': 'HowToStep',
        position: i + 1,
        text: step,
      })),
    });
  }

  return { '@context': 'https://schema.org', '@graph': graph };
}

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
    jsonLd: buildToolJsonLd(tool, content),
  });
};
