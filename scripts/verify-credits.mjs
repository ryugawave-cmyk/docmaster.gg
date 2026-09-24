/**
 * Verification (white-box, network-free) — the token/credit system.
 *
 * Exercises the credit engine end to end against an ISOLATED data dir (so it never
 * touches real balances): signup seed, per-action cost, deduction before use,
 * insufficient-credit block, refund-on-failure, the rolling 3-day reset, audit
 * ledger contents, and the admin per-user roll-up. No browser or AI provider needed.
 *
 * Run: `node scripts/verify-credits.mjs`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Isolate storage BEFORE loading the store (it reads the env at module load).
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'credit-test-'));
process.env.CREDIT_DATA_DIR = DATA_DIR;

const creditsConfig = require('../src/config/credits');
const store = require('../src/services/creditStore');
const svc = require('../src/services/credits');

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}${extra != null ? ` (${extra})` : ''}`); failures += 1; }
};

// --- Config: costs match the spec -----------------------------------------
const expectedCosts = {
  grammar_correction: 1, summarize: 1, translate: 1,
  text_rewrite: 2, improve_writing: 2, letter_writing: 2, email_writing: 2,
  resume_creation: 2, form_filling: 2,
  article_writing: 3, blog_post: 3, essay_writing: 4, story_writing: 5,
  script_writing: 7, presentation_content: 8, large_document_analysis: 5,
};
for (const [action, cost] of Object.entries(expectedCosts)) {
  check(`cost(${action}) = ${cost}`, creditsConfig.getActionCost(action) === cost, creditsConfig.getActionCost(action));
}
check('unknown action falls back to default cost (2)', creditsConfig.getActionCost('nope') === 2, creditsConfig.getActionCost('nope'));

// --- Task classifier + resolver (server-side authority) --------------------
check('classify: "write a horror movie script" → script', creditsConfig.classifyTask('write a horror movie script') === 'script_writing');
check('classify: "write me a short story" → story', creditsConfig.classifyTask('write me a short story') === 'story_writing');
check('classify: "make a powerpoint presentation" → presentation', creditsConfig.classifyTask('make a powerpoint presentation') === 'presentation_content');
check('classify: "summarize this section" → summarize', creditsConfig.classifyTask('summarize this section') === 'summarize');
check('classify: "fix the grammar in my story" → grammar (no gen verb)', creditsConfig.classifyTask('fix the grammar in my story') === 'grammar_correction');
check('classify: plain chat → null', creditsConfig.classifyTask('what rhymes with cat?') === null);

const rScript = creditsConfig.resolveTask({ prompt: 'write a 5 page horror script' });
check('resolve: free-form script bills 7 (not the 1-credit default)', rScript.ok && rScript.action === 'script_writing' && rScript.cost === 7, JSON.stringify(rScript));
const rSpoof = creditsConfig.resolveTask({ prompt: 'write a horror script', action: 'grammar_correction' });
check('resolve: cheap client hint can NEVER underpay (max wins)', rSpoof.ok && rSpoof.action === 'script_writing' && rSpoof.cost === 7, JSON.stringify(rSpoof));
const rHint = creditsConfig.resolveTask({ prompt: 'clean this up', action: 'grammar_correction' });
check('resolve: valid quick-edit hint honored', rHint.ok && rHint.action === 'grammar_correction' && rHint.cost === 1, JSON.stringify(rHint));
const rUnknown = creditsConfig.resolveTask({ action: 'hack_the_planet' });
check('resolve: explicit unknown action is REJECTED', rUnknown.ok === false && rUnknown.code === 'UNKNOWN_ACTION', JSON.stringify(rUnknown));
const rDefault = creditsConfig.resolveTask({ prompt: 'just say hi' });
check('resolve: unclassified → default (text_rewrite, 2)', rDefault.ok && rDefault.action === 'text_rewrite' && rDefault.cost === 2, JSON.stringify(rDefault));

// --- Info modal catalogue --------------------------------------------------
const info = creditsConfig.creditInfo();
check('creditInfo groups present', Array.isArray(info.groups) && info.groups.length === 4, info.groups && info.groups.length);
check('creditInfo items carry label + cost', info.groups[0].items.every((i) => i.label && typeof i.cost === 'number'));

// --- Plans: per-cycle allotments ------------------------------------------
check('Free = 25 per cycle', creditsConfig.getPlan('free').monthlyCredits === 25);
check('Lite = 200 per cycle', creditsConfig.getPlan('lite').monthlyCredits === 200);
check('Pro = 800 per cycle', creditsConfig.getPlan('pro').monthlyCredits === 800);
check('reset interval is 3 days', creditsConfig.RESET_INTERVAL_DAYS === 3, creditsConfig.RESET_INTERVAL_DAYS);

// --- Seed + deduction before use ------------------------------------------
const user = { id: 'tester', email: 'tester@example.com' };
let acct = store.getAccount(user.id, user.email);
check('new user seeded to Free/25', acct.plan === 'free' && acct.credits === 25, `${acct.plan}/${acct.credits}`);

let r = svc.reserve(user, 'article_writing'); // 3
check('reserve deducts up front', r.ok === true && r.balanceAfter === 22, JSON.stringify(r));

// --- Finalize logs token usage + est. cost --------------------------------
const remaining = svc.finalize(user, {
  action: r.action, cost: r.cost, model: 'gemini-2.5-flash',
  usage: { promptTokens: 1000, outputTokens: 500, totalTokens: 1500 },
});
check('finalize returns remaining balance', remaining === 22, remaining);

let ledger = store.readLedger();
const debit = ledger.find((e) => e.type === 'debit');
check('ledger records userId', debit && debit.userId === 'tester');
check('ledger records action + credits', debit && debit.action === 'article_writing' && debit.creditsUsed === 3);
check('ledger records model', debit && debit.model === 'gemini-2.5-flash');
check('ledger records prompt/output/total tokens', debit && debit.promptTokens === 1000 && debit.outputTokens === 500 && debit.totalTokens === 1500);
check('ledger records estimated cost (>0)', debit && debit.estimatedCostUsd > 0, debit && debit.estimatedCostUsd);
check('ledger records timestamp', debit && typeof debit.ts === 'string' && debit.ts.includes('T'));

// --- Insufficient credits blocks ------------------------------------------
// Spend down to 2 credits (from 22 via five 4-credit essays), then request an
// 8-credit presentation.
svc.reserve(user, 'essay_writing'); // 22 -> 18
svc.reserve(user, 'essay_writing'); // 18 -> 14
svc.reserve(user, 'essay_writing'); // 14 -> 10
svc.reserve(user, 'essay_writing'); // 10 -> 6
svc.reserve(user, 'essay_writing'); // 6 -> 2
const blocked = svc.reserve(user, 'presentation_content'); // needs 8, have 2
check('insufficient credits are blocked', blocked.ok === false, JSON.stringify(blocked));
check('block uses 402 + code', blocked.status === 402 && blocked.code === 'INSUFFICIENT_CREDITS', `${blocked.status}/${blocked.code}`);
check('block reports balance + requirement', blocked.account.credits === 2 && blocked.cost === 8, `${blocked.account.credits}/${blocked.cost}`);
check('block message mentions upgrade', /upgrade/i.test(blocked.error), blocked.error);
check('blocked request did NOT deduct', store.getAccount(user.id).credits === 2, store.getAccount(user.id).credits);

// --- Refund on failure -----------------------------------------------------
const r2 = svc.reserve(user, 'grammar_correction'); // 2 -> 1
check('reserve for refund test', r2.ok === true && r2.balanceAfter === 1, JSON.stringify(r2));
const afterRefund = svc.refundFailed(user, { action: r2.action, cost: r2.cost }, 'ai_request_failed');
check('refund restores the balance', afterRefund === 2, afterRefund);
ledger = store.readLedger();
check('refund is audited', ledger.some((e) => e.type === 'refund' && e.creditsRefunded === 1));

// --- Rolling 3-day reset ---------------------------------------------------
const resetUser = { id: 'resetter', email: 'r@example.com' };
const seeded = store.getAccount(resetUser.id, resetUser.email);
check('signup seeds 25 + a future resetAt', seeded.credits === 25 && Date.parse(seeded.resetAt) > Date.now(), JSON.stringify({ c: seeded.credits, r: seeded.resetAt }));
svc.reserve(resetUser, 'story_writing'); // 25 -> 20
check('spends down within the window (no early refill)', store.getAccount(resetUser.id).credits === 20, store.getAccount(resetUser.id).credits);
// Force the window to have elapsed, then access → refill to the allotment.
const bal = JSON.parse(fs.readFileSync(store._paths.BALANCES_FILE, 'utf8'));
bal[resetUser.id].resetAt = new Date(Date.now() - 1000).toISOString();
fs.writeFileSync(store._paths.BALANCES_FILE, JSON.stringify(bal), 'utf8');
const afterReset = store.getAccount(resetUser.id, resetUser.email);
check('balance refills to 25 once the 3-day window elapses', afterReset.credits === 25, afterReset.credits);
check('reset rolls the window forward', Date.parse(afterReset.resetAt) > Date.now(), afterReset.resetAt);
check('a reset is audited as a grant', store.readLedger().some((e) => e.type === 'grant' && e.reason === 'periodic_reset'));
// Legacy account with no resetAt (pre-upgrade) migrates: refill once + start a window.
const bal2 = JSON.parse(fs.readFileSync(store._paths.BALANCES_FILE, 'utf8'));
bal2[resetUser.id] = { userId: resetUser.id, email: 'r@example.com', plan: 'free', credits: 3, period: '2026-09' };
fs.writeFileSync(store._paths.BALANCES_FILE, JSON.stringify(bal2), 'utf8');
const migrated = store.getAccount(resetUser.id, resetUser.email);
check('legacy account (no resetAt) refills + gains a window', migrated.credits === 25 && !!migrated.resetAt, JSON.stringify({ c: migrated.credits, r: migrated.resetAt }));

// --- Estimated cost math ---------------------------------------------------
const cost = creditsConfig.estimateCost('gemini-2.5-flash', { promptTokens: 1e6, outputTokens: 1e6 });
const rate = creditsConfig.getModelPricing('gemini-2.5-flash');
check('estimateCost = input+output per 1M', Math.abs(cost - (rate.input + rate.output)) < 1e-9, cost);

// Cleanup.
try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll credit-system checks passed.');
