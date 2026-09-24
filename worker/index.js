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

import { PROVIDERS, SYSTEM, AGENT_SYSTEM, extractJson, toActions } from './ai.js';
import * as credits from './credits.js';
import { resolveUser } from './auth.js';
import { handleAdminUsage } from './admin.js';

/** Build the Content-Security-Policy string for a given nonce (mirrors app.js). */
function csp(nonce) {
  return [
    "default-src 'self'",
    // www.googletagmanager.com serves the GA4 gtag.js tag (partials/analytics.ejs).
    `script-src 'self' 'wasm-unsafe-eval' https://www.googletagmanager.com 'nonce-${nonce}'`,
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    // GA4 measurement pixels/beacons go to the Google Analytics domains;
    // lh3.googleusercontent.com serves the signed-in user's Google avatar.
    "img-src 'self' data: blob: https://www.googletagmanager.com https://www.google-analytics.com https://*.google-analytics.com https://lh3.googleusercontent.com",
    // GA4 posts events to the Analytics collect endpoints (incl. regional hosts);
    // the Supabase project host handles Google sign-in (auth) + data API calls.
    "connect-src 'self' https://www.googletagmanager.com https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://synosgiafpeidtvjnnkk.supabase.co",
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
  // The site is HTTPS-only; lock clients to it for a year.
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Deny powerful features the app never uses (Lighthouse best-practice).
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), browsing-topics=()');
}

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

const IMMUTABLE = 'public, max-age=2592000, immutable';
const ONE_YEAR_IMMUTABLE = 'public, max-age=31536000, immutable';

// Decide the Cache-Control for a static asset. Returns null to leave whatever
// the assets binding already set (max-age=0, must-revalidate) — the safe default
// for anything whose URL can't guarantee its content.
function cacheControlFor(pathname, search) {
  // Content-stable binaries: a given filename's bytes never change (font
  // subsets, pinned pdf.js vendor build, media). Safe to cache hard, no ?v=.
  if (
    pathname.startsWith('/fonts/') ||
    pathname.startsWith('/vendor/pdfjs/') ||
    pathname.startsWith('/media/')
  ) {
    return ONE_YEAR_IMMUTABLE;
  }
  // Fingerprinted requests: the build stamps ?v=<buildId> onto CSS/JS/image
  // URLs inside the always-fresh (no-store) HTML, so a new deploy changes the
  // URL. That makes long immutable caching safe — old URLs are simply never
  // requested again. Bare (un-stamped) URLs fall through to revalidate.
  if (/[?&]v=/.test(search) && /\.(css|js|mjs|png|jpe?g|webp|gif|svg|ico)$/.test(pathname)) {
    return ONE_YEAR_IMMUTABLE;
  }
  return null;
}

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

    // ----- Contact form -----------------------------------------------------
    // Stores each submission in KV (viewable in the Cloudflare dashboard) and, if
    // an email provider secret is set, forwards it to the owner's inbox.
    if (pathname === '/api/contact' && request.method === 'POST') {
      return handleContact(request, env, ctx);
    }
    // Read the stored messages from KV (needs ?token=CONTACT_ADMIN_TOKEN).
    if (pathname === '/api/contact/inbox' || pathname === '/api/contact/messages') {
      return handleContactRead(request, env, url);
    }

    // ----- Cloud AI (proxy + credits) --------------------------------------
    // The provider key lives in a Worker secret (env.AI_API_KEY); per-user credits
    // are stored in KV (env.CREDITS_KV). See handleAi + worker/{ai,credits,auth}.js.
    if (pathname.startsWith('/api/ai/')) {
      return handleAi(request, env, pathname);
    }

    // ----- Admin: AI usage & credits dashboard (token-gated) ----------------
    if (pathname === '/admin/usage' || pathname === '/admin/usage.json') {
      return handleAdminUsage(request, env, url);
    }

    // ----- Large AI assets: assets first, then the GitHub Release -----------
    // Small files live in dist (assets); the oversized model + wasm are pulled
    // from the GitHub Release and served same-origin, cached at the edge so
    // GitHub is only ever hit on a cold cache. Same-origin keeps them clear of
    // connect-src / COEP concerns — the client still just requests /models,/wasm.
    if (pathname.startsWith('/models/') || pathname.startsWith('/wasm/')) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return withAssetHeaders(asset, url);

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

    // Non-HTML assets: hardening + cache headers (see cacheControlFor).
    return withAssetHeaders(res, url);
  },
};

