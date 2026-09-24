/**
 * Server-side user identity for the Worker credit system — a port of
 * src/services/authUser.js (no dev fallback: production always requires a token).
 *
 * The browser signs in with Supabase (Google) and holds a short-lived access token.
 * It sends it as `Authorization: Bearer <token>`; we verify it by asking Supabase
 * who it belongs to (GET /auth/v1/user), which validates the JWT for us and needs
 * only the PUBLIC anon key. A small in-isolate cache avoids re-verifying every call.
 */

const CACHE = new Map(); // token -> { user, exp }
const CACHE_TTL_MS = 5 * 60 * 1000;

// The Supabase project. Overridable via Worker vars; anon key is publishable.
const SUPABASE_URL = 'https://synosgiafpeidtvjnnkk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_6s1pPaUCFkp-SxDz790Krw_TpulJekK';

function bearerToken(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

/** Verify a Supabase access token → { id, email } or null. */
export async function resolveUser(request, env) {
  const token = bearerToken(request);
  if (!token) return null;

  const now = Date.now();
  const hit = CACHE.get(token);
  if (hit && hit.exp > now) return hit.user;

  const base = (env && env.SUPABASE_URL) || SUPABASE_URL;
  const key = (env && env.SUPABASE_ANON_KEY) || SUPABASE_ANON_KEY;
  try {
    const res = await fetch(`${base}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
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
