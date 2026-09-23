'use strict';

const express = require('express');
const contactController = require('../controllers/contactController');

const router = express.Router();

/**
 * Contact form API, mounted at `/api/contact`.
 * Stores each message durably and (optionally) forwards it to the owner's inbox.
 */
router.post('/', contactController.submit);
// Read submissions: JSON list + a simple HTML inbox (open /api/contact/inbox in a
// browser). Both are open on localhost; remote access needs ?token=CONTACT_ADMIN_TOKEN.
router.get('/messages', contactController.list);
router.get('/inbox', contactController.inbox);

module.exports = router;
