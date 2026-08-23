# Running DocMaster in the background (Windows)

DocMaster serves on **http://localhost:3210** (port 3000 is used by another local
app; see `.env`). There are two ways to keep it running without an open terminal.

## A. Hidden auto-start (no admin required) — active now

A Scheduled Task named **DocMaster** launches `scripts/run-hidden.vbs` at logon.
That VBScript runs the Node server **with no console window** and relaunches it a
few seconds after any exit, so it **auto-restarts on crash**. It keeps serving
until you explicitly stop it.

| Action | Command |
| --- | --- |
| Start now / re-enable | `scripts\start-docmaster.cmd` |
| Stop & disable autostart | `scripts\stop-docmaster.cmd` |
| Status | `schtasks /Query /TN DocMaster` |

Limitations vs a real service: it starts at **logon** (not pre-login boot) and it
is a scheduled task, not an entry in `services.msc`. For a single-user machine
this behaves the same in practice.

## B. Real Windows service (needs Administrator + internet, one time)

Installs a proper service (boot start, no console, auto-restart, managed from
`services.msc`) using [`node-windows`](https://github.com/coreybutler/node-windows)
— the npm equivalent of NSSM/PM2.

1. On a machine **with internet**, install the tooling once:
   ```
   npm install
   ```
   (adds `node-windows`; it was not bundled because this machine had no npm
   network access at setup time.)
2. Install the service — **right-click → Run as administrator**:
   ```
   scripts\install-service-as-admin.cmd
   ```
   or from an elevated terminal: `npm run service:install`
3. Manage it like any service:
   ```
   sc start DocMaster
   sc stop DocMaster
   ```
   Remove it: `npm run service:uninstall` (elevated).

> Your current Windows account (`ryuga`) is **not an administrator**, so option B
> requires either granting that account admin rights or running the installer
> from an administrator account. Option A needs no admin and is already running.

If you switch to option B, first stop option A so they don't both bind 3210:
`scripts\stop-docmaster.cmd`.
