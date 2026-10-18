import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('15m'),
  FRONTEND_URL: z.string().min(1),
  SEED_ADMIN_NAME: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().trim().min(1).max(120).optional(),
  ),
  SEED_ADMIN_EMAIL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().email().optional(),
  ),
  SEED_ADMIN_PASSWORD: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(12).optional(),
  ),
  SUPER_ADMIN_NAME: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().trim().min(1).max(120).optional(),
  ),
  SUPER_ADMIN_EMAIL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().email().optional(),
  ),
  SUPER_ADMIN_PASSWORD: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(12).optional(),
  ),
})

export function getEnv() {
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')
    throw new Error(`Invalid or missing environment configuration: ${fields}`)
  }
  return parsed.data
}
