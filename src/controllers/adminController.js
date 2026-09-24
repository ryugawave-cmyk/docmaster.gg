'use strict';

const config = require('../config');
const store = require('../services/creditStore');
const creditsConfig = require('../config/credits');
const { isLoopback } = require('../services/authUser');

/**
 * Admin analytics — credit & AI usage per user.
 *
 * Reads the append-only ledger + balances (services/creditStore) and rolls them
 * up per user: credits consumed, token usage, and estimated API cost. Rendered as
 * a plain HTML dashboard at /admin/usage (JSON at /admin/usage.json).
 *
 * Access is gated exactly like the contact inbox: open on localhost (your own dev
 * box), and elsewhere it requires ?token=… / x-admin-token matching ADMIN_TOKEN.
 */

const authed = (req) => {
  if (isLoopback(req)) return true;
  const t = config.admin.token;
  return !!t && (req.query.token === t || req.headers['x-admin-token'] === t);
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const money = (n) => `$${(Number(n) || 0).toFixed(4)}`;
const num = (n) => (Number(n) || 0).toLocaleString();

/**
 * Roll the ledger + balances up into one row per user.
 * @returns {{rows:Array, totals:Object, actions:Object}}
 */
function buildSummary() {
  const ledger = store.readLedger();
  const accounts = store.allAccounts();

  // Seed rows from known accounts so a user with 0 usage still appears.
  const byUser = new Map();
  const seed = (userId, email, plan) => {
    if (!byUser.has(userId)) {
      byUser.set(userId, {
        userId, email: email || '', plan: plan || creditsConfig.DEFAULT_PLAN,
        creditsRemaining: null,
        requests: 0, creditsUsed: 0,
        promptTokens: 0, outputTokens: 0, totalTokens: 0,
        estimatedCostUsd: 0,
        lastActivity: '',
      });
    }
    return byUser.get(userId);
  };

  for (const a of accounts) {
    const row = seed(a.userId, a.email, a.plan);
    row.creditsRemaining = a.credits;
    row.plan = a.plan;
  }

  // Per-action tallies for a secondary breakdown.
  const actionTally = {};

  for (const e of ledger) {
    if (e.type !== 'debit') continue; // grants/refunds don't count as consumption
    const row = seed(e.userId, e.email, e.plan);
    row.requests += 1;
    row.creditsUsed += Number(e.creditsUsed) || 0;
    row.promptTokens += Number(e.promptTokens) || 0;
    row.outputTokens += Number(e.outputTokens) || 0;
    row.totalTokens += Number(e.totalTokens) || 0;
    row.estimatedCostUsd += Number(e.estimatedCostUsd) || 0;
    if (!row.lastActivity || e.ts > row.lastActivity) row.lastActivity = e.ts;
    if (e.email && !row.email) row.email = e.email;

    const key = e.action || 'unknown';
    const t = actionTally[key] || (actionTally[key] = { label: creditsConfig.getActionLabel(key), requests: 0, creditsUsed: 0, totalTokens: 0, estimatedCostUsd: 0 });
    t.requests += 1;
    t.creditsUsed += Number(e.creditsUsed) || 0;
    t.totalTokens += Number(e.totalTokens) || 0;
    t.estimatedCostUsd += Number(e.estimatedCostUsd) || 0;
  }

  const rows = Array.from(byUser.values())
    .sort((a, b) => b.creditsUsed - a.creditsUsed || b.totalTokens - a.totalTokens);

  const totals = rows.reduce((acc, r) => {
    acc.requests += r.requests;
    acc.creditsUsed += r.creditsUsed;
    acc.promptTokens += r.promptTokens;
    acc.outputTokens += r.outputTokens;
    acc.totalTokens += r.totalTokens;
    acc.estimatedCostUsd += r.estimatedCostUsd;
    return acc;
  }, { users: rows.length, requests: 0, creditsUsed: 0, promptTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 });

  return { rows, totals, actions: actionTally };
}

/** JSON summary (for tooling / dashboards). */
exports.usageJson = (req, res) => {
  if (!authed(req)) return res.status(403).json({ error: 'Forbidden. Add ?token=…' });
  return res.json(buildSummary());
};

/** HTML dashboard. */
exports.usage = (req, res) => {
  if (!authed(req)) {
    return res.status(403).type('html').send('<p style="font:16px system-ui;padding:40px">Forbidden. Append <code>?token=YOUR_TOKEN</code> to the URL (set <code>ADMIN_TOKEN</code> in .env).</p>');
  }

  const { rows, totals, actions } = buildSummary();

  const userRows = rows.map((r) => `
      <tr>
        <td>${esc(r.email || r.userId)}<div class="sub">${esc(r.userId)}</div></td>
        <td><span class="plan plan--${esc(r.plan)}">${esc(creditsConfig.getPlan(r.plan).label)}</span></td>
        <td class="n">${r.creditsRemaining == null ? '—' : num(r.creditsRemaining)}</td>
        <td class="n">${num(r.creditsUsed)}</td>
        <td class="n">${num(r.requests)}</td>
        <td class="n">${num(r.promptTokens)}</td>
        <td class="n">${num(r.outputTokens)}</td>
        <td class="n">${num(r.totalTokens)}</td>
        <td class="n">${money(r.estimatedCostUsd)}</td>
        <td class="ts">${esc((r.lastActivity || '').replace('T', ' ').replace(/\..+/, ''))}</td>
      </tr>`).join('');

  const actionRows = Object.entries(actions)
    .sort((a, b) => b[1].creditsUsed - a[1].creditsUsed)
    .map(([, t]) => `
      <tr>
        <td>${esc(t.label)}</td>
        <td class="n">${num(t.requests)}</td>
        <td class="n">${num(t.creditsUsed)}</td>
        <td class="n">${num(t.totalTokens)}</td>
        <td class="n">${money(t.estimatedCostUsd)}</td>
      </tr>`).join('');

  const html = `<!doctype html><meta charset="utf8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AI usage & credits</title>
  <style>
    body{font:15px/1.5 system-ui,Segoe UI,Arial;margin:0;background:#0f1020;color:#e7e7f2}
    header{padding:20px 26px;background:linear-gradient(120deg,#4f2da3,#7c3aed);color:#fff}
    header h1{margin:0;font-size:19px} header p{margin:5px 0 0;opacity:.85;font-size:13px}
    .wrap{padding:22px 26px;max-width:1200px}
    .cards{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:22px}
    .card{background:#1a1b33;border:1px solid #2a2b50;border-radius:12px;padding:14px 18px;min-width:150px}
    .card b{display:block;font-size:22px;color:#fff} .card span{font-size:12px;color:#9a9ac0;text-transform:uppercase;letter-spacing:.04em}
    h2{font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#9a9ac0;margin:26px 0 10px}
    table{width:100%;border-collapse:collapse;background:#16172c;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.3)}
    th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #26264a;vertical-align:top;font-size:13.5px}
    th{background:#20213f;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:#9a9ac0}
    td.n{text-align:right;font-variant-numeric:tabular-nums} th.n{text-align:right}
    td.ts{white-space:nowrap;color:#8a8ab0;font-size:12.5px}
    .sub{color:#7a7aa0;font-size:11.5px;margin-top:2px}
    .plan{padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:600}
    .plan--free{background:#2a2b50;color:#c7c7e6}
    .plan--lite{background:#1f3a5f;color:#9fd0ff}
    .plan--pro{background:#3a2a5f;color:#d6b8ff}
    .empty{padding:40px;text-align:center;color:#8a8ab0}
    tfoot td{font-weight:700;color:#fff;background:#1c1d38}
  </style>
  <header><h1>⚡ AI usage &amp; credits</h1><p>Per-user credit consumption, token usage and estimated API cost · estimates only (no billing)</p></header>
  <div class="wrap">
    <div class="cards">
      <div class="card"><span>Users</span><b>${num(totals.users)}</b></div>
      <div class="card"><span>AI requests</span><b>${num(totals.requests)}</b></div>
      <div class="card"><span>Credits used</span><b>${num(totals.creditsUsed)}</b></div>
      <div class="card"><span>Total tokens</span><b>${num(totals.totalTokens)}</b></div>
      <div class="card"><span>Est. API cost</span><b>${money(totals.estimatedCostUsd)}</b></div>
    </div>

    <h2>Per user</h2>
    ${rows.length ? `<table>
      <thead><tr>
        <th>User</th><th>Plan</th><th class="n">Credits left</th><th class="n">Credits used</th>
        <th class="n">Requests</th><th class="n">Prompt tok</th><th class="n">Output tok</th>
        <th class="n">Total tok</th><th class="n">Est. cost</th><th>Last activity</th>
      </tr></thead>
      <tbody>${userRows}</tbody>
      <tfoot><tr>
        <td>Totals</td><td></td><td class="n">—</td><td class="n">${num(totals.creditsUsed)}</td>
        <td class="n">${num(totals.requests)}</td><td class="n">${num(totals.promptTokens)}</td>
        <td class="n">${num(totals.outputTokens)}</td><td class="n">${num(totals.totalTokens)}</td>
        <td class="n">${money(totals.estimatedCostUsd)}</td><td></td>
      </tr></tfoot>
    </table>` : '<div class="empty">No usage recorded yet.</div>'}

    ${actionRows ? `<h2>Per action</h2>
    <table>
      <thead><tr><th>Action</th><th class="n">Requests</th><th class="n">Credits used</th><th class="n">Total tokens</th><th class="n">Est. cost</th></tr></thead>
      <tbody>${actionRows}</tbody>
    </table>` : ''}
  </div>`;

  return res.type('html').send(html);
};
