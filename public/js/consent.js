/**
 * Advance Office Doc — cookie consent (Google Consent Mode v2 compatible).
 *
 * Design goals:
 *  - Non-blocking banner + accessible preferences modal.
 *  - Three clear choices: Accept all · Decline optional · Manage preferences.
 *  - Consent categories: necessary (always on), analytics, advertising.
 *  - Optional analytics/advertising technologies are NEVER loaded before consent.
 *    Gate them on AlvionConsent.hasConsent('advertising' | 'analytics').
 *  - Google Consent Mode v2: defaults are set to "denied" up front and updated
 *    when the visitor decides, so this is compatible with Google AdSense's
 *    consent requirements. No Google scripts are loaded here — this only records
 *    the consent signal so a future tag reads the correct state.
 *
 * Nothing here claims analytics or ads are currently used; they are optional and
 * off by default until explicitly allowed.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'alvion:cookie-consent:v2';
  var CATEGORIES = ['analytics', 'advertising'];

  /* ---- Google Consent Mode v2 bootstrap (defaults denied) --------------- */
  // Safe with no Google tag present: the calls just queue into dataLayer and are
  // read by Google tags if/when they are added later. This is the recommended
  // "consent default before update" pattern.
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    functionality_storage: 'granted',
    security_storage: 'granted',
    wait_for_update: 500,
  });

  /* ---- Storage helpers -------------------------------------------------- */
  function read() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function write(state) {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { /* storage blocked — banner simply reappears next visit */ }
  }

  /* ---- Apply a consent decision ---------------------------------------- */
  var listeners = [];
  function apply(state) {
    // Mirror to Google Consent Mode.
    gtag('consent', 'update', {
      ad_storage: state.advertising ? 'granted' : 'denied',
      ad_user_data: state.advertising ? 'granted' : 'denied',
      ad_personalization: state.advertising ? 'granted' : 'denied',
      analytics_storage: state.analytics ? 'granted' : 'denied',
    });
    // Notify any registered gates (e.g. code that loads ads once allowed).
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state); } catch (e) { /* ignore listener errors */ }
    }
  }

  function decision(analytics, advertising) {
    return {
      necessary: true,
      analytics: !!analytics,
      advertising: !!advertising,
      ts: new Date().toISOString(),
      v: 2,
    };
  }

  function save(state) {
    write(state);
    apply(state);
  }

  /* ---- DOM references --------------------------------------------------- */
  var banner = document.querySelector('[data-cc-banner]');
  var modal = document.querySelector('[data-cc-modal]');
  var toggles = {};
  if (modal) {
    modal.querySelectorAll('[data-cc-category]').forEach(function (el) {
      toggles[el.getAttribute('data-cc-category')] = el;
    });
  }

  function showBanner() { if (banner) { banner.hidden = false; requestAnimationFrame(function () { banner.classList.add('is-visible'); }); } }
  function hideBanner() { if (banner) { banner.hidden = true; banner.classList.remove('is-visible'); } }

  var lastFocus = null;
  function openModal() {
    if (!modal) return;
    var stored = read();
    CATEGORIES.forEach(function (cat) {
      if (toggles[cat]) toggles[cat].checked = !!(stored && stored[cat]);
    });
    lastFocus = document.activeElement;
    modal.hidden = false;
    requestAnimationFrame(function () { modal.classList.add('is-open'); });
    var first = modal.querySelector('.cc-modal__close');
    if (first) first.focus();
    document.addEventListener('keydown', onKeydown);
  }
  function closeModal() {
    if (!modal) return;
    modal.classList.remove('is-open');
    modal.hidden = true;
    document.removeEventListener('keydown', onKeydown);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function onKeydown(e) { if (e.key === 'Escape') closeModal(); }

  /* ---- Actions ---------------------------------------------------------- */
  function acceptAll() { save(decision(true, true)); hideBanner(); closeModal(); }
  function declineOptional() { save(decision(false, false)); hideBanner(); closeModal(); }
  function savePreferences() {
    save(decision(
      toggles.analytics && toggles.analytics.checked,
      toggles.advertising && toggles.advertising.checked
    ));
    hideBanner();
    closeModal();
  }

  /* ---- Wire up buttons (banner + modal share data-attributes) ---------- */
  document.querySelectorAll('[data-cc-accept]').forEach(function (b) { b.addEventListener('click', acceptAll); });
  document.querySelectorAll('[data-cc-decline]').forEach(function (b) { b.addEventListener('click', declineOptional); });
  document.querySelectorAll('[data-cc-save]').forEach(function (b) { b.addEventListener('click', savePreferences); });
  document.querySelectorAll('[data-cc-manage]').forEach(function (b) { b.addEventListener('click', openModal); });
  document.querySelectorAll('[data-cc-close]').forEach(function (b) { b.addEventListener('click', closeModal); });
  // Any element (e.g. a footer "Cookie settings" link) can reopen preferences.
  document.querySelectorAll('[data-cc-open]').forEach(function (b) {
    b.addEventListener('click', function (e) { e.preventDefault(); openModal(); });
  });

  /* ---- Public API for gating optional technologies --------------------- */
  window.AlvionConsent = {
    get: function () { return read(); },
    hasConsent: function (category) {
      if (category === 'necessary') return true;
      var s = read();
      return !!(s && s[category]);
    },
    openPreferences: openModal,
    // Register a callback fired on every consent decision. Use this to load ad or
    // analytics scripts only after the relevant consent is granted, e.g.:
    //   AlvionConsent.onChange(function (s) {
    //     if (s.advertising) loadAdSense();
    //   });
    onChange: function (fn) { if (typeof fn === 'function') { listeners.push(fn); var s = read(); if (s) fn(s); } },
  };

  /* ---- Initial state ---------------------------------------------------- */
  var existing = read();
  if (existing && existing.v === 2) {
    apply(existing); // Re-assert stored choice to Consent Mode on load.
  } else {
    showBanner();    // No decision yet — ask.
  }
})();
