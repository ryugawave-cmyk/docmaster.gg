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
 * UI model (SaaS-style, no duplicate auth buttons, no visible vendor branding):
 *   - Logged out: a single "Sign In" button. Clicking it opens a modal with a
 *     "Continue with Google" button. Clicking "Open editor" while logged out
 *     also opens the modal and blocks entry.
 *   - Logged in: the Sign In button is gone; only the Google avatar shows, and
 *     clicking it opens a dropdown (My Account · My Documents · Settings ·
 *     Sign Out).
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
  var chip = null;         // built lazily once a user is present
  var modal = null;        // built lazily on first sign-in prompt
  var currentUser = null;  // latest known session user (null when logged out)

  // Resolves once the initial session lookup completes, so editor-gating clicks
  // that fire before boot don't wrongly bounce an already-signed-in visitor.
  var sessionReady = client.auth.getSession().then(function (res) {
    return res && res.data && res.data.session ? res.data.session.user : null;
  });

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
  if (signinBtn) signinBtn.addEventListener('click', openModal);

  /* ---- Tiny DOM helpers ------------------------------------------------ */
  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }
  function initial(name) {
    var s = el('span', 'auth-avatar auth-avatar--initial');
    s.textContent = (String(name || '?').trim().charAt(0) || '?').toUpperCase();
    return s;
  }
  function googleMark(cls) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 18 18');
    svg.setAttribute('width', '18'); svg.setAttribute('height', '18');
    svg.setAttribute('aria-hidden', 'true');
    if (cls) svg.setAttribute('class', cls);
    var paths = [
      ['#4285F4', 'M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z'],
      ['#34A853', 'M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.85.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z'],
      ['#FBBC05', 'M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z'],
      ['#EA4335', 'M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z'],
    ];
    paths.forEach(function (p) {
      var node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      node.setAttribute('fill', p[0]); node.setAttribute('d', p[1]);
      svg.appendChild(node);
    });
    return svg;
  }

  /* ---- Sign-in modal --------------------------------------------------- */
  function buildModal() {
    var overlay = el('div', 'auth-modal');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'auth-modal-title');
    overlay.hidden = true;

    var card = el('div', 'auth-modal__card');

    var close = el('button', 'auth-modal__close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = '&times;';
    close.addEventListener('click', closeModal);

    var title = el('h2', 'auth-modal__title');
    title.id = 'auth-modal-title';
    title.textContent = 'Welcome to Advance Office Doc';

    var lead = el('p', 'auth-modal__lead');
    lead.textContent = 'Sign in to access the editor, save documents, and use AI-powered tools.';

    var google = el('button', 'auth-modal__google');
    google.type = 'button';
    google.appendChild(googleMark('auth-modal__glogo'));
    var glabel = el('span'); glabel.textContent = 'Continue with Google';
    google.appendChild(glabel);
    google.addEventListener('click', signIn);

    var note = el('p', 'auth-modal__note');
    note.textContent = 'We never see or store your Google password.';

    card.appendChild(close);
    card.appendChild(title);
    card.appendChild(lead);
    card.appendChild(google);
    card.appendChild(note);
    overlay.appendChild(card);

    // Backdrop click closes; clicks inside the card do not bubble out to it.
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    card.addEventListener('click', function (e) { e.stopPropagation(); });

    document.body.appendChild(overlay);
    return overlay;
  }

  function onModalKeydown(e) { if (e.key === 'Escape') closeModal(); }

  function openModal() {
    if (!modal) modal = buildModal();
    modal.hidden = false;
    // Force reflow so the opening transition runs from the hidden state.
    void modal.offsetWidth;
    modal.classList.add('is-open');
    document.body.classList.add('auth-modal-open');
    document.addEventListener('keydown', onModalKeydown);
    var g = modal.querySelector('.auth-modal__google');
    if (g) g.focus();
  }

  function closeModal() {
    if (!modal || modal.hidden) return;
    modal.classList.remove('is-open');
    document.body.classList.remove('auth-modal-open');
    document.removeEventListener('keydown', onModalKeydown);
    var m = modal;
    // Hide after the transition so it's removed from the tab order.
    window.setTimeout(function () { if (!m.classList.contains('is-open')) m.hidden = true; }, 200);
  }

  /* ---- Editor gating --------------------------------------------------- */
  // Any "Open editor" CTA points at /workspace. When logged out, intercept the
  // click, show the modal, and block navigation. The workspace SPA is a
  // separate document that doesn't load this script, so gating at the link is
  // the entry point.
  // On localhost the editor is open for development, so "Open editor" links
  // navigate freely without a sign-in prompt. Deployed hostnames still gate.
  function isLocalDev() {
    var h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  }

  function gateEditorLinks() {
    var links = document.querySelectorAll('a[href^="/workspace"]');
    Array.prototype.forEach.call(links, function (link) {
      link.addEventListener('click', function (e) {
        if (currentUser || isLocalDev()) return; // signed in or local dev → let it through
        e.preventDefault();
        var href = link.getAttribute('href');
        // Resolve the (possibly still-pending) initial session before deciding.
        sessionReady.then(function () {
          if (currentUser) { window.location.href = href; return; }
          openModal();
        });
      });
    });
  }

  /* ---- Signed-in avatar + dropdown ------------------------------------- */
  function menuLink(label, href) {
    var a = el('a', 'auth-menu__item');
    a.href = href;
    a.textContent = label;
    a.setAttribute('role', 'menuitem');
    return a;
  }

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
    btn.setAttribute('aria-label', 'Account menu');

    if (avatar) {
      var img = el('img', 'auth-avatar');
      img.alt = ''; img.referrerPolicy = 'no-referrer'; img.crossOrigin = 'anonymous';
      img.src = avatar;
      img.addEventListener('error', function () { img.replaceWith(initial(name)); });
      btn.appendChild(img);
    } else {
      btn.appendChild(initial(name));
    }

    var menu = el('div', 'auth-menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    var info = el('div', 'auth-menu__info');
    var nm = el('div', 'auth-menu__name'); nm.textContent = name;
    var em = el('div', 'auth-menu__email'); em.textContent = email;
    info.appendChild(nm); info.appendChild(em);
    menu.appendChild(info);

    // Documents live in the workspace/editor; account + settings are future
    // pages, routed there for now so every item is a real, focusable link.
    menu.appendChild(menuLink('My Account', '/workspace'));
    menu.appendChild(menuLink('My Documents', '/workspace'));
    menu.appendChild(menuLink('Settings', '/workspace'));

    var out = el('button', 'auth-menu__item auth-menu__signout');
    out.type = 'button'; out.textContent = 'Sign Out';
    out.setAttribute('role', 'menuitem');
    out.addEventListener('click', signOut);
    menu.appendChild(out);

    function toggle(open) {
      var next = (open == null) ? menu.hidden : open;
      menu.hidden = !next;
      if (next) { void menu.offsetWidth; menu.classList.add('is-open'); }
      else { menu.classList.remove('is-open'); }
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
    currentUser = user || null;
    // NB: `.btn { display: inline-flex }` (style.css) beats the [hidden] UA rule,
    // so toggling the `hidden` attribute would leave the button visible. Toggle
    // an inline `display` instead — an inline style wins over the class rule —
    // and mirror it on `hidden` for the a11y tree. Only ever ONE of button/avatar.
    if (user) {
      if (signinBtn) { signinBtn.hidden = true; signinBtn.style.display = 'none'; }
      if (chip) chip.remove();
      chip = buildChip(user);
      mount.appendChild(chip);
      closeModal(); // dismiss the prompt if it was open when auth completed
    } else {
      if (chip) { chip.remove(); chip = null; }
      if (signinBtn) { signinBtn.hidden = false; signinBtn.style.display = ''; }
    }
  }

  /* ---- Boot ------------------------------------------------------------ */
  gateEditorLinks();
  sessionReady.then(function (user) {
    render(user);
    // Strip the OAuth ?code=…/#access_token=… from the URL once consumed.
    if (/[?#][^#]*(code=|access_token=)/.test(window.location.href)) {
      history.replaceState({}, document.title, window.location.pathname);
    }
  });
  client.auth.onAuthStateChange(function (_event, session) {
    render(session ? session.user : null);
  });
})();
