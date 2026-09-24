'use strict';

const express = require('express');
const aiController = require('../controllers/aiController');
const {
  requireAiEnabled,
  validateChatRequest,
  attachUser,
  checkCredits,
} = require('../middleware/credits');

const router = express.Router();

/**
 * AI Assistant proxy, mounted at `/api/ai`.
 * The server holds the API key (config.ai) and forwards chat requests to the
 * provider so the key never reaches the browser.
 *
 * Every AI request runs through the credit gate first:
 *   requireAiEnabled  — 503 if no provider key (before any credit is touched)
 *   validateChatRequest — 400 on malformed input (before any credit is touched)
 *   attachUser        — identify the caller (verified Supabase token / dev user)
 *   checkCredits      — block with 402 if short, otherwise reserve/deduct
 * The controller then finalizes usage (token logging) or refunds on failure.
 */
router.post(
  '/chat',
  requireAiEnabled,
  validateChatRequest,
  attachUser,
  checkCredits,
  aiController.chat
);

// Read-only balance for the header credit badge. Only needs the caller identified
// (NOT requireAiEnabled) so the balance shows even before a provider key is set; it
// only reads the wallet (no deduction).
router.get('/credits', attachUser, aiController.credits);

// Pre-flight cost estimate for the prompt the user is about to run. Same resolver
// as /chat, so the estimate equals the eventual charge. Needs a valid prompt and
// an identified caller (for the balance), but no deduction.
router.post('/estimate', validateChatRequest, attachUser, aiController.estimate);

// The task/price catalogue for the info modal — public, no auth, no deduction.
router.get('/credit-info', aiController.creditInfo);

module.exports = router;
