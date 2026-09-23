/**
 * Advance Office Doc — workspace (editor) auth gate.
 *
 * The editor is for signed-in users only. The workspace SPA is a separate
 * document from the marketing site and does NOT load auth.js, so this gate is
 * the single entry point that enforces sign-in for the app itself.
 *
 * How it works: the workspace layout no longer loads the app module directly.
 * Instead it loads this gate, which checks the Supabase session and:
 *   - signed in  → injects the app module (the editor boots as normal);
 *   - signed out → shows a full-screen "Continue with Google" panel and never
 *     loads the app, so the editor is genuinely inaccessible without an account.
 *
 * Signing in from here uses redirectTo:/workspace, so after Google the visitor
 * lands back on the editor already authenticated and the gate boots the app.
 *
 * The publishable key is client-safe (see public/js/auth.js for the rationale).
 */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://synosgiafpeidtvjnnkk.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_6s1pPaUCFkp-SxDz790Krw_TpulJekK';
  var APP_MODULE = window.__APP_MODULE || '/js/app/index.js';

  var booted = false;
  var gateEl = null;

  /* ---- Boot the editor (once) ------------------------------------------ */
  function bootApp() {
    if (booted) return;
    booted = true;
    removeGate();
    var s = document.createElement('script');
    s.type = 'module';
    s.src = APP_MODULE;
    document.body.appendChild(s);
  }

  /* ---- Strip the OAuth ?code=…/#access_token=… once consumed ------------ */
  function stripUrl() {
    if (/[?#][^#]*(code=|access_token=)/.test(window.location.href)) {
      history.replaceState({}, document.title, window.location.pathname);
    }
  }

  /* ---- Full-screen sign-in gate ---------------------------------------- */
  function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }

  function googleMark() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 18 18');
    svg.setAttribute('width', '18'); svg.setAttribute('height', '18');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'auth-modal__glogo');
    var paths = [
      ['#4285F4', 'M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z'],
      ['#34A853', 'M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.85.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z'],
      ['#FBBC05', 'M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z'],
      ['#EA4335', 'M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z'],
    ];
    paths.forEach(function (p) {
      var node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      node.setAttribute('fill', p[0]); node.setAttribute('d', p[1]); svg.appendChild(node);
    });
    return svg;
  }

  function showGate(onSignIn) {
    if (gateEl) { gateEl.hidden = false; return; }
    var gate = el('div', 'auth-gate');

    var card = el('div', 'auth-gate__card');
    var title = el('h1', 'auth-gate__title');
    title.textContent = 'Welcome to Advance Office Doc';
    var lead = el('p', 'auth-gate__lead');
    lead.textContent = 'Sign in to access the editor, save documents, and use AI-powered tools.';

    var google = el('button', 'auth-modal__google');
    google.type = 'button';
    google.appendChild(googleMark());
    var glabel = el('span'); glabel.textContent = 'Continue with Google';
    google.appendChild(glabel);
    google.addEventListener('click', onSignIn);

    var note = el('p', 'auth-modal__note');
    note.textContent = 'We never see or store your Google password.';

    var back = el('a', 'auth-gate__back');
    back.href = '/'; back.textContent = 'Back to home';

    card.appendChild(title);
    card.appendChild(lead);
    card.appendChild(google);
    card.appendChild(note);
    card.appendChild(back);
    gate.appendChild(card);
    document.body.appendChild(gate);
    gateEl = gate;
    void gate.offsetWidth; gate.classList.add('is-open');
    google.focus();
  }

  function removeGate() { if (gateEl) { gateEl.remove(); gateEl = null; } }

  /* ---- Fail-closed fallback -------------------------------------------- */
  // If the Supabase client can't load, the editor must NOT open. Show a minimal
  // gate whose button reloads the page to retry loading the auth library.
  function hardFail() {
    showGate(function () { window.location.reload(); });
  }

  /* ---- Local dev bypass ------------------------------------------------ */
  // On localhost the editor opens WITHOUT sign-in, so development on the local
  // server (e.g. http://localhost:3210) never needs a Google session. Deployed
  // (Cloudflare) hostnames are unaffected and still require sign-in.
  function isLocalDev() {
    var h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  }

  /* ---- Boot ------------------------------------------------------------ */
  if (isLocalDev()) { bootApp(); return; }

  if (!window.supabase || !window.supabase.createClient) { hardFail(); return; }

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      flowType: 'pkce',
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
      storageKey: 'aod-auth',
    },
  });

  function signIn() {
    client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/workspace' },
    });
  }

  client.auth.getSession().then(function (res) {
    var session = res && res.data && res.data.session;
    if (session) { stripUrl(); bootApp(); }
    else { showGate(signIn); }
  }).catch(hardFail);

  // On return from Google the session may arrive after getSession() (the ?code
  // exchange is async), so also boot when auth state flips to signed-in.
  client.auth.onAuthStateChange(function (_event, session) {
    if (session) { stripUrl(); bootApp(); }
  });
})();
