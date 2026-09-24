'use strict';

const express = require('express');
const adminController = require('../controllers/adminController');

const router = express.Router();

/**
 * Admin analytics, mounted at `/admin`.
 * Access is gated inside the controller (localhost open; token required elsewhere).
 */
router.get('/usage', adminController.usage);
router.get('/usage.json', adminController.usageJson);

module.exports = router;
