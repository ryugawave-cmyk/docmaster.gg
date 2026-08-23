'use strict';

const express = require('express');
const pageController = require('../controllers/pageController');

const router = express.Router();

/**
 * Marketing / static page routes.
 */
router.get('/', pageController.home);
router.get('/about', pageController.about);
router.get('/pricing', pageController.pricing);
router.get('/contact', pageController.contact);

// Legal & trust pages
router.get('/privacy', pageController.privacy);
router.get('/terms', pageController.terms);
router.get('/cookies', pageController.cookies);
router.get('/security', pageController.security);

module.exports = router;
