/**
 * Credit/token system for the Cloudflare Worker (production).
 *
 * A KV-backed port of the Express credit system (src/config/credits.js +
 * src/services/credits.js + src/services/creditStore.js). The PRICING/RULES below
 * MUST stay in sync with src/config/credits.js — keep both in step when tuning.
 *
 * Storage: one KV key per user (`credit:<userId>` → account JSON) in env.CREDITS_KV,
 * plus a best-effort append-only ledger (`cledger:<ts>:<rand>`) for the admin view.
 * KV read-modify-write is not transactional, but a single user rarely fires two AI
 * requests in the same instant, so the deduct race window is negligible in practice.
 */

/* --------------------------- pricing + rules (mirror) --------------------- */
export const ACTION_COSTS = {
  grammar_correction: 1, summarize: 1, translate: 1,
  text_rewrite: 2, improve_writing: 2,
  letter_writing: 2, email_writing: 2, resume_creation: 2, form_filling: 2,
  article_writing: 3, blog_post: 3, essay_writing: 4, story_writing: 5,
  script_writing: 7, presentation_content: 8, large_document_analysis: 5,
};

const ACTION_LABELS = {
  grammar_correction: 'Grammar Correction', summarize: 'Summarize', translate: 'Translate',
  text_rewrite: 'Rewrite', improve_writing: 'Improve Writing', letter_writing: 'Letter',
  email_writing: 'Email', resume_creation: 'Resume / CV', form_filling: 'Form Filling',
  article_writing: 'Article', blog_post: 'Blog Post', essay_writing: 'Essay', story_writing: 'Story',
  script_writing: 'Script', presentation_content: 'Presentation / PPT', large_document_analysis: 'Large Document Analysis',
};

const CREDIT_GROUPS = [
  { title: 'Quick Edits', items: ['grammar_correction', 'summarize', 'text_rewrite', 'improve_writing'] },
  { title: 'Content Creation', items: ['letter_writing', 'email_writing', 'resume_creation'] },
  { title: 'Long Content', items: ['article_writing', 'essay_writing', 'story_writing'] },
  { title: 'Advanced AI', items: ['script_writing', 'presentation_content', 'large_document_analysis'] },
];

const DEFAULT_ACTION = 'text_rewrite';
const GEN_VERBS = /\b(write|create|generate|draft|compose|make|produce|prepare|build|give me|need|want)\b/;

const CONTENT_PATTERNS = [
  { action: 'presentation_content', re: /\b(presentation|power\s?point|ppt|slide\s?deck|slides?)\b/ },
  { action: 'script_writing', re: /\b(script|screen\s?play|teleplay|stage\s?play|movie|screenwriting)\b/ },
  { action: 'story_writing', re: /\b(story|short\s?story|novel|fiction|fairy\s?tale|narrative)\b/ },
  { action: 'essay_writing', re: /\b(essay|thesis|dissertation)\b/ },
  { action: 'article_writing', re: /\b(article|blog|report|news\s?piece)\b/ },
  { action: 'resume_creation', re: /\b(resume|cv|curriculum\s?vitae)\b/ },
  { action: 'email_writing', re: /\b(e-?mail)\b/ },
  { action: 'letter_writing', re: /\b(letter|cover\s?letter|application)\b/ },
];

const EDIT_PATTERNS = [
  { action: 'text_rewrite', re: /\b(rewrite|re-?write|rephrase|paraphrase|reword|rework)\b/ },
  { action: 'improve_writing', re: /\b(improve|enhance|polish|refine|professional|tone|make (it|this) better)\b/ },
  { action: 'summarize', re: /\b(summari[sz]e|summary|tl;?dr|condense|shorten|key points)\b/ },
  { action: 'translate', re: /\b(translate|translation)\b/ },
  { action: 'grammar_correction', re: /\b(grammar|grammatical|spelling|punctuation|proofread|typos?)\b/ },
];

function classifyTask(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (!text.trim()) return null;
  const matches = [];
  if (GEN_VERBS.test(text)) for (const p of CONTENT_PATTERNS) if (p.re.test(text)) matches.push(p.action);
  for (const p of EDIT_PATTERNS) if (p.re.test(text)) matches.push(p.action);
  if (!matches.length) return null;
  return matches.reduce((best, a) => (ACTION_COSTS[a] > ACTION_COSTS[best] ? a : best), matches[0]);
}

