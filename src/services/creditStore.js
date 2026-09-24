'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const creditsConfig = require('../config/credits');

/**
 * Credit store — durable persistence for balances and the audit ledger.
 *
 * There is no SQL database in this project yet, so — exactly like the contact
 * backend — we persist to files under `data/`:
 *   • credit-balances.json  — current balance/plan/period per user (the "wallet").
 *   • credit-ledger.jsonl   — append-only audit log, one JSON object per line
 *                             (every grant, debit, refund — never mutated).
 *
 * This module is the ONLY place that touches those files. It exposes a small
 * repository-style API so the storage can later be swapped for Postgres/Supabase
 * or Cloudflare KV without changing the middleware or controllers.
 *
 * Concurrency note: the dev server is single-process, so synchronous read/modify/
 * write is safe and simple here. A multi-instance deployment would move this to a
 * transactional store (the API surface is intentionally small so that's easy).
 */

// Storage location. Defaults to the project's data/ dir (like the contact store);
// CREDIT_DATA_DIR overrides it (used by tests for isolation, and handy for deploys).
const STORE_DIR = process.env.CREDIT_DATA_DIR
  ? path.resolve(process.env.CREDIT_DATA_DIR)
  : path.resolve(__dirname, '..', '..', 'data');
const BALANCES_FILE = path.join(STORE_DIR, 'credit-balances.json');
const LEDGER_FILE = path.join(STORE_DIR, 'credit-ledger.jsonl');

function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

/** A human-readable period label for the audit ledger, e.g. "2026-09-24" (UTC). */
function currentPeriod(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// The rolling reset window in milliseconds (default 3 days). Balances refill to
// the plan allotment once this much time has passed since the last grant/reset.
const RESET_MS = creditsConfig.RESET_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
const nextResetAt = (from = Date.now()) => new Date(from + RESET_MS).toISOString();

// ---- Balances (the wallet) ------------------------------------------------

function readBalances() {
  try {
    if (!fs.existsSync(BALANCES_FILE)) return {};
    return JSON.parse(fs.readFileSync(BALANCES_FILE, 'utf8')) || {};
  } catch (err) {
    console.error('[credits] failed to read balances:', err.message);
    return {};
  }
}

function writeBalances(map) {
  try {
    ensureDir();
    fs.writeFileSync(BALANCES_FILE, JSON.stringify(map, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[credits] failed to write balances:', err.message);
    return false;
  }
}

// ---- Ledger (append-only audit log) ---------------------------------------

/**
 * Append one audit record. Records are never edited after the fact, so a full
 * transaction (with token usage + estimated cost) is written once, after the AI
 * call resolves. Returns the stored record (with its id + timestamp).
 */
function appendLedger(entry) {
  const record = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    ...entry,
  };
  try {
    ensureDir();
    fs.appendFileSync(LEDGER_FILE, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    // A logging failure must never break the user's request — the balance change
    // has already been persisted; we just lose one audit line.
    console.error('[credits] failed to append ledger:', err.message);
  }
  return record;
}

/** Read the whole ledger (newest first). Small-scale; fine for file storage. */
function readLedger() {
  try {
    if (!fs.existsSync(LEDGER_FILE)) return [];
    return fs.readFileSync(LEDGER_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .reverse();
  } catch (err) {
    console.error('[credits] failed to read ledger:', err.message);
    return [];
  }
}

// ---- Account API ----------------------------------------------------------

/**
 * Fetch (or create) a user's account, applying the rolling reset lazily.
 *
 * A new user is seeded with the plan allotment and a reset time RESET_INTERVAL_DAYS
 * in the future. On any access after that time the balance refills to the allotment
 * and the window rolls forward — so "25 credits, reset every 3 days" holds per user
 * without a scheduled job (a user who burns all 25 in an hour waits until their
 * reset time; then they're topped back up to 25).
 *
 * @returns {{userId:string, email:string, plan:string, credits:number, period:string, resetAt:string, updatedAt:string}}
 */
function getAccount(userId, email) {
  const map = readBalances();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  let acct = map[userId];

  if (!acct) {
    // Brand-new user (e.g. just signed in with Google): seed the plan allotment.
    const plan = creditsConfig.getPlan(creditsConfig.DEFAULT_PLAN);
    acct = {
      userId,
      email: email || '',
      plan: plan.key,
      credits: plan.monthlyCredits,
      period: currentPeriod(),
      resetAt: nextResetAt(now),
      updatedAt: nowIso,
    };
    map[userId] = acct;
    writeBalances(map);
    appendLedger({ type: 'grant', userId, email: acct.email, plan: acct.plan, amount: acct.credits, reason: 'signup', period: acct.period });
    return acct;
  }

  // Keep the stored email fresh (users can change it upstream).
  if (email && acct.email !== email) { acct.email = email; map[userId] = acct; writeBalances(map); }

  // Rolling reset: refill when the window has elapsed. Accounts created before this
  // field existed (no `resetAt`) are migrated by refilling once and starting a window.
  const due = acct.resetAt ? Date.parse(acct.resetAt) : 0;
  if (!acct.resetAt || !Number.isFinite(due) || now >= due) {
    const plan = creditsConfig.getPlan(acct.plan);
    acct.credits = plan.monthlyCredits;
    acct.period = currentPeriod();
    acct.resetAt = nextResetAt(now);
    acct.updatedAt = nowIso;
    map[userId] = acct;
    writeBalances(map);
    appendLedger({ type: 'grant', userId, email: acct.email, plan: acct.plan, amount: plan.monthlyCredits, reason: 'periodic_reset', period: acct.period });
  }

  return acct;
}

/** Change a user's plan (does not retroactively change the current balance). */
function setPlan(userId, planKey) {
  const map = readBalances();
  const acct = map[userId];
  if (!acct) return null;
  acct.plan = creditsConfig.getPlan(planKey).key;
  acct.updatedAt = new Date().toISOString();
  writeBalances(map);
  return acct;
}

/**
 * Deduct credits from a user's balance. Assumes the caller already verified the
 * balance is sufficient, but guards against going negative anyway.
 * @returns {{ok:boolean, credits:number}} the new balance.
 */
function deduct(userId, amount) {
  const map = readBalances();
  const acct = map[userId];
  if (!acct) return { ok: false, credits: 0 };
  if (acct.credits < amount) return { ok: false, credits: acct.credits };
  acct.credits -= amount;
  acct.updatedAt = new Date().toISOString();
  writeBalances(map);
  return { ok: true, credits: acct.credits };
}

/** Return credits to a user's balance (used to refund a failed AI request). */
function refund(userId, amount) {
  const map = readBalances();
  const acct = map[userId];
  if (!acct) return { ok: false, credits: 0 };
  acct.credits += amount;
  acct.updatedAt = new Date().toISOString();
  writeBalances(map);
  return { ok: true, credits: acct.credits };
}

/** All accounts as an array (for the admin dashboard). */
function allAccounts() {
  return Object.values(readBalances());
}

module.exports = {
  currentPeriod,
  getAccount,
  setPlan,
  deduct,
  refund,
  appendLedger,
  readLedger,
  allAccounts,
  // exposed for tests / tooling
  _paths: { BALANCES_FILE, LEDGER_FILE },
};
