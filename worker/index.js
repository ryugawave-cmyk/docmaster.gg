/**
 * DocMaster — Cloudflare Worker entry.
 *
 * Serves the statically-built site (dist/, via the ASSETS binding) and:
 *   1. injects a fresh per-request CSP nonce into each HTML page,
 *   2. sets the same security headers the Express app used
 *      (strict CSP + COOP/COEP cross-origin isolation for threaded WASM),
 *   3. serves the oversized AI files (/models/*, /wasm/*) from R2 when they are
 *      not present as assets (they exceed Cloudflare's 25 MiB asset limit),
 *   4. reserves /api/ai/* for FUTURE cloud AI (e.g. a Claude proxy). The API
 *      key would live in a Worker secret — never in the client. Stubbed for now.
 *
 * The current AI (OCR, layout model) runs entirely in the browser and needs no
 * server; this Worker only serves files and headers.
 */

/** Build the Content-Security-Policy string for a given nonce (mirrors app.js). */
function csp(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' 'nonce-${nonce}'`,
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/** Headers applied to every response (isolation + hardening). */
function securityHeaders(headers) {
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
}

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

const IMMUTABLE = 'public, max-age=2592000, immutable';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // ----- Health check -----------------------------------------------------
    if (pathname === '/health') {
      return Response.json({ status: 'ok', ts: Date.now() });
    }

    // ----- Future cloud AI --------------------------------------------------
    // When you add a cloud model, implement it here and read the key from
    // env (a Worker secret). Until then, return 501 so nothing pretends to work.
    if (pathname.startsWith('/api/ai/')) {
      return Response.json(
        { error: 'not_implemented', message: 'Cloud AI endpoint is not enabled yet.' },
        { status: 501 }
      );
    }

    // ----- Large AI assets: assets first, then R2 ---------------------------
    // Small files live in dist (assets); the oversized model + wasm live in R2.
    if (pathname.startsWith('/models/') || pathname.startsWith('/wasm/')) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return withAssetHeaders(asset, pathname);

      if (env.MODELS_R2) {
        const key = pathname.replace(/^\//, '');
        const obj = await env.MODELS_R2.get(key);
        if (obj) {
          const headers = new Headers();
          obj.writeHttpMetadata(headers);
          headers.set('Cache-Control', IMMUTABLE);
          setAssetContentType(headers, pathname);
          securityHeaders(headers);
          return new Response(obj.body, { headers });
        }
      }
      return new Response('Not found', { status: 404 });
    }

    // ----- Everything else: static assets -----------------------------------
    const res = await env.ASSETS.fetch(request);
    const contentType = res.headers.get('content-type') || '';

    // HTML: inject a fresh nonce + set the nonce-based CSP.
    if (contentType.includes('text/html')) {
      const nonce = randomNonce();
      let html = await res.text();
      html = html.split('CSP_NONCE_PLACEHOLDER').join(nonce);
      const headers = new Headers(res.headers);
      headers.set('Content-Security-Policy', csp(nonce));
      // Pages carry a per-request nonce, so they must not be cached verbatim.
      headers.set('Cache-Control', 'no-store');
      securityHeaders(headers);
      return new Response(html, { status: res.status, headers });
    }

    // Non-HTML assets: hardening headers, keep whatever cache assets set.
    return withAssetHeaders(res, pathname);
  },
};

function withAssetHeaders(res, pathname) {
  const headers = new Headers(res.headers);
  setAssetContentType(headers, pathname);
  securityHeaders(headers);
  return new Response(res.body, { status: res.status, headers });
}

function setAssetContentType(headers, pathname) {
  if (pathname.endsWith('.onnx')) headers.set('Content-Type', 'application/octet-stream');
  else if (pathname.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
}
