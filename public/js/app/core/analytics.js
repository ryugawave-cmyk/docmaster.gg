/**
 * GA4 event tracking — a tiny, safe wrapper around gtag.
 *
 * The Google tag (gtag.js) is loaded globally in the page <head> (see
 * views/partials/analytics.ejs), so `window.gtag` exists on both the marketing
 * pages and the workspace SPA. This module is the ONE place the app calls it, so
 * event names/params stay consistent and a missing/blocked tag can never throw.
 *
 * Events emitted by the app (all fire at most once per user action — never on a
 * page refresh, since a refresh reboots the SPA to Home and takes no action):
 *   - editor_open     when a PDF/Document editor becomes active
 *   - pdf_convert     when the PDF editor exports/converts a file
 *   - document_export when the Document editor exports a file
 *   - ai_request      when the user sends an AI request
 * (sign_up / login are fired from the marketing auth flow in public/js/auth.js.)
 */

/**
 * Send a GA4 event. Never throws — analytics must not break the app.
 * @param {string} name   GA4 event name (snake_case)
 * @param {object} [params] event parameters
 */
export function trackEvent(name, params) {
  if (!name) return;
  try {
    if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
      window.gtag('event', name, params || {});
    }
  } catch {
    /* a blocked or absent tag must never surface to the user */
  }
}
