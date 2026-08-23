/**
 * Alvion Office — client-side interactions.
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

  /* ----- Contact form → compose email --------------------------------- */
  // No backend inbox exists, so the form opens the visitor's email client with
  // their message pre-filled and addressed to our support inbox. This is a real,
  // working contact path with no server-side data collection.
  const form = document.querySelector('[data-contact-form]');
  const note = document.querySelector('[data-form-note]');
  if (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      const to = form.getAttribute('data-contact-email') || '';
      const get = function (name) {
        const el = form.elements[name];
        return el ? String(el.value || '').trim() : '';
      };

      const reason = get('reason') || 'Message';
      const name = get('name');
      const email = get('email');
      const message = get('message');

      const subject = '[Alvion Office] ' + reason;
      const body =
        'Name: ' + name + '\n' +
        'Email: ' + email + '\n' +
        'Reason: ' + reason + '\n\n' +
        message + '\n';

      const href =
        'mailto:' + encodeURIComponent(to) +
        '?subject=' + encodeURIComponent(subject) +
        '&body=' + encodeURIComponent(body);

      if (note) note.hidden = false;
      window.location.href = href;
    });
  }
})();
