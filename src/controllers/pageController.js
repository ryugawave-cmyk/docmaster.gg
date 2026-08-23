'use strict';

const { getToolsByCategory } = require('../data/tools');

/**
 * Controllers for the marketing / static pages of the site.
 * Each method prepares only the data that differs from the global defaults set
 * in the `locals` middleware (site metadata, the tool catalog, SEO fallbacks).
 */

exports.home = (req, res) => {
  // Title, description and the tool list all come from res.locals defaults.
  res.render('pages/home', {
    metaDescription:
      'Alvion Office is a free, browser-based document toolkit — merge, split, compress, convert, edit and sign PDFs, create and edit documents, and build charts. Everything is processed privately in your browser.',
  });
};

exports.about = (req, res) => {
  res.render('pages/about', {
    pageTitle: 'About',
    metaDescription:
      'Learn about Alvion Office — a browser-based document platform for PDFs, documents and charts, built around privacy and simple document workflows.',
  });
};

exports.pricing = (req, res) => {
  res.render('pages/pricing', {
    pageTitle: 'Pricing',
    metaDescription:
      'Alvion Office is free to use today. See what is included now and what is planned as the platform grows.',
  });
};

exports.contact = (req, res) => {
  res.render('pages/contact', {
    pageTitle: 'Contact',
    metaDescription:
      'Get in touch with the Alvion Office team by email. Send questions, feedback or bug reports and we will get back to you.',
  });
};

exports.toolsIndex = (req, res) => {
  res.render('pages/tools', {
    pageTitle: 'All Tools',
    metaDescription:
      'Browse the complete collection of Alvion Office tools for merging, splitting, converting, editing and signing PDFs, plus document creation and charts.',
    groupedTools: getToolsByCategory(),
  });
};

// ----- Legal & trust pages -------------------------------------------------

exports.privacy = (req, res) => {
  res.render('pages/privacy', {
    pageTitle: 'Privacy Policy',
    metaDescription:
      'How Alvion Office handles your data: browser-based file processing, cookies, analytics, advertising, third-party services and your rights.',
    lastUpdated: LAST_UPDATED,
  });
};

exports.terms = (req, res) => {
  res.render('pages/terms', {
    pageTitle: 'Terms of Service',
    metaDescription:
      'The terms that govern your use of Alvion Office — acceptable use, disclaimers, intellectual property and limitations of liability.',
    lastUpdated: LAST_UPDATED,
  });
};

exports.cookies = (req, res) => {
  res.render('pages/cookies', {
    pageTitle: 'Cookie Policy',
    metaDescription:
      'What cookies and local storage Alvion Office uses, why we use them, and how advertising cookies work when advertising is enabled.',
    lastUpdated: LAST_UPDATED,
  });
};

exports.security = (req, res) => {
  res.render('pages/security', {
    pageTitle: 'Security',
    metaDescription:
      'How Alvion Office protects your documents: in-browser processing with no uploads, HTTPS, a strict content security policy and no third-party trackers by default.',
  });
};

// Single place to bump the "last updated" date shown on the legal pages.
const LAST_UPDATED = 'August 21, 2026';