export function resolveTask({ prompt, action } = {}) {
  const declaredRaw = action == null ? '' : String(action).trim();
  let declared = null;
  if (declaredRaw) {
    const key = declaredRaw.toLowerCase().replace(/[\s-]+/g, '_');
    if (!Object.prototype.hasOwnProperty.call(ACTION_COSTS, key)) return { ok: false, code: 'UNKNOWN_ACTION', action: key };
    declared = key;
  }
  const classified = classifyTask(prompt);
  const candidates = [classified, declared].filter(Boolean);
  const task = candidates.length
    ? candidates.reduce((best, a) => (ACTION_COSTS[a] > ACTION_COSTS[best] ? a : best), candidates[0])
    : DEFAULT_ACTION;
  return { ok: true, action: task, cost: ACTION_COSTS[task] };
}

const PLANS = {
  free: { key: 'free', label: 'Free', monthlyCredits: 25 },
  lite: { key: 'lite', label: 'Lite', monthlyCredits: 200 },
  pro: { key: 'pro', label: 'Pro', monthlyCredits: 800 },
};
export const DEFAULT_PLAN = 'free';
export const RESET_INTERVAL_DAYS = 3; // rolling refill window, per user

const MODEL_PRICING = {
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
  default: { input: 0.30, output: 2.50 },
};

export function normalizeAction(action) {
  const key = String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return Object.prototype.hasOwnProperty.call(ACTION_COSTS, key) ? key : DEFAULT_ACTION;
}
export const getActionCost = (a) => ACTION_COSTS[normalizeAction(a)];
export const getActionLabel = (a) => ACTION_LABELS[normalizeAction(a)] || normalizeAction(a);
export const getPlan = (plan) => PLANS[String(plan || '').trim().toLowerCase()] || PLANS[DEFAULT_PLAN];
const getModelPricing = (m) => MODEL_PRICING[String(m || '').trim()] || MODEL_PRICING.default;
export function estimateCost(model, usage) {
  const rate = getModelPricing(model);
  return ((Number(usage?.promptTokens) || 0) / 1e6) * rate.input + ((Number(usage?.outputTokens) || 0) / 1e6) * rate.output;
}
export function creditInfo() {
  return {
    groups: CREDIT_GROUPS.map((g) => ({
      title: g.title,
      items: g.items.map((action) => ({ action, label: getActionLabel(action), cost: ACTION_COSTS[action] })),
    })),
  };
}
export function upgradeMessage(plan, credits, required) {
  const planLabel = getPlan(plan).label;
  return `You don't have enough credits for this action (need ${required}, you have ${credits}). `
    + `Your ${planLabel} plan refills every ${RESET_INTERVAL_DAYS} days — upgrade to Lite or Pro for more credits.`;
}

/* ------------------------------- KV wallet -------------------------------- */
const RESET_MS = RESET_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
const KEY = (userId) => `credit:${userId}`;
const nowIso = (t = Date.now()) => new Date(t).toISOString();

async function putAccount(env, acct) {
  if (env.CREDITS_KV) await env.CREDITS_KV.put(KEY(acct.userId), JSON.stringify(acct));
}

/**
 * Fetch (or create) a user's account, applying the rolling 3-day reset lazily.
 * New users are seeded with the plan allotment; the balance refills once the reset
 * window elapses and the window rolls forward.
 */
