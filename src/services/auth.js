import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { getEnv } from '../config/env.js'
import { AppError } from '../errors/AppError.js'
import { User } from '../models/index.js'
import { findActiveRole } from './roles.js'

const REFRESH_COOKIE = 'dbcrm_refresh'
const REFRESH_DURATION_MS = 7 * 24 * 60 * 60 * 1000

function cookieValue(req, name) {
  const cookie = req.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null
}

function tokenHash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function matchesHash(candidate, savedHash) {
  if (!candidate || !savedHash) return false
  const candidateHash = Buffer.from(tokenHash(candidate))
  const storedHash = Buffer.from(savedHash)
  return candidateHash.length === storedHash.length && timingSafeEqual(candidateHash, storedHash)
}

function setRefreshCookie(res, token) {
  const { NODE_ENV } = getEnv()
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: NODE_ENV === 'production',
    sameSite: NODE_ENV === 'production' ? 'none' : 'strict',
    path: '/api/v1/auth',
    maxAge: REFRESH_DURATION_MS,
  })
}

export function clearRefreshCookie(res) {
  const { NODE_ENV } = getEnv()
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: NODE_ENV === 'production',
    sameSite: NODE_ENV === 'production' ? 'none' : 'strict',
    path: '/api/v1/auth',
  })
}

function publicUser(user, role) {
  return {
    ...user.toJSON(),
    permissions: role.permissions,
    roleLabel: role.name,
  }
}

async function issueAccessToken(user) {
  const { JWT_SECRET, JWT_EXPIRES_IN } = getEnv()
  return jwt.sign({ ver: user.tokenVersion }, JWT_SECRET, {
    subject: user.id,
    expiresIn: JWT_EXPIRES_IN,
    issuer: 'design-blocks-crm-api',
    audience: 'design-blocks-crm',
  })
}

async function createSession(user, res) {
  const role = await findActiveRole(user.role)
  if (!role) throw new AppError(401, 'UNAUTHENTICATED', 'This account role is no longer active.')
  const refreshToken = randomBytes(48).toString('base64url')
  user.refreshTokenHash = tokenHash(refreshToken)
  await user.save()
  setRefreshCookie(res, refreshToken)
  return { accessToken: await issueAccessToken(user), user: publicUser(user, role) }
}

export async function login({ email, password }, res) {
  const user = await User.findOne({ email: email.toLowerCase() })
    .select('+passwordHash +tokenVersion +refreshTokenHash')
  if (!user || user.status !== 'Active' || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.')
  }
  return createSession(user, res)
}

export async function refresh(req, res) {
  const refreshToken = cookieValue(req, REFRESH_COOKIE)
  if (!refreshToken) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.')
  const user = await User.findOne({ refreshTokenHash: tokenHash(refreshToken) })
    .select('+passwordHash +tokenVersion +refreshTokenHash')
  if (!user || user.status !== 'Active' || !matchesHash(refreshToken, user.refreshTokenHash)) {
    clearRefreshCookie(res)
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.')
  }
  return createSession(user, res)
}

export async function logout(req, res) {
  const refreshToken = cookieValue(req, REFRESH_COOKIE)
  let user = refreshToken
    ? await User.findOne({ refreshTokenHash: tokenHash(refreshToken) })
      .select('+tokenVersion +refreshTokenHash')
    : null

  if (!user) {
    const accessToken = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
    if (accessToken) {
      try {
        const payload = jwt.verify(accessToken, getEnv().JWT_SECRET, {
          issuer: 'design-blocks-crm-api',
          audience: 'design-blocks-crm',
        })
        if (typeof payload === 'object' && payload.sub && Number.isInteger(payload.ver)) {
          const candidate = await User.findById(payload.sub).select('+tokenVersion +refreshTokenHash')
          if (candidate?.tokenVersion === payload.ver) user = candidate
        }
      } catch (error) {
        if (error.name !== 'JsonWebTokenError' && error.name !== 'TokenExpiredError') throw error
      }
    }
  }

  if (user) {
    user.refreshTokenHash = undefined
    user.tokenVersion += 1
    await user.save()
  }
  clearRefreshCookie(res)
}

export async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await User.findById(userId).select('+passwordHash +tokenVersion +refreshTokenHash')
  if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new AppError(400, 'PASSWORD_MISMATCH', 'Current password is incorrect.')
  }
  user.passwordHash = await bcrypt.hash(newPassword, 12)
  user.mustChangePassword = false
  user.tokenVersion += 1
  user.refreshTokenHash = undefined
  await user.save()
}

export function getCookieName() {
  return REFRESH_COOKIE
}
