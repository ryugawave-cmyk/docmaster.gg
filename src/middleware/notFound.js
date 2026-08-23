'use strict';

/**
 * Catch-all 404 handler.
 *
 * Reached only when no earlier route matched. Creates an error with a 404
 * status and forwards it to the central error handler so all error rendering
 * lives in one place.
 */
module.exports = function notFound(req, res, next) {
  const error = new Error(`Page not found: ${req.originalUrl}`);
  error.status = 404;
  next(error);
};
