import jwt from 'jsonwebtoken'
import { getEnv } from '../config/env.js'
import { AppError } from '../errors/AppError.js'
import { User } from '../models/index.js'
import { resolveRolePermissions } from '../services/roles.js'

export async function authenticate(req, _res, next) {
  const token = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return next(new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.'))

  try {
    const { JWT_SECRET } = getEnv()
    const payload = jwt.verify(token, JWT_SECRET, {
      issuer: 'design-blocks-crm-api',
      audience: 'design-blocks-crm',
    })
    if (typeof payload !== 'object' || !payload.sub || !Number.isInteger(payload.ver)) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.')
    }
    const user = await User.findById(payload.sub).select('+tokenVersion')
    if (!user || user.status !== 'Active' || user.tokenVersion !== payload.ver) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.')
    }
    const permissions = await resolveRolePermissions(user.role)
    if (!permissions) throw new AppError(401, 'UNAUTHENTICATED', 'This account role is no longer active.')
    user.$locals.effectivePermissions = permissions
    req.user = user
    next()
  } catch (error) {
    next(error instanceof AppError ? error : new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.'))
  }
}