/**
 * Contact form handler (production). Validates the JSON body, stores the message
 * in KV (env.CONTACT_KV — visible under Workers & Pages → KV in the dashboard), and
 * forwards it to the owner's inbox if an email provider secret is configured:
 *   • env.WEB3FORMS_KEY  — free relay to any inbox (no domain needed), or
 *   • env.RESEND_API_KEY (+ optional RESEND_FROM / CONTACT_TO).
 * Email is best-effort; a stored message is a success even if delivery is off.
 */
async function handleContact(request, env, ctx) {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

  let b;
  try { b = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  const clip = (s, n) => String(s || '').trim().slice(0, n);
  // Honeypot: bots fill the hidden "company" field.
  if (clip(b.company, 100)) return json({ ok: true });

  const name = clip(b.name, 120);
  const email = clip(b.email, 200);
  const reason = clip(b.reason, 80) || 'General question';
  const message = clip(b.message, 8000);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !message) {
    return json({ error: 'Please provide your name, a valid email, and a message.' }, 400);
  }

  const record = {
    ts: new Date().toISOString(),
    name, email, reason, message,
    ip: request.headers.get('cf-connecting-ip') || '',
    ua: clip(request.headers.get('user-agent'), 300),
    country: (request.cf && request.cf.country) || '',
  };

  // 1) Store in KV (durable; browse in the dashboard). Bind CONTACT_KV in wrangler.
  let stored = false;
  if (env.CONTACT_KV) {
    try {
      const key = `msg:${record.ts}:${crypto.randomUUID().slice(0, 8)}`;
      await env.CONTACT_KV.put(key, JSON.stringify(record));
      stored = true;
    } catch (err) { console.error('[contact] KV put failed:', err.message); }
  }

  // 2) Forward via email (best-effort).
  let emailed = false;
  const to = env.CONTACT_TO || 'bloodpath9089@gmail.com';
  const subject = `[Advance Office Doc] ${reason} — ${name}`;
  const text = `Name: ${name}\nEmail: ${email}\nReason: ${reason}\nTime: ${record.ts}\n\n${message}`;
  try {
    if (env.WEB3FORMS_KEY) {
      const r = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ access_key: env.WEB3FORMS_KEY, subject, from_name: name, replyto: email, email, message: text }),
      });
      emailed = r.ok;
    } else if (env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
        body: JSON.stringify({ from: env.RESEND_FROM || 'Advance Office Doc <onboarding@resend.dev>', to: [to], reply_to: email, subject, text }),
      });
      emailed = r.ok;
    }
  } catch (err) { console.error('[contact] email failed:', err.message); }

  if (!stored && !emailed) return json({ error: 'Could not deliver your message. Please email us directly.' }, 500);
  return json({ ok: true, emailed });
}

/** Read stored contact messages from KV (production inbox). Gated by a token
 *  (?token= or x-admin-token) matching env.CONTACT_ADMIN_TOKEN. Returns JSON at
 *  /api/contact/messages and a simple HTML table at /api/contact/inbox. */
