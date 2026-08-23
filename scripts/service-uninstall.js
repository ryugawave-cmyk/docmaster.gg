'use strict';

/**
 * Remove the DocMaster Windows service. REQUIRES ADMINISTRATOR.
 *   node scripts/service-uninstall.js
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
  script: path.join(__dirname, '..', 'src', 'server.js'),
});

svc.on('uninstall', () => console.log('[✓] DocMaster service uninstalled.'));
svc.on('error', (e) => console.error('[!] Service error:', e));

console.log('Uninstalling the DocMaster Windows service (requires administrator)…');
svc.uninstall();
