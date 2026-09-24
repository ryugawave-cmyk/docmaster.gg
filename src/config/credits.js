'use strict';

/**
 * Credit system — SINGLE SOURCE OF TRUTH for costs, plans and pricing.
 *
 * Everything the token/credit system needs to make decisions lives here so a
 * product change (a new AI action, a cheaper plan, an updated model price) is a
 * one-file edit — no code changes elsewhere. The middleware, the AI controller
 * and the admin analytics all read from this module.
 *
 * Nothing here is a secret; these are business rules, safe to read on the server.
 */

// ---------------------------------------------------------------------------
// 1) Credit cost per AI TASK (flat — charged once per request, regardless of
//    document/output length). This is the SINGLE place to retune prices.
//    Keys are the stable task identifiers used everywhere (ledger, analytics,
//    the client `action` hint). Add a task by adding one line — the resolver,
//    middleware and info modal pick it up for free.
// ---------------------------------------------------------------------------
const ACTION_COSTS = {
  // Quick edits (act on existing/selected text)
  grammar_correction: 1,
  summarize: 1,
  translate: 1,
  text_rewrite: 2,
  improve_writing: 2,
  // Content creation
  letter_writing: 2,
  email_writing: 2,
  resume_creation: 2,
  form_filling: 2,
  // Long-form content
  article_writing: 3,
  blog_post: 3,
  essay_writing: 4,
  story_writing: 5,
  // Advanced generation / analysis
  script_writing: 7,
  presentation_content: 8,
  large_document_analysis: 5,
};

// Human-readable labels for the info modal, admin dashboard and logs.
const ACTION_LABELS = {
  grammar_correction: 'Grammar Correction',
  summarize: 'Summarize',
  translate: 'Translate',
  text_rewrite: 'Rewrite',
  improve_writing: 'Improve Writing',
  letter_writing: 'Letter',
  email_writing: 'Email',
  resume_creation: 'Resume / CV',
  form_filling: 'Form Filling',
  article_writing: 'Article',
  blog_post: 'Blog Post',
  essay_writing: 'Essay',
  story_writing: 'Story',
  script_writing: 'Script',
  presentation_content: 'Presentation / PPT',
  large_document_analysis: 'Large Document Analysis',
};

// Grouping for the "AI Credit Usage" info modal (Pricing page + AI panel). One
// source of truth so the modal never drifts from the real prices.
const CREDIT_GROUPS = [
  { title: 'Quick Edits', items: ['grammar_correction', 'summarize', 'text_rewrite', 'improve_writing'] },
  { title: 'Content Creation', items: ['letter_writing', 'email_writing', 'resume_creation'] },
  { title: 'Long Content', items: ['article_writing', 'essay_writing', 'story_writing'] },
  { title: 'Advanced AI', items: ['script_writing', 'presentation_content', 'large_document_analysis'] },
];

// When a free-form request matches no task and carries no valid hint, fall back
// to this. A generic edit/answer is charged as a Rewrite.
const DEFAULT_ACTION = 'text_rewrite';

// ---------------------------------------------------------------------------
// 1a) Server-side task classifier.
//     The client is NOT trusted to say how much a request costs. For free-form
//     agent chat (where the client sends no action) we infer the task from the
//     prompt here, so a "write a 5-page horror script" can never be billed as a
//     1-credit edit. Patterns are ordered/priced so the DOMINANT intent wins and
//     the higher-cost task is chosen on ties (see resolveTask) — a user can't
//     word a story request to look like a grammar fix and underpay.
//
//     Two families:
//       • CONTENT tasks — only classified when a generation verb is present
//         ("write/create/draft/…") so "fix the grammar in my story" stays a
//         grammar fix, while "write a story" becomes a story.
//       • EDIT tasks — intent verbs are themselves the trigger (no gen verb).
// ---------------------------------------------------------------------------
const GEN_VERBS = /\b(write|create|generate|draft|compose|make|produce|prepare|build|give me|need|want)\b/;

// Checked in order; each entry's regex is tested against the lowercased prompt.
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

/**
 * Infer the task from a free-form prompt. Returns a task key or null.
 * Among all matches the HIGHEST-cost task wins (anti-underpayment).
 */
function classifyTask(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (!text.trim()) return null;
  const matches = [];
  if (GEN_VERBS.test(text)) {
    for (const p of CONTENT_PATTERNS) if (p.re.test(text)) matches.push(p.action);
  }
  for (const p of EDIT_PATTERNS) if (p.re.test(text)) matches.push(p.action);
  if (!matches.length) return null;
  return matches.reduce((best, a) => (ACTION_COSTS[a] > ACTION_COSTS[best] ? a : best), matches[0]);
}

