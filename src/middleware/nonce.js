'use strict';

const crypto = require('crypto');

/**
 * Generates a unique per-request CSP nonce.
 *
 * Exposed on `res.locals.nonce` so templates can mark trusted inline scripts
 * (e.g. JSON-LD structured data) and Helmet's Content-Security-Policy can allow
 * exactly those — keeping `script-src` strict without resorting to
 * `'unsafe-inline'`. Must run before Helmet so the value is available when the
 * CSP header is built.
 */
module.exports = function nonce(req, res, next) {
  // During the static build (scripts/build-static.js) emit a fixed placeholder
  // so the Worker can substitute a fresh per-request nonce at the edge. At
  // runtime this branch is never taken, so live behaviour is unchanged.
  res.locals.nonce =
    process.env.STATIC_BUILD === '1' ? 'CSP_NONCE_PLACEHOLDER' : crypto.randomBytes(16).toString('base64');
  next();
};
