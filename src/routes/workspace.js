'use strict';

const express = require('express');
const workspaceController = require('../controllers/workspaceController');

const router = express.Router();

/**
 * Document Workspace route, mounted at `/workspace`.
 * A single editor surface hosts every tool.
 */
router.get('/', workspaceController.show);

module.exports = router;
