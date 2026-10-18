import bcrypt from 'bcrypt'
import mongoose from 'mongoose'
import { getEnv } from '../config/env.js'
import { connectDatabase } from '../db/connect.js'
import { User } from '../models/index.js'

async function seedAdmin() {
  const env = getEnv()
  const emailValue = env.SUPER_ADMIN_EMAIL || env.SEED_ADMIN_EMAIL
  const password = env.SUPER_ADMIN_PASSWORD || env.SEED_ADMIN_PASSWORD
  if (!emailValue || !password) {
    throw new Error('Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD (or the legacy SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD).')
  }
  await connectDatabase(env.MONGODB_URI)
  const email = emailValue.toLowerCase()
  const existing = await User.findOne({ email })
  if (existing) {
    if (existing.role !== 'super_admin') throw new Error('The configured email belongs to a non-administrator; refusing to elevate it.')
    console.info('The configured Super Admin account already exists.')
    return
  }
  if (await User.exists({ role: 'super_admin' })) {
    throw new Error('A Super Admin already exists; refusing to create another initial administrator.')
  }
  const name = env.SUPER_ADMIN_NAME || env.SEED_ADMIN_NAME
    || email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
  await User.create({
    name,
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role: 'super_admin',
    status: 'Active',
    initials: name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(),
  })
  console.info('Initial Super Admin account created.')
}

try {
  await seedAdmin()
} catch (error) {
  console.error(`Admin seed failed (${error.name}). ${error.message}`)
  process.exitCode = 1
} finally {
  await mongoose.disconnect()
}
