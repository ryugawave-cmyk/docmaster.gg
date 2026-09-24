'use strict';

const config = require('../config');
const creditsService = require('../services/credits');
const creditsConfig = require('../config/credits');
const { resolveUser } = require('../services/authUser');

/**
 * Credit middleware for AI routes.
 *
 * Chain order (see routes/ai.js):
 *   requireAiEnabled → validateChatRequest → attachUser → checkCredits → controller
 *
 * The order matters: we only ever DEDUCT after the request is known to be valid,
 * the AI is configured, and the caller is identified — so a bad/anonymous request
 * never spends someone's credits.
 */

/** 503 if the AI provider isn't configured — before any credit is touched. */
function requireAiEnabled(req, res, next) {
  if (!config.ai.enabled) {
    return res.status(503).json({ error: 'AI is not configured. Set AI_API_KEY in .env.' });
  }
  return next();
}

/**
 * Validate the chat payload BEFORE credits are reserved, so malformed requests
 * (missing prompt, unsupported image provider) are rejected without charging.
 */
function validateChatRequest(req, res, next) {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt) return res.status(400).json({ error: 'A prompt is required.' });

  const img = req.body?.image;
  const hasImage = img && typeof img.data === 'string' && img.data;
  if (hasImage && config.ai.provider !== 'gemini') {
    return res.status(400).json({ error: 'Image input is only wired for the Gemini provider right now.' });
  }
  return next();
}

/** Identify the caller (verified Supabase token, or dev fallback). 401 if unknown. */
async function attachUser(req, res, next) {
  try {
    const user = await resolveUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Please sign in to use the AI assistant.', code: 'AUTH_REQUIRED' });
    }
    req.user = user;
    return next();
  } catch (err) {
    console.error('[credits] user resolution failed:', err.message);
    return res.status(401).json({ error: 'Could not verify your session. Please sign in again.', code: 'AUTH_REQUIRED' });
  }
}

/**
 * Check the balance and reserve (deduct) credits for the request's action.
 * Blocks with 402 + an upgrade message when the user is short. On success, stashes
 * the reservation on req.credit for the controller to finalize/refund.
 */
function checkCredits(req, res, next) {
  // Resolve the billable task SERVER-SIDE from the prompt (+ optional client hint).
  // The client can't pick a cheaper task than what it actually asked for, and an
  // explicit unknown action is rejected rather than coerced to a cheap default.
  const resolved = creditsConfig.resolveTask({ prompt: req.body?.prompt, action: req.body?.action });
  if (!resolved.ok) {
    return res.status(400).json({
      error: `Unknown AI action "${resolved.action}".`,
      code: 'UNKNOWN_ACTION',
    });
  }

  const result = creditsService.reserve(req.user, resolved.action, resolved.cost);

  if (!result.ok) {
    // Insufficient credits → block the request; still report remaining balance.
    return res.status(result.status).json({
      error: result.error,
      code: result.code,
      credits: result.account.credits,
      required: result.cost,
      plan: result.account.plan,
      action: result.action,
    });
  }

  // Reservation succeeded — the controller finalizes (with token usage) or refunds.
  req.credit = { action: result.action, cost: result.cost, balanceAfter: result.balanceAfter };
  return next();
}

module.exports = { requireAiEnabled, validateChatRequest, attachUser, checkCredits };
