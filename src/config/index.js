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
    name: process.env.SITE_NAME || 'Advance Office Doc',
    tagline: 'Every document tool you need — in one place.',
    description:
      'Advance Office Doc is a free, browser-based document toolkit to merge, split, compress, convert, edit and sign PDFs, create and edit documents, and build charts — all processed privately in your browser.',
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

  // AI Assistant proxy (LOCAL TESTING). The key is read here, server-side only,
  // and is exposed to the rest of the app via this config object — never sent to
  // the browser. The client talks to the same-origin /api/ai/chat route instead.
  // `enabled` is derived: the feature only turns on when a key is present.
  ai: {
    provider: (process.env.AI_PROVIDER || 'gemini').toLowerCase(),
    model: process.env.AI_MODEL || '',
    apiKey: process.env.AI_API_KEY || '',
    get enabled() { return Boolean(this.apiKey); },
  },

  // Auth (Supabase). The browser signs in with Google via Supabase using the
  // PUBLISHABLE (anon) key; the server verifies a user's access token against the
  // same project to identify who is spending credits. The anon key is NOT a secret
  // — it is designed to be public — so a safe default is baked in for local dev.
  // `devUserId`, when set (or on localhost), lets the credit system attribute
  // requests to a stub user so the flow is testable without a live Supabase session.
  auth: {
    supabaseUrl: process.env.SUPABASE_URL || 'https://synosgiafpeidtvjnnkk.supabase.co',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || 'sb_publishable_6s1pPaUCFkp-SxDz790Krw_TpulJekK',
    // Allow an unauthenticated caller to be treated as this stub user (dev/testing).
    // Empty in production; localhost is always allowed to fall back to a dev user.
    devUserId: process.env.DEV_USER_ID || '',
    devUserEmail: process.env.DEV_USER_EMAIL || 'dev@localhost',
  },

  // Admin analytics gate. The usage dashboard at /admin/usage is open on localhost
  // (your own dev box) and requires ?token=…/x-admin-token elsewhere. Reuses the
  // contact admin token unless a dedicated ADMIN_TOKEN is set.
  admin: {
    token: process.env.ADMIN_TOKEN || process.env.CONTACT_ADMIN_TOKEN || '',
  },

  // Contact form backend. Submissions are always stored durably (a local JSONL
  // file in dev; Cloudflare KV in the Worker) and — if an email provider key is
  // set — also forwarded to the owner's inbox.
  //   • WEB3FORMS_KEY  — easiest: a free key from web3forms.com, emails `to`
  //                      directly (no domain/DNS needed). Works local + Worker.
  //   • RESEND_API_KEY — alternative (needs a verified from-domain on Resend).
  // `to` is where messages are delivered/labelled (defaults to the support inbox).
  contact: {
    to: process.env.CONTACT_TO || 'bloodpath9089@gmail.com',
    web3formsKey: process.env.WEB3FORMS_KEY || '',
    resendApiKey: process.env.RESEND_API_KEY || '',
    resendFrom: process.env.RESEND_FROM || 'Advance Office Doc <onboarding@resend.dev>',
    // Token to view the stored-messages inbox from a NON-local machine. On
    // localhost the inbox is open (your own dev box); remotely it needs ?token=.
    adminToken: process.env.CONTACT_ADMIN_TOKEN || '',
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

// Startup safety: DEV_USER_ID enables an UNAUTHENTICATED identity fallback (a stub
// user for local testing). It must never be set in production — refuse to boot if
// it is, so a stray env var can't silently open a credit-bypass hole.
if (config.isProduction && config.auth.devUserId) {
  throw new Error(
    'DEV_USER_ID must not be set in production: it enables an unauthenticated ' +
    'identity fallback for the credit system. Unset DEV_USER_ID before starting.'
  );
}

module.exports = Object.freeze(config);
