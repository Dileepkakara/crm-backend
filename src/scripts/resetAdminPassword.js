import bcrypt from 'bcrypt'
import mongoose from 'mongoose'
import { getEnv } from '../config/env.js'
import { connectDatabase } from '../db/connect.js'
import { User } from '../models/index.js'

async function resetAdminPassword() {
  const env = getEnv()
  const emailValue = env.SUPER_ADMIN_EMAIL || env.SEED_ADMIN_EMAIL
  const password = env.SUPER_ADMIN_PASSWORD || env.SEED_ADMIN_PASSWORD
  if (!emailValue || !password) {
    throw new Error('Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD (or the legacy SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD).')
  }

  await connectDatabase(env.MONGODB_URI)
  const user = await User.findOne({ email: emailValue.toLowerCase() })
    .select('+passwordHash +tokenVersion +refreshTokenHash')
  if (!user) throw new Error('No account exists for the configured email.')
  if (user.role !== 'super_admin') throw new Error('The configured email does not belong to a Super Admin.')
  if (user.status !== 'Active') throw new Error('The configured Super Admin account is inactive; password was not changed.')

  user.passwordHash = await bcrypt.hash(password, 12)
  user.mustChangePassword = true
  user.tokenVersion += 1
  user.refreshTokenHash = undefined
  await user.save()
  console.info('Super Admin password reset. Sign in with the new password and change it when prompted.')
}

try {
  await resetAdminPassword()
} catch (error) {
  console.error(`Admin password reset failed (${error.name}). ${error.message}`)
  process.exitCode = 1
} finally {
  await mongoose.disconnect()
}
