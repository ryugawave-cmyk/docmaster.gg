'use strict';

/**
 * Central application configuration.
 *
 * All environment-driven settings are read once here and exposed as a frozen
 * object so the rest of the app never touches `process.env` directly. This keeps
 * configuration predictable and easy to expand as the SaaS grows.
 */

require('dotenv').config();

const env = process.env.NODE_ENV || 'development';

const config = {
  env,
  isProduction: env === 'production',
  isDevelopment: env === 'development',

  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    host: process.env.HOST || 'localhost',
  },

  site: {
    name: process.env.SITE_NAME || 'Alvion Office',
    tagline: 'Every document tool you need — in one place.',
    description:
      'Alvion Office is a free, browser-based document toolkit to merge, split, compress, convert, edit and sign PDFs, create and edit documents, and build charts — all processed privately in your browser.',
    // Set SITE_URL to the production domain (e.g. https://alvionoffice.com) in
    // the environment. Falls back to localhost for local development.
    url: process.env.SITE_URL || 'http://localhost:3000',
    domain: process.env.SITE_DOMAIN || 'alvionoffice.com',
    locale: 'en_US',
    // Contact / role addresses. Override via env once the domain's mailboxes
    // exist. These are the addresses shown across the site and in legal pages.
    contactEmail: process.env.CONTACT_EMAIL || 'support@alvionoffice.com',
    privacyEmail: process.env.PRIVACY_EMAIL || 'privacy@alvionoffice.com',
    legalEmail: process.env.LEGAL_EMAIL || 'legal@alvionoffice.com',
    // Social handles are intentionally omitted until real profiles exist so the
    // footer/contact page never link to a non-existent account.
    twitter: process.env.TWITTER_HANDLE || '',
    // Social image used for Open Graph / Twitter cards.
    ogImage: '/images/picture-web.jpg',
  },

  // Feature flags.
  features: {
    // Cookie-consent banner. OFF by default because the app currently sets no
    // non-essential cookies (no analytics, no ads) — so a banner isn't required.
    // Set COOKIE_CONSENT=true before enabling AdSense/analytics; the banner,
    // preferences modal and Google Consent Mode wiring all come back on.
    cookieConsent: process.env.COOKIE_CONSENT === 'true',
  },

  // Primary marketing navigation. Driven from config so the header/footer stay
  // in sync and new sections can be added in one place.
  // `match: 'prefix'` marks a link active for any sub-path (e.g. /tools/*).
  navigation: [
    { label: 'Tools', href: '/tools', match: 'prefix' },
    { label: 'Pricing', href: '/pricing' },
    { label: 'About', href: '/about' },
    { label: 'Contact', href: '/contact' },
  ],

  // Footer link groups. Every href here resolves to a real, crawlable page so
  // there are no dead or placeholder links.
  footerLinks: {
    product: [
      { label: 'All tools', href: '/tools' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Open editor', href: '/workspace' },
    ],
    company: [
      { label: 'About', href: '/about' },
      { label: 'Contact', href: '/contact' },
      { label: 'Security', href: '/security' },
    ],
    legal: [
      { label: 'Privacy Policy', href: '/privacy' },
      { label: 'Cookie Policy', href: '/cookies' },
      { label: 'Terms of Service', href: '/terms' },
    ],
  },
};

module.exports = Object.freeze(config);
