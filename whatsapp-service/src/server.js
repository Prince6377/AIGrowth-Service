'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const config = require('./config');
const logger = require('./utils/logger');
const whatsappRoutes = require('./routes/whatsapp.routes');

const app = express();

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
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

