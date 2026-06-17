'use strict';

require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3001', 10),
  djangoApiUrl: process.env.DJANGO_API_URL || 'http://localhost:8000',
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  waServiceSecret: process.env.WA_SERVICE_SECRET || '',
  sessionsDir: process.env.SESSIONS_DIR || './sessions',
  internalApiKey: process.env.INTERNAL_API_KEY || 'changeme-internal-key',
};
