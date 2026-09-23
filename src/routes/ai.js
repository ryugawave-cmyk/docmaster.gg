'use strict';

const express = require('express');
const aiController = require('../controllers/aiController');

const router = express.Router();

/**
 * AI Assistant proxy, mounted at `/api/ai`.
 * The server holds the API key (config.ai) and forwards chat requests to the
 * provider so the key never reaches the browser.
 */
router.post('/chat', aiController.chat);

module.exports = router;
