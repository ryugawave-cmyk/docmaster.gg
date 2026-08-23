'use strict';

/**
 * Install DocMaster as a real Windows service (equivalent to NSSM/PM2).
 *
 * Uses `node-windows`, which wraps the server in a Windows service that:
 *   - starts automatically at boot (before login),
 *   - runs with no console window,
 *   - auto-restarts if the process crashes,
 *   - is managed from services.msc / `sc` like any other service.
 *
 * REQUIRES ADMINISTRATOR. Run via `scripts/install-service-as-admin.cmd`
 * (right-click → Run as administrator), or from an elevated terminal:
 *   node scripts/service-install.js
 */
const path = require('path');

let Service;
try {
  ({ Service } = require('node-windows'));
} catch {
  console.error('\n[!] node-windows is not installed. Run:  npm install\n');
  process.exit(1);
}

const svc = new Service({
  name: 'DocMaster',
  description: 'DocMaster — unified PDF & document workspace server (http://localhost:3210).',
  script: path.join(__dirname, '..', 'src', 'server.js'),
  // Passed to the service process so it binds the intended port.
  env: [
    { name: 'PORT', value: '3210' },
    { name: 'NODE_ENV', value: 'production' },
  ],
  // Restart policy (node-windows/winsw): quick, bounded backoff on crash.
  wait: 2,
  grow: 0.25,
  maxRestarts: 100,
});

svc.on('install', () => {
  console.log('[✓] Service "DocMaster" installed. Starting…');
  svc.start();
});
svc.on('alreadyinstalled', () => console.log('[i] Service "DocMaster" is already installed.'));
svc.on('start', () => console.log('[✓] DocMaster is running as a service on http://localhost:3210'));
svc.on('error', (e) => console.error('[!] Service error:', e));

console.log('Installing the DocMaster Windows service (requires administrator)…');
svc.install();
