import pino from 'pino'
import { getEnv } from './env.js'

const { NODE_ENV } = getEnv()

export const logger = pino({
  level: process.env.LOG_LEVEL || (NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.refreshTokenHash',
      '*.token',
      '*.secret',
    ],
    censor: '[REDACTED]',
  },
})