/**
 * Resolve the billable task for a request, authoritatively (server-side).
 *
 * @param {{prompt?:string, action?:string}} req
 * @returns {{ok:true, action:string, cost:number} | {ok:false, code:'UNKNOWN_ACTION', action:string}}
 *
 * Rules:
 *  - An explicit client `action` that isn't a known task is REJECTED (the design
 *    requires unknown actions to be rejected, not silently coerced to cheap).
 *  - Otherwise cost = the higher of {classified-from-prompt, valid client hint},
 *    falling back to DEFAULT_ACTION when neither is present. Taking the max means
 *    a spoofed cheap hint can never underpay for what was actually asked.
 */
function resolveTask({ prompt, action } = {}) {
  const declaredRaw = action == null ? '' : String(action).trim();
  let declared = null;
  if (declaredRaw) {
    const key = declaredRaw.toLowerCase().replace(/[\s-]+/g, '_');
    if (!Object.prototype.hasOwnProperty.call(ACTION_COSTS, key)) {
      return { ok: false, code: 'UNKNOWN_ACTION', action: key };
    }
    declared = key;
  }
  const classified = classifyTask(prompt);
  const candidates = [classified, declared].filter(Boolean);
  const task = candidates.length
    ? candidates.reduce((best, a) => (ACTION_COSTS[a] > ACTION_COSTS[best] ? a : best), candidates[0])
    : DEFAULT_ACTION;
  return { ok: true, action: task, cost: ACTION_COSTS[task] };
}

// ---------------------------------------------------------------------------
// 2) Plans → per-cycle credit allotment.
//    `plan` is stored per user; a user's balance refills to this amount every
//    RESET_INTERVAL_DAYS (a rolling window per user — see creditStore.getAccount).
//    NOTE: the field is still named `monthlyCredits` for backward compatibility
//    (pricing page, analytics), but it is the allotment PER RESET CYCLE, not /month.
// ---------------------------------------------------------------------------
const PLANS = {
  free: { key: 'free', label: 'Free', monthlyCredits: 25 },
  lite: { key: 'lite', label: 'Lite', monthlyCredits: 200 },
  pro: { key: 'pro', label: 'Pro', monthlyCredits: 800 },
};

const DEFAULT_PLAN = 'free';

// How often a user's balance refills to their plan allotment. Rolling per user:
// e.g. a new user gets 25 credits now, and they reset to 25 again 3 days later.
const RESET_INTERVAL_DAYS = 3;

// ---------------------------------------------------------------------------
// 3) Model pricing for the *estimated API cost* shown in analytics (USD).
//    Rates are USD per 1,000,000 tokens. These are estimates for reporting only
//    (no billing) — tune them to match the provider's current price sheet.
// ---------------------------------------------------------------------------
const MODEL_PRICING = {
  // Google Gemini Flash tiers (approximate public list prices).
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
  // Fallback used for any model not listed above.
  default: { input: 0.30, output: 2.50 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise an incoming action id and return a known key (or the default). */
function normalizeAction(action) {
  const key = String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return Object.prototype.hasOwnProperty.call(ACTION_COSTS, key) ? key : DEFAULT_ACTION;
}

/** Credit cost for an action id (unknown ids resolve to the default action's cost). */
function getActionCost(action) {
  return ACTION_COSTS[normalizeAction(action)];
}

/** Friendly label for an action id. */
function getActionLabel(action) {
  const key = normalizeAction(action);
  return ACTION_LABELS[key] || key;
}

/** Plan descriptor for a plan key (unknown → default plan). */
function getPlan(plan) {
  const key = String(plan || '').trim().toLowerCase();
  return PLANS[key] || PLANS[DEFAULT_PLAN];
}

/** Pricing entry for a model id (unknown → default rates). */
function getModelPricing(model) {
  return MODEL_PRICING[String(model || '').trim()] || MODEL_PRICING.default;
}

/**
 * Estimate the USD cost of one request from token usage.
 * @param {string} model
 * @param {{promptTokens?:number, outputTokens?:number}} usage
 * @returns {number} cost in USD (fractional; round only for display).
 */
function estimateCost(model, usage) {
  const rate = getModelPricing(model);
  const prompt = Number(usage?.promptTokens) || 0;
  const output = Number(usage?.outputTokens) || 0;
  return (prompt / 1e6) * rate.input + (output / 1e6) * rate.output;
}

/**
 * The task/price catalogue for the info modal, grouped and labelled.
 * @returns {{groups:{title:string, items:{action:string,label:string,cost:number}[]}[]}}
 */
function creditInfo() {
  return {
    groups: CREDIT_GROUPS.map((g) => ({
      title: g.title,
      items: g.items.map((action) => ({ action, label: getActionLabel(action), cost: ACTION_COSTS[action] })),
    })),
  };
}

module.exports = {
  ACTION_COSTS,
  ACTION_LABELS,
  CREDIT_GROUPS,
  DEFAULT_ACTION,
  PLANS,
  DEFAULT_PLAN,
  RESET_INTERVAL_DAYS,
  MODEL_PRICING,
  normalizeAction,
  classifyTask,
  resolveTask,
  getActionCost,
  getActionLabel,
  getPlan,
  getModelPricing,
  estimateCost,
  creditInfo,
};
