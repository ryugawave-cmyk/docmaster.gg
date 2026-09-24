/**
 * Verification (white-box, network-free) — the WORKER credit port (KV-backed).
 *
 * Exercises worker/credits.js against an in-memory KV stub: signup seed, deduction,
 * insufficient-credit block, refund, and the rolling 3-day reset. Mirrors
 * verify-credits.mjs (the Express file store) so both stay in step.
 *
 * Run: `node scripts/verify-worker-credits.mjs`
 */
import * as credits from '../worker/credits.js';

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}${extra != null ? ` (${extra})` : ''}`); failures += 1; }
};

// In-memory KV stub (get/put like Cloudflare KV).
function fakeKV() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); }, _m: m };
}
const env = { CREDITS_KV: fakeKV() };
const user = { id: 'wtester', email: 'w@example.com' };

// --- Config parity ---------------------------------------------------------
check('reset interval is 3 days', credits.RESET_INTERVAL_DAYS === 3, credits.RESET_INTERVAL_DAYS);
check('Free plan = 25', credits.getPlan('free').monthlyCredits === 25);
check('cost(story) = 5', credits.getActionCost('story_writing') === 5);
const rScript = credits.resolveTask({ prompt: 'write a 5 page horror script' });
check('resolve: script bills 7', rScript.ok && rScript.action === 'script_writing' && rScript.cost === 7, JSON.stringify(rScript));
const rSpoof = credits.resolveTask({ prompt: 'write a horror script', action: 'grammar_correction' });
check('resolve: cheap hint cannot underpay', rSpoof.cost === 7, rSpoof.cost);
check('creditInfo has 4 groups', credits.creditInfo().groups.length === 4);

// --- Seed + deduction (persisted to KV) -----------------------------------
const acct = await credits.getAccount(env, user.id, user.email);
check('signup seeds 25 + future resetAt', acct.credits === 25 && Date.parse(acct.resetAt) > Date.now(), JSON.stringify({ c: acct.credits, r: acct.resetAt }));

const r1 = await credits.reserve(env, user, 'article_writing'); // 3
check('reserve deducts up front', r1.ok && r1.balanceAfter === 22, JSON.stringify(r1));
const reread = await credits.getAccount(env, user.id, user.email);
check('deduction persists in KV', reread.credits === 22, reread.credits);

const bal = await credits.finalize(env, user, { action: r1.action, cost: r1.cost, model: 'gemini-2.5-flash', usage: { promptTokens: 1000, outputTokens: 500 } });
check('finalize returns remaining balance', bal === 22, bal);
check('finalize wrote a debit ledger entry', [...env.CREDITS_KV._m.keys()].some((k) => k.startsWith('cledger:')));

// --- Insufficient credits blocks ------------------------------------------
for (let i = 0; i < 5; i += 1) await credits.reserve(env, user, 'essay_writing'); // 22 -> 2
const blocked = await credits.reserve(env, user, 'presentation_content'); // needs 8, have 2
check('insufficient credits are blocked (402)', blocked.ok === false && blocked.status === 402 && blocked.code === 'INSUFFICIENT_CREDITS', JSON.stringify(blocked));
check('blocked request did NOT deduct', (await credits.getAccount(env, user.id)).credits === 2, (await credits.getAccount(env, user.id)).credits);
check('block message mentions 3 days', /3 days/.test(blocked.error), blocked.error);

// --- Refund on failure -----------------------------------------------------
const r2 = await credits.reserve(env, user, 'grammar_correction'); // 2 -> 1
const afterRefund = await credits.refundFailed(env, user, { action: r2.action, cost: r2.cost }, 'ai_request_failed');
check('refund restores the balance', afterRefund === 2, afterRefund);

// --- Rolling 3-day reset ---------------------------------------------------
const raw = JSON.parse(await env.CREDITS_KV.get(`credit:${user.id}`));
raw.resetAt = new Date(Date.now() - 1000).toISOString(); // force the window elapsed
await env.CREDITS_KV.put(`credit:${user.id}`, JSON.stringify(raw));
const afterReset = await credits.getAccount(env, user.id, user.email);
check('balance refills to 25 once the 3-day window elapses', afterReset.credits === 25, afterReset.credits);
check('reset rolls the window forward', Date.parse(afterReset.resetAt) > Date.now(), afterReset.resetAt);

// --- Legacy account (no resetAt) migrates ----------------------------------
await env.CREDITS_KV.put(`credit:${user.id}`, JSON.stringify({ userId: user.id, email: 'w@example.com', plan: 'free', credits: 3 }));
const migrated = await credits.getAccount(env, user.id, user.email);
check('legacy account refills + gains a window', migrated.credits === 25 && !!migrated.resetAt, JSON.stringify({ c: migrated.credits, r: migrated.resetAt }));

// --- No-KV degrade (AI still answers, credits just don't persist) ----------
const acctNoKv = await credits.getAccount({}, 'nokv', 'n@e.com');
check('without KV: still returns a seeded account', acctNoKv.credits === 25, acctNoKv.credits);

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll worker credit-port checks passed.');
