'use strict';

const creditsConfig = require('../config/credits');
const store = require('./creditStore');

/**
 * Credit domain service — the rules that sit between the HTTP layer and storage.
 *
 * The AI request lifecycle:
 *   1. reserve()  — before the AI call: check balance, block if short, deduct.
 *   2. finalize() — after a successful call: write the audit ledger entry with
 *                   token usage + estimated cost, return the remaining balance.
 *   3. refundFailed() — if the AI call errors: give the credits back and log it.
 *
 * Keeping these here (not in the middleware/controller) means the accounting is
 * testable and lives in one place.
 */

/** Insufficient-credit message shown to the user (drives the upgrade prompt). */
function upgradeMessage(plan, credits, required) {
  const planLabel = creditsConfig.getPlan(plan).label;
  return `You don't have enough credits for this action (need ${required}, you have ${credits}). `
    + `Your ${planLabel} plan refills every ${creditsConfig.RESET_INTERVAL_DAYS} days — upgrade to Lite or Pro for more credits.`;
}

/**
 * Reserve credits for an action. Called by the middleware before the AI request.
 *
 * The task is normally already RESOLVED server-side (middleware runs the prompt
 * classifier), so a resolved `cost` can be passed to bill exactly that. When
 * called with only an action (tests/tooling), the flat per-task cost is looked up.
 *
 * @param {{id,email}} user
 * @param {string} action  resolved task key
 * @param {number} [cost]  resolved credit cost (defaults to the task's flat cost)
 * @returns {{ok:true, account, action, cost, balanceAfter} | {ok:false, account, action, cost, status, error, code}}
 */
function reserve(user, action, cost) {
  const normAction = creditsConfig.normalizeAction(action);
  const finalCost = typeof cost === 'number' && cost >= 0 ? cost : creditsConfig.getActionCost(normAction);
  const account = store.getAccount(user.id, user.email);

  if (account.credits < finalCost) {
    return {
      ok: false,
      status: 402, // Payment Required — the semantically correct "out of credits".
      code: 'INSUFFICIENT_CREDITS',
      error: upgradeMessage(account.plan, account.credits, finalCost),
      account,
      action: normAction,
      cost: finalCost,
    };
  }

  const { credits } = store.deduct(user.id, finalCost);
  return { ok: true, account, action: normAction, cost: finalCost, balanceAfter: credits };
}

/**
 * Finalize a SUCCESSFUL request: record the audit entry and return the balance.
 * The credits were already deducted in reserve(); here we attach token usage.
 *
 * @param {{id,email}} user
 * @param {{action, cost, model, usage}} ctx  usage = {promptTokens,outputTokens,totalTokens}
 * @returns {number} remaining credits
 */
function finalize(user, ctx) {
  const usage = normalizeUsage(ctx.usage);
  const estimatedCostUsd = creditsConfig.estimateCost(ctx.model, usage);
  const account = store.getAccount(user.id, user.email);

  store.appendLedger({
    type: 'debit',
    userId: user.id,
    email: user.email || '',
    plan: account.plan,
    action: ctx.action,
    actionLabel: creditsConfig.getActionLabel(ctx.action),
    creditsUsed: ctx.cost,
    model: ctx.model || '',
    promptTokens: usage.promptTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
    balanceAfter: account.credits,
  });

  return account.credits;
}

/**
 * Refund a FAILED request (the AI never produced a result). Returns the credits
 * and logs the reversal for the audit trail.
 * @returns {number} remaining credits
 */
function refundFailed(user, ctx, reason) {
  const { credits } = store.refund(user.id, ctx.cost);
  const account = store.getAccount(user.id, user.email);
  store.appendLedger({
    type: 'refund',
    userId: user.id,
    email: user.email || '',
    plan: account.plan,
    action: ctx.action,
    actionLabel: creditsConfig.getActionLabel(ctx.action),
    creditsUsed: 0,
    creditsRefunded: ctx.cost,
    reason: reason || 'ai_request_failed',
    balanceAfter: credits,
  });
  return credits;
}

/** Normalise provider-specific usage into { promptTokens, outputTokens, totalTokens }. */
function normalizeUsage(usage) {
  const promptTokens = Number(usage?.promptTokens) || 0;
  const outputTokens = Number(usage?.outputTokens) || 0;
  const totalTokens = Number(usage?.totalTokens) || promptTokens + outputTokens;
  return { promptTokens, outputTokens, totalTokens };
}

module.exports = { reserve, finalize, refundFailed, normalizeUsage, upgradeMessage };
