/**
 * Advance Office Doc — client-side interactions.
 * Progressive enhancement only: the site is fully usable without JS.
 */
(function () {
  'use strict';

  /* ----- Mobile navigation toggle ------------------------------------- */
  const toggle = document.querySelector('[data-nav-toggle]');
  const nav = document.querySelector('[data-nav]');

  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      const isOpen = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(isOpen));
    });

    // Close the menu after navigating to a link.
    nav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  /* ----- Header shadow on scroll -------------------------------------- */
  // On the home page the header floats transparently over the full-height hero
  // video, and only switches to its solid style once the visitor scrolls PAST
  // the hero into the content below — so the video is never covered by a bar.
  // On every other page it turns solid after a small scroll, as usual.
  const header = document.querySelector('[data-header]');
  if (header) {
    const isHome = document.body.classList.contains('page-home');
    const hero = document.querySelector('.hero--video');
    const onScroll = function () {
      let threshold = 8;
      if (isHome && hero) {
        // Switch just before the hero fully scrolls out from under the header.
        threshold = hero.offsetHeight - header.offsetHeight;
      }
      header.classList.toggle('is-scrolled', window.scrollY > threshold);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
  }

  /* ----- Hero decorative background video ----------------------------- */
  // Full-bleed particle video behind the hero. It autoplays (muted) via the
  // markup; this just nudges play() for browsers that need it, and honours
  // prefers-reduced-motion by pausing so the static gradient/poster shows.
  const heroVideo = document.querySelector('.hero__video');
  if (heroVideo) {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduce && reduce.matches) {
      try { heroVideo.pause(); heroVideo.removeAttribute('autoplay'); } catch (e) { /* noop */ }
    } else {
      const attempt = heroVideo.play && heroVideo.play();
      if (attempt && typeof attempt.catch === 'function') { attempt.catch(function () { /* autoplay blocked — poster/gradient stays */ }); }
    }
  }

  /* ----- Contact form → POST to /api/contact -------------------------- */
  // The form submits to our own endpoint, which stores the message and (if a mail
  // provider is configured) forwards it to the support inbox. If the request fails
  // we fall back to opening the visitor's email client (mailto) so the message is
  // never lost.
  const form = document.querySelector('[data-contact-form]');
  const note = document.querySelector('[data-form-note]');
  if (form) {
    const get = function (name) {
      const el = form.elements[name];
      return el ? String(el.value || '').trim() : '';
    };
    const setNote = function (msg, isError) {
      if (!note) return;
      note.hidden = false;
      note.textContent = msg;
      note.classList.toggle('is-error', !!isError);
    };
    const mailtoFallback = function (reason, name, email, message) {
      const to = form.getAttribute('data-contact-email') || '';
      const subject = '[Advance Office Doc] ' + reason;
      const body = 'Name: ' + name + '\nEmail: ' + email + '\nReason: ' + reason + '\n\n' + message + '\n';
      window.location.href = 'mailto:' + encodeURIComponent(to) +
        '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    };

    // Live character counter for the message field (premium contact form).
    const messageEl = form.elements['message'];
    const countEl = form.querySelector('[data-char-count]');
    if (messageEl && countEl) {
      const updateCount = function () { countEl.textContent = String((messageEl.value || '').length); };
      messageEl.addEventListener('input', updateCount);
      form.addEventListener('reset', function () { window.setTimeout(updateCount, 0); });
      updateCount();
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }

      const reason = get('reason') || 'General question';
      const name = get('name');
      const email = get('email');
      const message = get('message');
      const company = get('company'); // honeypot (hidden)

      const btn = form.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Sending…'; }
      setNote('Sending your message…', false);

      fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, email: email, reason: reason, message: message, company: company }),
      })
        .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
        .then(function (r) {
          if (!r.ok) throw new Error((r.data && r.data.error) || 'Request failed.');
          setNote('Thanks! Your message has been sent — we’ll get back to you soon.', false);
          form.reset();
        })
        .catch(function () {
          // Network / server problem → don't lose the message: open their mail app.
          setNote('We couldn’t send it here — opening your email app instead…', true);
          mailtoFallback(reason, name, email, message);
        })
        .finally(function () {
          if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Send message'; }
        });
    });
  }
})();
