import { AppError } from '../errors/AppError.js'
import { ROLE_PERMISSIONS } from '../permissions/rolePermissions.js'

export function hasPermission(user, permission) {
  const permissions = user?.$locals?.effectivePermissions || user?.permissions || ROLE_PERMISSIONS[user?.role]
  return Boolean(permissions?.includes(permission))
}

export function authorize(...permissions) {
  return (req, _res, next) => {
    if (!req.user) return next(new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.'))
    if (!permissions.some((permission) => hasPermission(req.user, permission))) {
      return next(new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action.'))
    }
    next()
  }
}
