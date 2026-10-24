import { AppError } from '../errors/AppError.js'
import { ROLES } from '../permissions/rolePermissions.js'

export function assertUserCanBeDeleted(actor, user, activeSuperAdminCount) {
  if (actor.role !== ROLES.SUPER_ADMIN) {
    throw new AppError(403, 'USER_MANAGEMENT_FORBIDDEN', 'Only a Super Admin can delete user accounts.')
  }
  if (user.id === actor.id) {
    throw new AppError(403, 'SELF_DELETION_FORBIDDEN', 'You cannot delete your own account.')
  }
  if (user.role === ROLES.SUPER_ADMIN && user.status === 'Active' && activeSuperAdminCount <= 1) {
    throw new AppError(409, 'LAST_SUPER_ADMIN', 'At least one active Super Admin must remain.')
  }
}
