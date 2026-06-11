'use strict';

/**
 * WhatsApp Session Service
 *
 * Manages per-user Baileys sessions with full chat/message sync:
 *  - Session creation and restoration from disk
 *  - QR code generation as base64 PNG
 *  - Connection status tracking
 *  - Auto-reconnect on connection close
 *  - Notifying Django backend on connect/disconnect
 *  - Syncing chats and messages to Django on connection
 *  - Sending outbound messages
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
} = require('@whiskeysockets/baileys');

// Cache the WA version so QR generates instantly on repeated connections
let _cachedVersion = null;
async function getWAVersion() {
  if (!_cachedVersion) {
    const { version } = await fetchLatestBaileysVersion();
    _cachedVersion = version;
  }
  return _cachedVersion;
}

/** Returns true for JIDs that should never become dashboard chats. */
function isJunkJid(jid = '') {
  return !jid || jid === 'status@broadcast' || isJidBroadcast(jid) || isJidGroup(jid) || jid.endsWith('@newsletter');
}
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const config = require('../config');
const logger = require('../utils/logger');

// In-memory session store: Map<userId, { socket, status, qr, phoneNumber, store }>
const sessions = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureSessionsDir(userId) {
  const dir = path.resolve(config.sessionsDir, `user_${userId}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Strip @s.whatsapp.net or @g.us suffix to get phone number. */
function jidToPhone(jid = '') {
  return jid.split('@')[0].split(':')[0];
}

function isLidJid(jid = '') {
  return jid.endsWith('@lid');
}

function isPhoneJid(jid = '') {
  return jid.endsWith('@s.whatsapp.net');
}

function phoneToJid(phone = '') {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : '';
}

function firstTruthy(...values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || '';
}

function toUnixTimestamp(value) {
  if (!value) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value) || null;
  if (typeof value.toNumber === 'function') return value.toNumber();
  if (typeof value.low === 'number') return value.low;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rememberContact(sessionData, contact = {}) {
  const name = firstTruthy(contact.pushName, contact.name, contact.notify, contact.verifiedName);
  const number = firstTruthy(
    contact.phoneNumber,
    contact.phone,
    contact.waid,
    contact.id?.endsWith('@s.whatsapp.net') ? jidToPhone(contact.id) : '',
  );
  const ids = [
    contact.id,
    contact.jid,
    contact.lid,
    contact.pn,
    typeof contact.phoneNumber === 'string' && contact.phoneNumber.includes('@') ? contact.phoneNumber : '',
  ].filter(Boolean);

  for (const id of ids) {
    if (name) sessionData.contactMap.set(id, name);
    if (number) sessionData.contactNumberMap.set(id, number);
  }
}

function rememberLidPhoneMapping(sessionData, lidJid = '', phoneJid = '', name = '') {
  if (!isLidJid(lidJid) || !isPhoneJid(phoneJid)) return;
  sessionData.lidToPhoneMap.set(lidJid, phoneJid);
  sessionData.contactNumberMap.set(lidJid, jidToPhone(phoneJid));
  if (name) sessionData.contactMap.set(lidJid, name);
}

function getStoreContact(sessionData, jid) {
  return null;
}

function resolveContact(sessionData, jid, msg = {}, chat = {}) {
  const storeContact = getStoreContact(sessionData, jid) || {};
  const senderPhoneJid = firstTruthy(msg.key?.senderPn, msg.key?.participant);
  rememberLidPhoneMapping(sessionData, jid, senderPhoneJid, msg.pushName || chat.name || chat.pushName || '');

  const contactName = firstTruthy(
    msg.pushName,
    chat.name,
    chat.pushName,
    storeContact.pushName,
    storeContact.name,
    storeContact.notify,
    storeContact.verifiedName,
    sessionData.contactMap.get(jid),
  );
  const contactNumber = firstTruthy(
    sessionData.contactNumberMap.get(jid),
    isPhoneJid(senderPhoneJid) ? jidToPhone(senderPhoneJid) : '',
    storeContact.phoneNumber,
    storeContact.phone,
    storeContact.waid,
    jid.endsWith('@s.whatsapp.net') ? jidToPhone(jid) : '',
    jidToPhone(jid),
  );

  return {
    name: contactName || contactNumber || jid,
    number: contactNumber || jidToPhone(jid),
  };
}

function canonicalChatIdForContact(sessionData, sourceJid, contact = {}) {
  if (isLidJid(sourceJid)) {
    const mappedPhoneJid = sessionData.lidToPhoneMap.get(sourceJid);
    if (mappedPhoneJid) return mappedPhoneJid;

    const phoneJid = phoneToJid(contact.number);
    if (phoneJid && jidToPhone(phoneJid) !== jidToPhone(sourceJid)) return phoneJid;

    return '';
  }

  if (isPhoneJid(sourceJid)) return sourceJid;
  return phoneToJid(contact.number) || sourceJid;
}

function buildChatPayload(sessionData, chat) {
  const sourceChatId = chat?.id || '';
  if (!sourceChatId || isJunkJid(sourceChatId)) return null;

  const contact = resolveContact(sessionData, sourceChatId, {}, chat);
  const canonicalChatId = canonicalChatIdForContact(sessionData, sourceChatId, contact);
  if (!canonicalChatId) return null;

  const contactNumber = isPhoneJid(canonicalChatId) ? jidToPhone(canonicalChatId) : contact.number;
  return {
    whatsapp_chat_id: canonicalChatId,
    source_whatsapp_chat_id: sourceChatId,
    contact_name: contactNumber,
    contact_number: contactNumber,
    last_message: '',
    unread_count: typeof chat.unreadCount === 'number' ? chat.unreadCount : null,
    updated_at: toUnixTimestamp(chat.conversationTimestamp),
  };
}

function resolveSendJid(sessionData, phone = '', chatJid = '') {
  const normalizedChatJid = typeof chatJid === 'string' && chatJid.includes('@') ? chatJid : '';
  const normalizedPhone = typeof phone === 'string' ? phone.trim() : '';

  if (isLidJid(normalizedChatJid)) {
    const mappedPhoneJid = sessionData.lidToPhoneMap.get(normalizedChatJid);
    if (mappedPhoneJid) return mappedPhoneJid;
  }

  if (normalizedPhone.includes('@')) {
    if (isLidJid(normalizedPhone)) {
      return sessionData.lidToPhoneMap.get(normalizedPhone) || normalizedPhone;
    }
    return normalizedPhone;
  }

  const digits = normalizedPhone.replace(/\D/g, '');
  if (digits) {
    const possibleLid = `${digits}@lid`;
    const mappedPhoneJid = sessionData.lidToPhoneMap.get(possibleLid);
    if (mappedPhoneJid) return mappedPhoneJid;
    if (normalizedChatJid && isLidJid(normalizedChatJid)) return normalizedChatJid;
    return phoneToJid(digits);
  }

  return normalizedChatJid;
}

function unwrapMessage(message = {}) {
  let current = message;
  for (let i = 0; i < 5; i += 1) {
    const next =
      current?.ephemeralMessage?.message ||
      current?.viewOnceMessage?.message ||
      current?.viewOnceMessageV2?.message ||
      current?.documentWithCaptionMessage?.message ||
      current?.editedMessage?.message;
    if (!next) break;
    current = next;
  }
  return current || {};
}

function extractMessagePayload(rawMessage = {}) {
  const message = unwrapMessage(rawMessage);
  if (message.protocolMessage || message.senderKeyDistributionMessage) return null;

  if (message.conversation) {
    return { content: message.conversation, messageType: 'TEXT' };
  }
  if (message.extendedTextMessage?.text) {
    return { content: message.extendedTextMessage.text, messageType: 'TEXT' };
  }
  if (message.imageMessage) {
    return { content: firstTruthy(message.imageMessage.caption, '[Image]'), messageType: 'IMAGE' };
  }
  if (message.documentMessage) {
    return { content: firstTruthy(message.documentMessage.fileName, '[Document]'), messageType: 'DOCUMENT' };
  }
  if (message.videoMessage) {
    return { content: firstTruthy(message.videoMessage.caption, '[Video]'), messageType: 'VIDEO' };
  }
  if (message.audioMessage) {
    return { content: '[Audio]', messageType: 'AUDIO' };
  }

  return { content: '[Unsupported message]', messageType: 'TEXT' };
}

function rememberProcessedMessage(sessionData, messageId) {
  if (!messageId) return false;
  if (sessionData.seenMessageIds.has(messageId)) return true;
  sessionData.seenMessageIds.add(messageId);
  if (sessionData.seenMessageIds.size > 5000) {
    const oldest = sessionData.seenMessageIds.values().next().value;
    sessionData.seenMessageIds.delete(oldest);
  }
  return false;
}

/** Build internal Django API headers. */
function internalHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Internal-Key': config.internalApiKey,
  };
}

// ── Django Notifications ──────────────────────────────────────────────────────

async function notifyDjango({ userId, connected, phoneNumber = '', sessionId = '' }) {
  try {
    await axios.post(
      `${config.djangoApiUrl}/api/onboarding/whatsapp/status/`,
      { user_id: userId, connected, phone_number: phoneNumber, session_id: sessionId },
      { timeout: 5000 },
    );
    logger.info({ userId, connected }, 'Notified Django of WhatsApp status');
  } catch (err) {
    logger.error({ err, userId }, 'Failed to notify Django of WhatsApp status');
  }
}

async function pushInboundMessage(userId, {
  chatId,
  sourceChatId = '',
  contactName,
  contactNumber,
  content,
  messageId,
  messageType = 'TEXT',
  timestamp,
  is_from_me = false,
  increment_unread = true,
}) {
  try {
    await axios.post(
      `${config.djangoApiUrl}/api/conversations/inbound-message/`,
      {
        user_id: userId,
        whatsapp_chat_id: chatId,
        source_whatsapp_chat_id: sourceChatId || chatId,
        contact_name: contactName || '',
        contact_number: contactNumber || '',
        content,
        whatsapp_message_id: messageId,
        message_type: messageType,
        timestamp: timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString(),
        is_from_me,
        increment_unread,
      },
      { headers: internalHeaders(), timeout: 8000 },
    );
  } catch (err) {
    logger.error({ err, userId, chatId }, 'Failed to push inbound message to Django');
  }
}

async function syncChatsToDjango(userId, chats) {
  if (!chats || chats.length === 0) return;
  try {
    await axios.post(
      `${config.djangoApiUrl}/api/conversations/sync-chats/`,
      { user_id: userId, chats },
      { headers: internalHeaders(), timeout: 10000 },
    );
    logger.info({ userId, count: chats.length }, 'Synced chats to Django');
  } catch (err) {
    logger.error({ err, userId }, 'Failed to sync chats to Django');
  }
}

async function syncStoreChatsToDjango(userId, sessionData) {
  const storeChats = Array.from(sessionData.chatMap.values());
  const chatPayloads = storeChats
    .map((chat) => buildChatPayload(sessionData, chat))
    .filter(Boolean)
    .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));

  if (chatPayloads.length > 0) {
    await syncChatsToDjango(userId, chatPayloads);
  }
}

async function pushBaileysMessageToDjango(userId, sessionData, msg, { incrementUnread }) {
  if (!msg?.key?.remoteJid || !msg.message) return;

  const sourceChatId = msg.key.remoteJid;
  if (isJunkJid(sourceChatId)) return;

  const messageId = msg.key.id;
  if (!messageId) {
    logger.warn({ userId, chatId: sourceChatId }, 'Skipped WhatsApp message without key.id');
    return;
  }
  if (rememberProcessedMessage(sessionData, messageId)) return;

  const payload = extractMessagePayload(msg.message);
  if (!payload) return;

  const contact = resolveContact(sessionData, sourceChatId, msg);
  const chatId = canonicalChatIdForContact(sessionData, sourceChatId, contact);
  if (!chatId) return;

  const timestamp = toUnixTimestamp(msg.messageTimestamp);
  const isFromMe = Boolean(msg.key.fromMe);
  const contactNumber = isPhoneJid(chatId) ? jidToPhone(chatId) : contact.number;

  console.log(
    `  message ${messageId} ${isFromMe ? 'outgoing' : 'incoming'} ${contactNumber}: "${payload.content.slice(0, 60)}"`,
  );

  await pushInboundMessage(userId, {
    chatId,
    sourceChatId,
    contactName: contactNumber,
    contactNumber,
    content: payload.content,
    messageId,
    messageType: payload.messageType,
    timestamp,
    is_from_me: isFromMe,
    increment_unread: !isFromMe && incrementUnread,
  });
}

// ── Session Initialization ────────────────────────────────────────────────────

async function initSession(userId) {
  const existing = sessions.get(String(userId));
  if (existing?.status === 'connected') return;

  const sessionDir = ensureSessionsDir(userId);
  const sessionId = `user_${userId}`;
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const version = await getWAVersion();

  logger.info({ userId, version }, 'Initializing Baileys session');

  sessions.set(String(userId), {
    status: 'initializing',
    qr: null,
    phoneNumber: '',
    sessionId,
    socket: null,
    contactMap: new Map(), // Store contacts locally for name resolution
    contactNumberMap: new Map(),
    lidToPhoneMap: new Map(),
    chatMap: new Map(),
    seenMessageIds: new Set(),
  });

  const sock = makeWASocket({
    version,
    auth: state,
    logger: logger.child({ module: 'baileys' }),
    printQRInTerminal: false,
    shouldIgnoreJid: (jid) => isJunkJid(jid),
    keepAliveIntervalMs: 30_000,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => true, // ENABLED to get recent offline history chunk (last 24h)
    markOnlineOnConnect: true, // Go online immediately, skip AwaitingInitialSync
    fireInitQueries: true,
    generateHighQualityLinkPreview: false,
    getMessage: async () => {
      return { conversation: 'hello' }
    }
  });

  const sessionData = sessions.get(String(userId));
  sessionData.socket = sock;

  // ── connection.update ──────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const session = sessions.get(String(userId));
    if (!session) return;

    if (qr) {
      console.log(`\n📱 QR CODE READY — scan it on your phone!`);
      const qrBase64 = await QRCode.toDataURL(qr, {
        width: 300, margin: 2,
        color: { dark: '#111827', light: '#FFFFFF' },
      });
      session.qr = qrBase64;
      session.status = 'qr_ready';
    }

    if (connection === 'open') {
      const phoneNumber = sock.user?.id ? jidToPhone(sock.user.id) : '';
      console.log(`\n✅ CONNECTED! Phone: ${phoneNumber}`);
      console.log(`   Now waiting for chat list from WhatsApp...\n`);
      session.status = 'connected';
      session.phoneNumber = phoneNumber;
      session.qr = null;

      await notifyDjango({ userId, connected: true, phoneNumber, sessionId });
      setTimeout(() => {
        syncStoreChatsToDjango(userId, sessionData).catch((err) => {
          logger.error({ err, userId }, 'Failed to sync Baileys store chats after connect');
        });
      }, 1500);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`\n❌ DISCONNECTED (code: ${statusCode}, reconnect: ${shouldReconnect})`);

      if (session) {
        session.status = 'disconnected';
        session.qr = null;
      }
      await notifyDjango({ userId, connected: false });

      if (shouldReconnect) {
        console.log(`   Reconnecting in 5s...`);
        setTimeout(() => initSession(userId), 5_000);
      } else {
        console.log(`   Logged out — clearing session files`);
        sessions.delete(String(userId));
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }
  });

  // ── creds.update ──────────────────────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ── contacts.upsert / contacts.set ─────────────────────────────────────────
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      rememberContact(sessionData, c);
    }
  });

  sock.ev.on('contacts.set', ({ contacts = [] }) => {
    for (const c of contacts) {
      rememberContact(sessionData, c);
    }
  });

  sock.ev.on('contacts.update', (contacts) => {
    for (const c of contacts) {
      rememberContact(sessionData, c);
    }
  });

  // ── messaging-history.set — ONLY sync chat list (sidebar), skip messages ──
  sock.ev.on('messaging-history.set', async ({ chats = [], contacts = [], messages = [], isLatest }) => {
    console.log(`\n========== HISTORY CHUNK RECEIVED ==========`);
    console.log(`  Chats: ${chats.length} | Contacts: ${contacts.length} | Messages: ${messages.length} | isLatest: ${isLatest}`);

    for (const c of contacts) {
      rememberContact(sessionData, c);
    }

    // ONLY sync the chat list — no messages, no heavy processing
    if (chats.length > 0) {
      for (const c of chats) {
        if (c.id) sessionData.chatMap.set(c.id, c);
      }
      const chatPayloads = chats
        .map(c => buildChatPayload(sessionData, c))
        .filter(Boolean);

      console.log(`  Real chats after filtering junk: ${chatPayloads.length}`);
      if (chatPayloads.length > 0) {
        chatPayloads.forEach((c, i) => console.log(`    [${i + 1}] ${c.contact_name} (${c.contact_number})`));
        await syncChatsToDjango(userId, chatPayloads);
        console.log(`  ✅ Synced ${chatPayloads.length} chats to Django`);
      }
    }

    const historyMessages = messages
      .filter(m => m?.key?.remoteJid && !isJunkJid(m.key.remoteJid))
      .sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0));

    if (historyMessages.length > 0) {
      console.log(`  Hydrating ${historyMessages.length} history messages without unread increments`);
      for (const msg of historyMessages) {
        await pushBaileysMessageToDjango(userId, sessionData, msg, { incrementUnread: false });
      }
    }
    console.log(`==============================================\n`);
  });

  // ── chats.upsert — new chats appearing in sidebar ──────────────────────────
  sock.ev.on('chats.upsert', async (chats) => {
    for (const c of chats) {
      if (c.id) sessionData.chatMap.set(c.id, c);
    }
    const chatPayloads = chats
      .map(c => buildChatPayload(sessionData, c))
      .filter(Boolean);

    if (chatPayloads.length > 0) {
      console.log(`\n[chats.upsert] ${chatPayloads.length} new chats:`);
      chatPayloads.forEach((c, i) => console.log(`  [${i + 1}] ${c.contact_name} (${c.contact_number})`));
      await syncChatsToDjango(userId, chatPayloads);
      console.log(`  ✅ Synced to Django`);
    }
  });

  // ── messages.upsert — incoming messages (real-time + buffered) ────────────
  sock.ev.on('chats.update', async (chats) => {
    for (const c of chats) {
      if (c.id) {
        sessionData.chatMap.set(c.id, {
          ...(sessionData.chatMap.get(c.id) || {}),
          ...c,
        });
      }
    }
    const chatPayloads = chats
      .map(c => buildChatPayload(sessionData, c))
      .filter(Boolean);

    if (chatPayloads.length > 0) {
      await syncChatsToDjango(userId, chatPayloads);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`\n📨 [messages.upsert] type="${type}" count=${messages.length}`);
    
    // Accept ALL types: 'notify' (real-time), 'append' (offline), undefined (buffered flush)
    for (const msg of messages) {
      await pushBaileysMessageToDjango(userId, sessionData, msg, { incrementUnread: type === 'notify' });
      continue;

      if (!msg.message) {
        console.log(`  ⏭ Skipped: no message body (id: ${msg.key?.id})`);
        continue;
      }
      
      // Skip protocol messages (like history sync notifications or read receipts)
      if (msg.message.protocolMessage) {
        continue;
      }

      const isFromMe = msg.key.fromMe || false;
      if (isJidGroup(msg.key.remoteJid)) continue;
      if (isJidBroadcast(msg.key.remoteJid)) continue;
      if (isJunkJid(msg.key.remoteJid)) continue;

      // Only process recent messages (last 24 hours) to avoid old history flooding
      const msgTs = Number(msg.messageTimestamp || 0);
      const oneDayAgo = (Date.now() / 1000) - (24 * 60 * 60);
      if (msgTs > 0 && msgTs < oneDayAgo) {
        continue; // Skip old history messages
      }

      const chatId = msg.key.remoteJid;
      const contactNumber = jidToPhone(chatId);
      const contactName = msg.pushName || sessionData.contactMap.get(chatId) || contactNumber;
      const messageId = msg.key.id;

      // Extract text content
      const content =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '[Media message]';

      const messageType = msg.message?.imageMessage ? 'IMAGE'
        : msg.message?.documentMessage ? 'DOCUMENT'
          : msg.message?.audioMessage ? 'AUDIO'
            : 'TEXT';

      console.log(`  ✉️ [${contactName}] ${isFromMe ? 'You: ' : ''}"${content.slice(0, 40)}" | Type: ${type}`);
      logger.info({ userId, chatId, contactName, content: content.slice(0, 50) }, 'Processed message');

      await pushInboundMessage(userId, {
        chatId, contactName, contactNumber,
        content, messageId, messageType, timestamp: msgTs,
        is_from_me: isFromMe,
      });
    }
  });

  return sock;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getQR(userId) {
  const key = String(userId);
  let session = sessions.get(key);
  if (!session || session.status === 'disconnected') {
    await initSession(userId);
    session = sessions.get(key);
  }
  if (!session) throw new Error('Failed to initialize session');
  return { status: session.status, qr: session.qr || null };
}

function getStatus(userId) {
  const session = sessions.get(String(userId));
  if (!session) return { status: 'not_initialized', connected: false, phoneNumber: '' };
  return {
    status: session.status,
    connected: session.status === 'connected',
    phoneNumber: session.phoneNumber || '',
    sessionId: session.sessionId,
  };
}

async function sendMessage(userId, phone, messageText, chatJid = '') {
  const session = sessions.get(String(userId));
  if (!session || session.status !== 'connected') {
    throw new Error('WhatsApp session not connected');
  }

  const jid = resolveSendJid(session, phone, chatJid);
  if (!jid) {
    throw new Error('No valid WhatsApp recipient found');
  }

  const sent = await session.socket.sendMessage(jid, { text: messageText });
  const messageId = sent?.key?.id || null;
  logger.info({ userId, jid, chatJid, messageId, preview: messageText.slice(0, 50) }, 'Message sent');
  return {
    success: true,
    messageId,
    timestamp: sent?.messageTimestamp ? Number(sent.messageTimestamp) : Math.floor(Date.now() / 1000),
  };
}

async function disconnect(userId) {
  const key = String(userId);
  const session = sessions.get(key);
  if (!session) return { success: false, message: 'No active session found' };

  if (session.storeInterval) {
    clearInterval(session.storeInterval);
  }

  try { await session.socket?.logout(); } catch (_) { }
  sessions.delete(key);

  const sessionDir = path.resolve(config.sessionsDir, `user_${userId}`);
  fs.rmSync(sessionDir, { recursive: true, force: true });
  await notifyDjango({ userId, connected: false });

  return { success: true, message: 'Disconnected successfully' };
}

async function autoInitializeSessions() {
  if (!fs.existsSync(config.sessionsDir)) return;
  const dirs = fs.readdirSync(config.sessionsDir);
  for (const dir of dirs) {
    if (dir.startsWith('user_')) {
      const userId = dir.split('_')[1];
      logger.info({ userId }, 'Auto-initializing session on startup');
      initSession(userId).catch(err => {
        logger.error({ err, userId }, 'Failed to auto-initialize session');
      });
    }
  }
}

module.exports = { initSession, getQR, getStatus, sendMessage, disconnect, autoInitializeSessions };
