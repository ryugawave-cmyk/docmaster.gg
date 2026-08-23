'use strict';

const express = require('express');
const pageController = require('../controllers/pageController');
const toolController = require('../controllers/toolController');

const router = express.Router();

/**
 * Tool routes, mounted at `/tools`.
 *
 * - `/tools`        → the tool catalog / overview
 * - `/tools/:slug`  → redirects into the workspace with the tool preselected
 */
router.get('/', pageController.toolsIndex);
router.get('/:slug', toolController.show);

module.exports = router;
