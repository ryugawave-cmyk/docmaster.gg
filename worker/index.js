/**
 * DocMaster — Cloudflare Worker entry.
 *
 * Serves the statically-built site (dist/, via the ASSETS binding) and:
 *   1. injects a fresh per-request CSP nonce into each HTML page,
 *   2. sets the same security headers the Express app used
 *      (strict CSP + COOP/COEP cross-origin isolation for threaded WASM),
 *   3. serves the oversized AI files (/models/*, /wasm/*) from this repo's GitHub
 *      Release when they are not present as assets (they exceed Cloudflare's
 *      25 MiB asset limit) — proxied same-origin and cached at the edge,
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

// The two oversized AI files (the ONNX layout model + the large ORT .wasm) can't
// ship as Cloudflare assets (25 MiB cap), so they're published as assets on this
// repo's GitHub Release — free, no card, no size cap. The Worker proxies them
// same-origin from here (see the /models,/wasm handler). Release assets are flat,
// so a request's final path segment is the asset name. Bump the tag if you cut a
// new Release with updated files.
const RELEASE_BASE =
  'https://github.com/ryugawave-cmyk/docmaster.gg/releases/download/models-v1/';

export default {
  async fetch(request, env, ctx) {
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

    // ----- Large AI assets: assets first, then the GitHub Release -----------
    // Small files live in dist (assets); the oversized model + wasm are pulled
    // from the GitHub Release and served same-origin, cached at the edge so
    // GitHub is only ever hit on a cold cache. Same-origin keeps them clear of
    // connect-src / COEP concerns — the client still just requests /models,/wasm.
    if (pathname.startsWith('/models/') || pathname.startsWith('/wasm/')) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return withAssetHeaders(asset, pathname);

      const cache = caches.default;
      const hit = await cache.match(request);
      if (hit) return hit;

      const filename = pathname.split('/').pop();
      const upstream = await fetch(RELEASE_BASE + filename, { redirect: 'follow' });
      if (!upstream.ok) return new Response('Not found', { status: 404 });

      const headers = new Headers();
      headers.set('Cache-Control', IMMUTABLE);
      setAssetContentType(headers, pathname);
      securityHeaders(headers);
      const res = new Response(upstream.body, { status: 200, headers });
      ctx.waitUntil(cache.put(request, res.clone()));
      return res;
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
