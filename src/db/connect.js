import mongoose from 'mongoose'
import { logger } from '../config/logger.js'

export async function connectDatabase(uri) {
  mongoose.set('strictQuery', true)
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 })
  logger.info('MongoDB connected')
}