export async function getAccount(env, userId, email) {
  const now = Date.now();
  let acct = null;
  if (env.CREDITS_KV) {
    const raw = await env.CREDITS_KV.get(KEY(userId));
    if (raw) { try { acct = JSON.parse(raw); } catch { acct = null; } }
  }

  if (!acct) {
    const plan = getPlan(DEFAULT_PLAN);
    acct = { userId, email: email || '', plan: plan.key, credits: plan.monthlyCredits, resetAt: nowIso(now + RESET_MS), updatedAt: nowIso(now) };
    await putAccount(env, acct);
    await appendLedger(env, { type: 'grant', userId, email: acct.email, plan: acct.plan, amount: acct.credits, reason: 'signup' });
    return acct;
  }

  let changed = false;
  if (email && acct.email !== email) { acct.email = email; changed = true; }
  const due = acct.resetAt ? Date.parse(acct.resetAt) : 0;
  if (!acct.resetAt || !Number.isFinite(due) || now >= due) {
    const plan = getPlan(acct.plan);
    acct.credits = plan.monthlyCredits;
    acct.resetAt = nowIso(now + RESET_MS);
    acct.updatedAt = nowIso(now);
    changed = true;
    await appendLedger(env, { type: 'grant', userId, email: acct.email, plan: acct.plan, amount: plan.monthlyCredits, reason: 'periodic_reset' });
  }
  if (changed) await putAccount(env, acct);
  return acct;
}

/** Reserve (deduct) credits before an AI call. Blocks with 402 shape when short. */
export async function reserve(env, user, action, cost) {
  const normAction = normalizeAction(action);
  const finalCost = (typeof cost === 'number' && cost >= 0) ? cost : getActionCost(normAction);
  const account = await getAccount(env, user.id, user.email);
  if (account.credits < finalCost) {
    return { ok: false, status: 402, code: 'INSUFFICIENT_CREDITS', error: upgradeMessage(account.plan, account.credits, finalCost), account, action: normAction, cost: finalCost };
  }
  account.credits -= finalCost;
  account.updatedAt = nowIso();
  await putAccount(env, account);
  return { ok: true, account, action: normAction, cost: finalCost, balanceAfter: account.credits };
}

/** Record a successful request in the audit ledger; returns remaining credits. */
export async function finalize(env, user, ctx) {
  const account = await getAccount(env, user.id, user.email);
  await appendLedger(env, {
    type: 'debit', userId: user.id, email: user.email || '', plan: account.plan,
    action: ctx.action, actionLabel: getActionLabel(ctx.action), creditsUsed: ctx.cost,
    model: ctx.model || '', promptTokens: ctx.usage?.promptTokens || 0, outputTokens: ctx.usage?.outputTokens || 0,
    totalTokens: ctx.usage?.totalTokens || 0, estimatedCostUsd: Number(estimateCost(ctx.model, ctx.usage).toFixed(6)),
    balanceAfter: account.credits,
  });
  return account.credits;
}

/** Refund a failed request (the model never produced a result). */
export async function refundFailed(env, user, ctx, reason) {
  const account = await getAccount(env, user.id, user.email);
  account.credits += ctx.cost;
  account.updatedAt = nowIso();
  await putAccount(env, account);
  await appendLedger(env, {
    type: 'refund', userId: user.id, email: user.email || '', plan: account.plan,
    action: ctx.action, actionLabel: getActionLabel(ctx.action), creditsRefunded: ctx.cost,
    reason: reason || 'ai_request_failed', balanceAfter: account.credits,
  });
  return account.credits;
}

/** Read all wallets from KV (for the admin dashboard). Paginates the key list. */
export async function allAccounts(env) {
  return listJson(env, 'credit:');
}

/** Read the whole audit ledger from KV (newest first). */
export async function readLedger(env) {
  const rows = await listJson(env, 'cledger:');
  return rows.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
}

/** List + JSON-parse every value under a KV key prefix (cursor-paginated). */
async function listJson(env, prefix) {
  if (!env.CREDITS_KV) return [];
  const out = [];
  let cursor;
  do {
    const list = await env.CREDITS_KV.list({ prefix, cursor });
    for (const k of list.keys) {
      const v = await env.CREDITS_KV.get(k.name);
      if (v) { try { out.push(JSON.parse(v)); } catch { /* skip */ } }
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return out;
}

/** Append one audit record (best-effort; a logging failure never breaks the flow). */
async function appendLedger(env, entry) {
  if (!env.CREDITS_KV) return;
  try {
    const key = `cledger:${new Date().toISOString()}:${crypto.randomUUID().slice(0, 8)}`;
    await env.CREDITS_KV.put(key, JSON.stringify({ ts: new Date().toISOString(), ...entry }));
  } catch (err) { console.error('[credits] ledger put failed:', err.message); }
}