async function handleContactRead(request, env, url) {
  const token = env.CONTACT_ADMIN_TOKEN || '';
  const given = url.searchParams.get('token') || request.headers.get('x-admin-token') || '';
  if (!token || given !== token) {
    return new Response('Forbidden. Append ?token=YOUR_TOKEN (set CONTACT_ADMIN_TOKEN as a Worker secret).', { status: 403 });
  }
  if (!env.CONTACT_KV) {
    return new Response('KV is not configured. Bind CONTACT_KV in wrangler.jsonc.', { status: 503 });
  }
  const list = await env.CONTACT_KV.list({ prefix: 'msg:', limit: 1000 });
  const msgs = [];
  for (const k of list.keys) {
    const v = await env.CONTACT_KV.get(k.name);
    if (v) { try { msgs.push(JSON.parse(v)); } catch { /* skip */ } }
  }
  msgs.reverse(); // newest first (keys are timestamp-prefixed)

  if (url.pathname === '/api/contact/messages') {
    return new Response(JSON.stringify({ messages: msgs }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = msgs.map((m) => `<tr><td class="ts">${esc((m.ts || '').replace('T', ' ').replace(/\..+/, ''))}</td><td>${esc(m.name)}<br><a href="mailto:${esc(m.email)}">${esc(m.email)}</a></td><td>${esc(m.reason)}</td><td class="msg">${esc(m.message)}</td></tr>`).join('');
  const html = `<!doctype html><meta charset="utf8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Contact inbox (${msgs.length})</title>
  <style>body{font:15px/1.5 system-ui,Segoe UI,Arial;margin:0;background:#f6f7fb;color:#111}header{padding:18px 24px;background:#4f46e5;color:#fff}header h1{margin:0;font-size:18px}.wrap{padding:20px 24px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06)}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eef;vertical-align:top}th{background:#f0f1f8;font-size:12px;text-transform:uppercase}td.ts{white-space:nowrap;color:#666;font-size:13px}td.msg{white-space:pre-wrap;max-width:520px}.empty{padding:40px;text-align:center;color:#777}</style>
  <header><h1>📨 Contact inbox</h1></header><div class="wrap">${msgs.length ? `<table><thead><tr><th>When</th><th>From</th><th>Reason</th><th>Message</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No messages yet.</div>'}</div>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/* ============================ Cloud AI proxy ============================== */
// Mirrors the Express routes (src/routes/ai.js): a credit-gated provider proxy.
// Key from env.AI_API_KEY (Worker secret); wallet in env.CREDITS_KV (KV namespace).

const aiJson = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function handleAi(request, env, pathname) {
  const provider = (env.AI_PROVIDER || 'gemini').toLowerCase();
  const aiEnabled = Boolean(env.AI_API_KEY);

  // Public catalogue — no auth, no key, no deduction.
  if (pathname === '/api/ai/credit-info' && request.method === 'GET') {
    return aiJson(credits.creditInfo());
  }

  // Read-only balance for the header badge — needs identity, not a provider key.
  if (pathname === '/api/ai/credits' && request.method === 'GET') {
    const user = await resolveUser(request, env);
    if (!user) return aiJson({ error: 'Please sign in to use the AI assistant.', code: 'AUTH_REQUIRED' }, 401);
    const account = await credits.getAccount(env, user.id, user.email);
    const plan = credits.getPlan(account.plan);
    return aiJson({
      credits: account.credits, plan: account.plan, planLabel: plan.label,
      monthlyCredits: plan.monthlyCredits, resetAt: account.resetAt || null, resetDays: credits.RESET_INTERVAL_DAYS,
    });
  }

  // Pre-flight cost estimate — same resolver as /chat, so estimate == charge.
  if (pathname === '/api/ai/estimate' && request.method === 'POST') {
    let body; try { body = await request.json(); } catch { return aiJson({ error: 'Invalid request.' }, 400); }
    if (typeof body?.prompt !== 'string' || !body.prompt.trim()) return aiJson({ error: 'A prompt is required.' }, 400);
    const user = await resolveUser(request, env);
    if (!user) return aiJson({ error: 'Please sign in to use the AI assistant.', code: 'AUTH_REQUIRED' }, 401);
    const resolved = credits.resolveTask({ prompt: body.prompt, action: body.action });
    if (!resolved.ok) return aiJson({ error: `Unknown AI action "${resolved.action}".`, code: 'UNKNOWN_ACTION' }, 400);
    const account = await credits.getAccount(env, user.id, user.email);
    return aiJson({
      action: resolved.action, actionLabel: credits.getActionLabel(resolved.action), cost: resolved.cost,
      credits: account.credits, plan: account.plan, sufficient: account.credits >= resolved.cost,
    });
  }

  // The AI request itself.
  if (pathname === '/api/ai/chat' && request.method === 'POST') {
    if (!aiEnabled) return aiJson({ error: 'AI is not configured. Set AI_API_KEY as a Worker secret.' }, 503);
    let body; try { body = await request.json(); } catch { return aiJson({ error: 'Invalid request.' }, 400); }

    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return aiJson({ error: 'A prompt is required.' }, 400);
    const img = body?.image;
    const hasImage = img && typeof img.data === 'string' && img.data;
    if (hasImage && provider !== 'gemini') return aiJson({ error: 'Image input is only wired for the Gemini provider right now.' }, 400);

    const user = await resolveUser(request, env);
    if (!user) return aiJson({ error: 'Please sign in to use the AI assistant.', code: 'AUTH_REQUIRED' }, 401);

    // Resolve the billable task SERVER-SIDE and reserve credits before the call.
    const resolved = credits.resolveTask({ prompt, action: body?.action });
    if (!resolved.ok) return aiJson({ error: `Unknown AI action "${resolved.action}".`, code: 'UNKNOWN_ACTION' }, 400);
    const reservation = await credits.reserve(env, user, resolved.action, resolved.cost);
    if (!reservation.ok) {
      return aiJson({ error: reservation.error, code: reservation.code, credits: reservation.account.credits, required: reservation.cost, plan: reservation.account.plan, action: reservation.action }, reservation.status);
    }
    const credit = { action: reservation.action, cost: reservation.cost, balanceAfter: reservation.balanceAfter };

    const call = PROVIDERS[provider];
    if (!call) {
      const bal = await credits.refundFailed(env, user, credit, 'unknown_provider');
      return aiJson({ error: `Unknown AI_PROVIDER "${provider}".`, credits: bal }, 500);
    }

    const agent = body?.mode === 'agent';
    const image = hasImage ? { mimeType: typeof img.mimeType === 'string' ? img.mimeType : 'image/png', data: img.data } : null;

    let result;
    try {
      result = await call({
        apiKey: env.AI_API_KEY, model: env.AI_MODEL || '',
        system: agent ? AGENT_SYSTEM : SYSTEM,
        prompt, text: typeof body?.text === 'string' ? body.text : '',
        selection: typeof body?.selection === 'string' ? body.selection : '',
        image, history: body?.history,
      });
    } catch (err) {
      const bal = await credits.refundFailed(env, user, credit, 'ai_request_failed');
      return aiJson({ error: err.message || 'AI request failed.', credits: bal }, err.status || 502);
    }

    // Delivered → settle (audit + return balance). A settlement error must NOT refund.
    let balance;
    try { balance = await credits.finalize(env, user, { action: credit.action, cost: credit.cost, model: result.model, usage: result.usage }); }
    catch { balance = credit.balanceAfter; }

    const meta = { provider, credits: balance, charged: credit.cost, action: credit.action, actionLabel: credits.getActionLabel(credit.action) };
    const raw = result.text;

    if (agent) {
      const actions = toActions(extractJson(raw));
      if (actions && actions.length) return aiJson({ actions, ...meta });
      const looksJson = /^\s*[[{]/.test(raw || '') || /"action"\s*:/.test(raw || '');
      if (looksJson) return aiJson({ error: 'The AI response was incomplete — please try again.', incomplete: true, ...meta });
      return aiJson({ reply: raw || 'The model returned an empty response.', ...meta });
    }
    return aiJson({ reply: raw || 'The model returned an empty response.', ...meta });
  }

  return aiJson({ error: 'Not found.' }, 404);
}

function withAssetHeaders(res, url) {
  const headers = new Headers(res.headers);
  setAssetContentType(headers, url.pathname);
  const cc = cacheControlFor(url.pathname, url.search);
  if (cc) headers.set('Cache-Control', cc);
  securityHeaders(headers);
  return new Response(res.body, { status: res.status, headers });
}

function setAssetContentType(headers, pathname) {
  if (pathname.endsWith('.onnx')) headers.set('Content-Type', 'application/octet-stream');
  else if (pathname.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
}
