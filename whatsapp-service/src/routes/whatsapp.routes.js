'use strict';

const { Router } = require('express');
const controller = require('../controllers/whatsapp.controller');

const router = Router();

// GET /whatsapp/qr?user_id=USER_ID
router.get('/qr', controller.getQR);

// GET /whatsapp/status?user_id=USER_ID
router.get('/status', controller.getStatus);

// POST /whatsapp/disconnect  { user_id }
router.post('/disconnect', controller.disconnect);

// POST /whatsapp/send-message  { user_id, phone, message }
router.post('/send-message', controller.sendMessage);

module.exports = router;
