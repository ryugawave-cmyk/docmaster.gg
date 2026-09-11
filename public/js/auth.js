/**
 * Advance Office Doc — Google sign-in (Supabase Auth).
 *
 * Uses Supabase's full-page OAuth REDIRECT flow (not a popup) on purpose: the
 * site is cross-origin isolated (COOP: same-origin), which breaks popup-based
 * Google Sign-In but leaves top-level redirects untouched. The Supabase client
 * library is vendored same-origin (/vendor/supabase/supabase.js) so no
 * cross-origin CDN is needed and the strict CSP/isolation stays intact.
 *
 * The values below are the PUBLISHABLE (client) credentials. The publishable
 * key is designed to be embedded in frontend code — it is NOT a secret. Data is
 * protected server-side by Row Level Security. The service/secret key must never
 * appear here.
 *
 * Signed-in users appear in the Supabase dashboard → Authentication → Users.
 */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://synosgiafpeidtvjnnkk.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_6s1pPaUCFkp-SxDz790Krw_TpulJekK';

  var mount = document.querySelector('[data-auth]');
  if (!mount || !window.supabase || !window.supabase.createClient) return;

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      flowType: 'pkce',
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
      storageKey: 'aod-auth',
    },
  });

  var signinBtn = mount.querySelector('[data-auth-signin]');
  var chip = null; // built lazily once a user is present

  /* ---- Actions --------------------------------------------------------- */
  function signIn() {
    client.auth.signInWithOAuth({
      provider: 'google',
      // Return to the exact page the visitor started from.
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
  }
  function signOut() {
    client.auth.signOut().then(function () { render(null); });
  }
  if (signinBtn) signinBtn.addEventListener('click', signIn);

  /* ---- Tiny DOM helper ------------------------------------------------- */
  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }
  function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || 'Account'; }
  function initial(name) {
    var s = el('span', 'auth-avatar auth-avatar--initial');
    s.textContent = (String(name || '?').trim().charAt(0) || '?').toUpperCase();
    return s;
  }
  function caret() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'auth-caret');
    svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M6 9l6 6 6-6'); svg.appendChild(p);
    return svg;
  }

  /* ---- Signed-in chip + dropdown --------------------------------------- */
  function buildChip(user) {
    var meta = user.user_metadata || {};
    var name = meta.full_name || meta.name || (user.email || '').split('@')[0];
    var email = user.email || '';
    var avatar = meta.avatar_url || meta.picture || '';

    var wrap = el('div', 'auth-chip-wrap');
    var btn = el('button', 'auth-chip');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');

    if (avatar) {
      var img = el('img', 'auth-avatar');
      img.alt = ''; img.referrerPolicy = 'no-referrer'; img.crossOrigin = 'anonymous';
      img.src = avatar;
      img.addEventListener('error', function () { img.replaceWith(initial(name)); });
      btn.appendChild(img);
    } else {
      btn.appendChild(initial(name));
    }
    var label = el('span', 'auth-name'); label.textContent = firstName(name);
    btn.appendChild(label);
    btn.appendChild(caret());

    var menu = el('div', 'auth-menu'); menu.hidden = true;
    var info = el('div', 'auth-menu__info');
    var nm = el('div', 'auth-menu__name'); nm.textContent = name;
    var em = el('div', 'auth-menu__email'); em.textContent = email;
    info.appendChild(nm); info.appendChild(em);
    var out = el('button', 'auth-menu__signout'); out.type = 'button'; out.textContent = 'Sign out';
    out.addEventListener('click', signOut);
    menu.appendChild(info); menu.appendChild(out);

    function toggle(open) {
      var next = (open == null) ? menu.hidden : open;
      menu.hidden = !next;
      btn.setAttribute('aria-expanded', String(next));
    }
    btn.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
    menu.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () { if (!menu.hidden) toggle(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !menu.hidden) toggle(false); });

    wrap.appendChild(btn); wrap.appendChild(menu);
    return wrap;
  }

  /* ---- Render ---------------------------------------------------------- */
  function render(user) {
    if (user) {
      if (signinBtn) signinBtn.hidden = true;
      if (chip) chip.remove();
      chip = buildChip(user);
      mount.appendChild(chip);
    } else {
      if (chip) { chip.remove(); chip = null; }
      if (signinBtn) signinBtn.hidden = false;
    }
  }

  /* ---- Boot ------------------------------------------------------------ */
  client.auth.getSession().then(function (res) {
    render(res && res.data && res.data.session ? res.data.session.user : null);
    // Strip the OAuth ?code=…/#access_token=… from the URL once consumed.
    if (/[?#][^#]*(code=|access_token=)/.test(window.location.href)) {
      history.replaceState({}, document.title, window.location.pathname);
    }
  });
  client.auth.onAuthStateChange(function (_event, session) {
    render(session ? session.user : null);
  });
})();
