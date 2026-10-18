import mongoose from 'mongoose'
import { app } from './app.js'
import { getEnv } from './config/env.js'
import { logger } from './config/logger.js'
import { connectDatabase } from './db/connect.js'

const env = getEnv()

async function start() {
  await connectDatabase(env.MONGODB_URI)
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'CRM API listening'))

  const shutdown = (signal) => {
    logger.info({ signal }, 'Graceful shutdown started')
    server.close(async (error) => {
      if (error) {
        logger.error({ err: error }, 'HTTP server shutdown failed')
        process.exitCode = 1
      }
      try {
        await mongoose.disconnect()
      } catch (disconnectError) {
        logger.error({ err: disconnectError }, 'MongoDB disconnect failed')
        process.exitCode = 1
      }
    })
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

start().catch((error) => {
  logger.fatal({ err: error }, 'Could not start CRM API')
  process.exitCode = 1
})
