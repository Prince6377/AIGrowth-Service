'use strict';

const whatsappService = require('../services/whatsapp.service');
const logger = require('../utils/logger');

async function getQR(req, res) {
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id query parameter is required' });
  try {
    const result = await whatsappService.getQR(userId);
    if (result.status === 'connected') {
      return res.json({ status: 'connected', qr: null, message: 'WhatsApp is already connected' });
    }
    if (!result.qr) {
      return res.json({ status: result.status || 'initializing', qr: null, message: 'QR code is being generated' });
    }
    return res.json({ status: 'qr_ready', qr: result.qr });
  } catch (err) {
    logger.error({ err, userId }, 'Error generating QR');
    return res.status(500).json({ error: 'Failed to generate QR code' });
  }
}

function getStatus(req, res) {
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id query parameter is required' });
  return res.json(whatsappService.getStatus(userId));
}

async function disconnect(req, res) {
  const userId = req.body?.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id is required in request body' });
  try {
    const result = await whatsappService.disconnect(userId);
    return res.json(result);
  } catch (err) {
    logger.error({ err, userId }, 'Error disconnecting session');
    return res.status(500).json({ error: 'Failed to disconnect session' });
  }
}

/**
 * POST /whatsapp/send-message
 * Body: { user_id, phone, chat_jid, message }
 */
async function sendMessage(req, res) {
  const { user_id, phone, chat_jid, message } = req.body || {};
  if (!user_id || !message || (!phone && !chat_jid)) {
    return res.status(400).json({ error: 'user_id, message, and phone or chat_jid are required' });
  }
  try {
    const result = await whatsappService.sendMessage(user_id, phone || '', message, chat_jid || '');
    return res.json(result);
  } catch (err) {
    logger.error({ err, user_id, phone, chat_jid }, 'Error sending WhatsApp message');
    return res.status(500).json({ error: err.message || 'Failed to send message' });
  }
}

module.exports = { getQR, getStatus, disconnect, sendMessage };
