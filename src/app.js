import cors from 'cors'
import express from 'express'
import mongoose from 'mongoose'
import helmet from 'helmet'
import pinoHttp from 'pino-http'
import { getEnv } from './config/env.js'
import { logger } from './config/logger.js'
import { AppError } from './errors/AppError.js'
import { requestContext } from './middleware/requestContext.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import authRoutes from './routes/authRoutes.js'
import userRoutes from './routes/userRoutes.js'
import roleRoutes from './routes/roleRoutes.js'
import analyticsRoutes from './routes/analyticsRoutes.js'
import settingsRoutes from './routes/settingsRoutes.js'
import auditRoutes from './routes/auditRoutes.js'
import { resourceRouter } from './routes/resourceRoutes.js'

export function createApp() {
  const env = getEnv()
  const app = express()
  const origins = new Set([
    ...env.FRONTEND_URL.split(',').map((origin) => origin.trim()).filter(Boolean),
    'https://crm-frontend-rho-lilac.vercel.app',
    'https://crm-frontend-git-main-dileeps-projects-efeb0f16.vercel.app',
    'https://crm-frontend-audztfl0o-dileeps-projects-efeb0f16.vercel.app',
  ])

  app.disable('x-powered-by')
  app.use(requestContext)
  app.use(helmet())
  app.use(cors({
    origin(origin, callback) {
      if (!origin || origins.has(origin)) return callback(null, true)
      callback(new AppError(403, 'CORS_ORIGIN_DENIED', 'This origin is not allowed to access the API.'))
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
  }))
  app.use(express.json({ limit: '1mb', strict: true }))
  app.use(pinoHttp({
    logger,
    customProps: (req) => ({ requestId: req.id }),
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url, remoteAddress: req.remoteAddress }
      },
    },
  }))

  app.get('/health', (_req, res) => {
    const ready = process.env.NODE_ENV === 'test' || mongoose.connection.readyState === 1
    res.status(ready ? 200 : 503).json({ success: ready, data: { status: ready ? 'ok' : 'database-unavailable' } })
  })

  const api = express.Router()
  api.use('/auth', authRoutes)
  api.use('/users', userRoutes)
  api.use('/roles', roleRoutes)
  api.use('/', analyticsRoutes)
  api.use('/settings', settingsRoutes)
  api.use('/audit-logs', auditRoutes)

  for (const resource of ['leads', 'followups', 'clients', 'quotations', 'agreements', 'invoices', 'payments', 'projects', 'tasks', 'notifications']) {
    api.use(`/${resource}`, resourceRouter(resource))
  }
  app.use('/api/v1', api)

  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}

export const app = createApp()
