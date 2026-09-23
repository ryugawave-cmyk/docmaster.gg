'use strict';

const express = require('express');
const seoRoutes = require('./seo');
const pageRoutes = require('./pages');
const toolRoutes = require('./tools');
const workspaceRoutes = require('./workspace');
const aiRoutes = require('./ai');
const contactRoutes = require('./contact');

const router = express.Router();

/**
 * Root router — composes all feature routers.
 *
 * Mounting each group here keeps `app.js` clean and makes it trivial to add new
 * feature areas (e.g. `/dashboard`, `/api`) as the SaaS expands.
 */
router.use('/', seoRoutes);
router.use('/', pageRoutes);
router.use('/workspace', workspaceRoutes);
router.use('/tools', toolRoutes);
router.use('/api/ai', aiRoutes);
router.use('/api/contact', contactRoutes);

module.exports = router;
