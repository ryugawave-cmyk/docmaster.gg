'use strict';

const path = require('path');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const config = require('./config');
const nonce = require('./middleware/nonce');
const locals = require('./middleware/locals');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const routes = require('./routes');

/**
 * Builds and configures the Express application.
 * Kept separate from `server.js` so the app can be imported for testing
 * without binding to a port.
 */
function createApp() {
  const app = express();

  // Trust the first proxy hop (needed for correct protocol/IP behind proxies).
  app.set('trust proxy', 1);

  // ----- View engine (EJS + layouts) --------------------------------------
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.use(expressLayouts);
  app.set('layout', 'layouts/main');
  app.set('layout extractScripts', true);
  app.set('layout extractStyles', true);

  // ----- Security & performance middleware --------------------------------
  // Generate a CSP nonce per request (must run before Helmet builds the header).
  app.use(nonce);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Strict script policy: only same-origin files and nonce-tagged
          // inline scripts (used for JSON-LD structured data) are allowed.
          // 'wasm-unsafe-eval' lets PDF.js compile its WebAssembly image
          // decoders (JPEG2000/JBIG2) without opening the door to eval().
          //
          // AdSense NOTE: this strict CSP will block Google ad scripts. When you
          // enable AdSense, extend the directives with Google's domains, e.g.:
          //   scriptSrc:  add 'https://pagead2.googlesyndication.com',
          //               'https://adservice.google.com'
          //   frameSrc:   add 'https://googleads.g.doubleclick.net',
          //               'https://tpc.googlesyndication.com'
          //   imgSrc:     add 'https://*.googlesyndication.com',
          //               'https://*.g.doubleclick.net', 'https://*.google.com'
          //   connectSrc: add 'https://pagead2.googlesyndication.com'
          // (Also review COOP/COEP below — ad iframes may need adjustment.)
          // 'https://www.googletagmanager.com' serves the GA4 gtag.js tag
          // (added globally in the page <head> via partials/analytics.ejs).
          scriptSrc: [
            "'self'",
            "'wasm-unsafe-eval'",
            'https://www.googletagmanager.com',
            (req, res) => `'nonce-${res.locals.nonce}'`,
          ],
          // PDF.js renders off the main thread in a module Web Worker served
          // locally from /vendor/pdfjs; allow same-origin (and blob: fallback).
          workerSrc: ["'self'", 'blob:'],
          // Inline style attributes carry a single dynamic accent custom
          // property per tool; 'unsafe-inline' for styles is a low XSS risk.
          // Fonts are self-hosted (/css/fonts.css) — no cross-origin CDN — so the
          // app can run cross-origin-isolated (see COOP/COEP below).
          styleSrc: ["'self'", "'unsafe-inline'"],
          fontSrc: ["'self'"],
          // blob: is needed for previewing user-selected images in the workspace.
          // GA4 sends measurement pixels/beacons to Google Analytics domains.
          imgSrc: [
            "'self'",
            'data:',
            'blob:',
            'https://www.googletagmanager.com',
            'https://www.google-analytics.com',
            'https://*.google-analytics.com',
          ],
          // GA4 posts events to the Analytics collect endpoints (incl. regional
          // *.google-analytics.com / *.analytics.google.com hosts).
          connectSrc: [
            "'self'",
            'https://www.googletagmanager.com',
            'https://www.google-analytics.com',
            'https://*.google-analytics.com',
            'https://*.analytics.google.com',
          ],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
        },
      },
      // Cross-origin isolation. Required for SharedArrayBuffer → multi-threaded
      // WebAssembly (ONNX Runtime Web, image kernels). COOP:same-origin isolates
      // the browsing context group; COEP:credentialless is the lighter embedder
      // policy (allows no-cors subresources without a CORP header, unlike
      // require-corp) — safe here because every subresource is same-origin.
      // The client still degrades gracefully: not isolated ⇒ single-thread WASM.
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginEmbedderPolicy: { policy: 'credentialless' },
    })
  );
  app.use(compression());

  // ----- Request logging ---------------------------------------------------
  app.use(morgan(config.isProduction ? 'combined' : 'dev'));

  // ----- Body parsing ------------------------------------------------------
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // ----- Model & WASM assets ----------------------------------------------
  // ONNX models and WebAssembly modules (ONNX Runtime Web, image kernels).
  // Served same-origin with a long, immutable cache and correct MIME; range
  // requests are enabled by default (ORT streams large models). Mounted BEFORE
  // the general static mount so these headers take precedence. The dirs are
  // populated in later phases (models/, wasm/).
  const assetStatic = (dir) =>
    express.static(path.join(__dirname, '..', 'public', dir), {
      maxAge: config.isProduction ? '30d' : 0,
      immutable: config.isProduction,
      etag: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.onnx')) res.setHeader('Content-Type', 'application/octet-stream');
        if (filePath.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
      },
    });
  app.use('/models', assetStatic('models'));
  app.use('/wasm', assetStatic('wasm'));
  // On-device OCR engine (self-hosted Tesseract.js v5 — see core/ai/ocrTesseract.js
  // and scripts/vendor-ocr.mjs). Mounted here so its core .wasm gets the correct
  // application/wasm MIME (streaming compile) instead of the generic static type.
  app.use('/vendor/tesseract', assetStatic('vendor/tesseract'));

  // ----- Static assets -----------------------------------------------------
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      maxAge: config.isProduction ? '7d' : 0,
      etag: true,
    })
  );

  // PDF.js is a local dependency (never a CDN): serve its distribution — the
  // ES-module build, worker, cMaps and standard fonts — from node_modules under
  // a stable, same-origin path so it satisfies the strict CSP.
  app.use(
    '/vendor/pdfjs',
    express.static(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist'), {
      maxAge: config.isProduction ? '30d' : 0,
      immutable: config.isProduction,
      etag: true,
    })
  );

  // ----- Global view locals -----------------------------------------------
  app.use(locals);

  // ----- Application routes ------------------------------------------------
  app.use('/', routes);

  // Lightweight health check for uptime monitoring / load balancers.
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), env: config.env });
  });

  // ----- Error handling ----------------------------------------------------
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
