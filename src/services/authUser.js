'use strict';

const config = require('../config');

/**
 * Server-side user identity for the credit system.
 *
 * Credits are per-user, so the server MUST know who is calling — it can't trust a
 * client-supplied id. The browser signs in with Supabase (Google) and holds a
 * short-lived access token (a JWT). The client sends it as `Authorization: Bearer
 * <token>`; here we verify it by asking Supabase who it belongs to
 * (GET /auth/v1/user). That call validates the JWT signature/expiry for us and
 * needs only the public anon key — no service/secret key on the server.
 *
 * A tiny in-memory cache avoids hitting Supabase on every keystroke-fast request.
 *
 * Dev fallback: on localhost (or when DEV_USER_ID is set) an unauthenticated call
 * is attributed to a stub user, so the whole credit flow is testable without a
 * live Google session.
 */

// token -> { user, exp } cache. Verified tokens are cached briefly.
const CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isLoopback(req) {
  const ip = (req.ip || '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function bearerToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : '';
}

/** Verify a Supabase access token and return { id, email } or null. */
async function verifySupabaseToken(token) {
  const now = Date.now();
  const hit = CACHE.get(token);
  if (hit && hit.exp > now) return hit.user;

  try {
    const res = await fetch(`${config.auth.supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: config.auth.supabaseAnonKey,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.id) return null;
    const user = { id: data.id, email: data.email || '' };
    CACHE.set(token, { user, exp: now + CACHE_TTL_MS });
    return user;
  } catch (err) {
    console.error('[auth] Supabase token verification failed:', err.message);
    return null;
  }
}

/**
 * Resolve the calling user for a request. Returns { id, email } or null.
 *
 * Order: a verified Supabase bearer token wins. Otherwise, ONLY in development
 * (localhost or DEV_USER_ID set) we attribute the request to a stub user so the
 * credit flow can be exercised locally.
 *
 * SECURITY: the dev fallback is hard-gated to `config.isDevelopment`, so it can
 * never run in production regardless of proxy/IP configuration — and the
 * client-supplied `x-user-id` / `x-user-email` headers are ONLY honoured in
 * development. In production an unverified request always resolves to null (401).
 * (Startup also refuses to boot if DEV_USER_ID is set in production — see config.)
 */
async function resolveUser(req) {
  const token = bearerToken(req);
  if (token) {
    const user = await verifySupabaseToken(token);
    if (user) return user;
  }

  // Dev-only identity fallback. Never reachable in production.
  if (config.isDevelopment) {
    const devAllowed = isLoopback(req) || Boolean(config.auth.devUserId);
    if (devAllowed) {
      const id = config.auth.devUserId
        || String(req.headers['x-user-id'] || '').trim()
        || 'dev-local-user';
      const email = String(req.headers['x-user-email'] || '').trim()
        || config.auth.devUserEmail;
      return { id, email };
    }
  }

  return null;
}

module.exports = { resolveUser, verifySupabaseToken, isLoopback, bearerToken };
