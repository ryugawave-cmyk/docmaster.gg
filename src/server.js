'use strict';

const createApp = require('./app');
const config = require('./config');

/**
 * Application entry point.
 * Creates the Express app and starts the HTTP server.
 */
const app = createApp();

const server = app.listen(config.server.port, () => {
  const { port, host } = config.server;
  console.log('');
  console.log(`  ${config.site.name} is running`);
  console.log(`  ➜  Local:   http://${host}:${port}`);
  console.log(`  ➜  Env:     ${config.env}`);
  console.log('');
});

// ----- Graceful shutdown ---------------------------------------------------
function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });

  // Force-exit if connections don't drain in time.
  setTimeout(() => process.exit(1), 10000).unref();
}

['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => shutdown(signal));
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

module.exports = server;
