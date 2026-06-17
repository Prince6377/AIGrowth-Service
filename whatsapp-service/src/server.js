'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const config = require('./config');
const logger = require('./utils/logger');
const whatsappRoutes = require('./routes/whatsapp.routes');

const app = express();

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (config.corsOrigins.includes(origin)) return true;

  try {
    const url = new URL(origin);
    const isLocalHost = ['localhost', '127.0.0.1'].includes(url.hostname);
    const port = Number(url.port);
    return isLocalHost && port >= 3000 && port <= 3099;
  } catch {
    return false;
  }
}

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Request logging ─────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.info({ method: req.method, url: req.url }, 'Incoming request');
  next();
});

// ── Routes ──────────────────────────────────────────────────────────────────
app.use('/whatsapp', whatsappRoutes);

// ── Health check ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'whatsapp-service', timestamp: new Date().toISOString() });
});

// ── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler ────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// Prevent Node.js from crashing on Baileys unhandled exceptions
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught Exception (prevented crash)');
});
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled Rejection (prevented crash)');
});

// ── Start server ────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  logger.info(`WhatsApp Service running on port ${config.port}`);
  logger.info(`Django API: ${config.djangoApiUrl}`);
  
  // Auto-initialize existing sessions
  const whatsappService = require('./services/whatsapp.service');
  whatsappService.autoInitializeSessions();
});

module.exports = app;
