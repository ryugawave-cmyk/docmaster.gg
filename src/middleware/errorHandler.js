'use strict';

const config = require('../config');

/**
 * Centralized error-handling middleware.
 *
 * Renders a friendly 404 page for missing routes and a generic 500 page for
 * everything else. Stack traces are only exposed outside of production.
 */
module.exports = function errorHandler(err, req, res, next) {
  const status = err.status || 500;

  if (status >= 500) {
    // Log server errors for observability; keep 4xx quiet.
    console.error(`[${status}] ${req.method} ${req.originalUrl}`, err);
  }

  // If the response has already started, defer to Express's default handler.
  if (res.headersSent) {
    return next(err);
  }

  res.status(status);

  const view = status === 404 ? 'errors/404' : 'errors/500';

  res.render(
    view,
    {
      pageTitle: status === 404 ? 'Page not found' : 'Something went wrong',
      metaDescription: 'An error occurred while loading this page.',
      status,
      message: err.message,
      stack: config.isProduction ? null : err.stack,
    },
    (renderErr, html) => {
      // Last-resort fallback so a broken template never crashes the response.
      if (renderErr) {
        console.error('Error page failed to render:', renderErr);
        return res.type('text/plain').send(`${status} — ${err.message}`);
      }
      res.send(html);
    }
  );
};
