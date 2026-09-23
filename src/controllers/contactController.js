'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * Contact form backend (local / Express).
 *
 * The public contact form POSTs { name, email, reason, message } here. Every valid
 * submission is:
 *   1. stored durably by appending one JSON line to data/contact-messages.jsonl
 *      (so nothing is ever lost, even if email delivery fails), and
 *   2. forwarded to the owner's inbox IF an email provider is configured
 *      (Web3Forms or Resend — see config.contact). Email is best-effort: a
 *      provider hiccup never fails the request, because the message is stored.
 *
 * A hidden honeypot field ("company") traps bots; a tiny in-memory rate limit
 * curbs abuse. No secrets ever reach the browser.
 */

const STORE_DIR = path.resolve(__dirname, '..', '..', 'data');
const STORE_FILE = path.join(STORE_DIR, 'contact-messages.jsonl');

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const clip = (s, n) => String(s || '').trim().slice(0, n);

// Very small in-memory rate limit: max 5 submissions per IP per 10 minutes. Fine
// for a single-process dev server; the Worker has its own guard.
const HITS = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const win = 10 * 60 * 1000;
  const arr = (HITS.get(ip) || []).filter((t) => now - t < win);
  arr.push(now);
  HITS.set(ip, arr);
  return arr.length > 5;
}

function persist(record) {
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.appendFileSync(STORE_FILE, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch (err) {
    console.error('[contact] failed to store message:', err.message);
    return false;
  }
}

/** Forward the message to the owner's inbox via whichever provider is configured.
 *  Returns true if an email was sent, false if none is configured / it failed. */
async function forwardEmail(record) {
  const c = config.contact;
  const subject = `[Advance Office Doc] ${record.reason} — ${record.name}`;
  const text = [
    `Name: ${record.name}`,
    `Email: ${record.email}`,
    `Reason: ${record.reason}`,
    `Time: ${record.ts}`,
    '',
    record.message,
  ].join('\n');

  try {
    if (c.web3formsKey) {
      const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          access_key: c.web3formsKey,
          subject,
          from_name: record.name,
          replyto: record.email,
          email: record.email,
          message: text,
        }),
      });
      return res.ok;
    }
    if (c.resendApiKey) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.resendApiKey}` },
        body: JSON.stringify({
          from: c.resendFrom,
          to: [c.to],
          reply_to: record.email,
          subject,
          text,
        }),
      });
      return res.ok;
    }
  } catch (err) {
    console.error('[contact] email forward failed:', err.message);
  }
  return false;
}

/** Read all stored messages, newest first. */
function readAll() {
  try {
    if (!fs.existsSync(STORE_FILE)) return [];
    return fs.readFileSync(STORE_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .reverse();
  } catch (err) {
    console.error('[contact] failed to read messages:', err.message);
    return [];
  }
}

const isLoopback = (req) => {
  const ip = (req.ip || '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
};
const authed = (req) => {
  if (isLoopback(req)) return true; // your own machine (dev)
  const t = config.contact.adminToken;
  return !!t && (req.query.token === t || req.headers['x-admin-token'] === t);
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** JSON list of stored messages (for tooling). */
exports.list = (req, res) => {
  if (!authed(req)) return res.status(403).json({ error: 'Forbidden. Add ?token=…' });
  return res.json({ messages: readAll() });
};

/** A simple HTML inbox to READ submissions in the browser. */
exports.inbox = (req, res) => {
  if (!authed(req)) {
    return res.status(403).type('html').send('<p style="font:16px system-ui;padding:40px">Forbidden. Append <code>?token=YOUR_TOKEN</code> to the URL (set <code>CONTACT_ADMIN_TOKEN</code> in .env).</p>');
  }
  const msgs = readAll();
  const rows = msgs.map((m) => `
      <tr>
        <td class="ts">${esc((m.ts || '').replace('T', ' ').replace(/\..+/, ''))}</td>
        <td>${esc(m.name)}<br><a href="mailto:${esc(m.email)}">${esc(m.email)}</a></td>
        <td>${esc(m.reason)}</td>
        <td class="msg">${esc(m.message)}</td>
      </tr>`).join('');
  const html = `<!doctype html><meta charset="utf8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Contact inbox (${msgs.length})</title>
  <style>
    body{font:15px/1.5 system-ui,Segoe UI,Arial;margin:0;background:#f6f7fb;color:#111}
    header{padding:18px 24px;background:#4f46e5;color:#fff}
    header h1{margin:0;font-size:18px} header p{margin:4px 0 0;opacity:.85;font-size:13px}
    .wrap{padding:20px 24px}
    table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06)}
    th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eef;vertical-align:top}
    th{background:#f0f1f8;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#555}
    td.ts{white-space:nowrap;color:#666;font-size:13px} td.msg{white-space:pre-wrap;max-width:520px}
    .empty{padding:40px;text-align:center;color:#777}
  </style>
  <header><h1>📨 Contact inbox</h1><p>${msgs.length} message${msgs.length === 1 ? '' : 's'} · stored in data/contact-messages.jsonl · newest first</p></header>
  <div class="wrap">
    ${msgs.length ? `<table><thead><tr><th>When</th><th>From</th><th>Reason</th><th>Message</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No messages yet.</div>'}
  </div>`;
  return res.type('html').send(html);
};

exports.submit = async (req, res) => {
  const b = req.body || {};
  // Honeypot: real users never fill this hidden field.
  if (clip(b.company, 100)) return res.json({ ok: true });

  const name = clip(b.name, 120);
  const email = clip(b.email, 200);
  const reason = clip(b.reason, 80) || 'General question';
  const message = clip(b.message, 8000);
  if (!name || !isEmail(email) || !message) {
    return res.status(400).json({ error: 'Please provide your name, a valid email, and a message.' });
  }

  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Too many messages — please try again a little later.' });
  }

  const record = {
    ts: new Date().toISOString(),
    name, email, reason, message,
    ip,
    ua: clip(req.headers['user-agent'], 300),
  };

  const stored = persist(record);
  const emailed = await forwardEmail(record);
  if (!stored && !emailed) {
    return res.status(500).json({ error: 'Could not deliver your message. Please email us directly.' });
  }
  return res.json({ ok: true, emailed });
};
