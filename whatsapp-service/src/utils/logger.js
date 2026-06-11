'use strict';

const pino = require('pino');

// Use simple pino logger without pino-pretty transport dependency
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV !== 'production' && {
    transport: undefined, // Let pino output standard JSON in dev too
  }),
});

module.exports = logger;
