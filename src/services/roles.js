import { CustomRole, User } from '../models/index.js'
import { isBuiltInRole, ROLE_DETAILS, ROLE_PERMISSIONS } from '../permissions/rolePermissions.js'

export async function findActiveRole(role) {
  if (isBuiltInRole(role)) {
    return { key: role, name: ROLE_DETAILS[role].label, permissions: ROLE_PERMISSIONS[role], status: 'Active', builtIn: true }
  }
  const customRole = await CustomRole.findOne({ key: role, status: 'Active' })
  return customRole ? { ...customRole.toJSON(), builtIn: false } : null
}

export async function resolveRolePermissions(role) {
  return (await findActiveRole(role))?.permissions || null
}

export async function serializeUser(user) {
  const result = user.toJSON()
  const role = await findActiveRole(user.role)
  result.permissions = role?.permissions || []
  result.roleLabel = role?.name || user.role
  return result
}

export async function listRoleDefinitions() {
  const counts = await User.aggregate([
    { $group: { _id: '$role', count: { $sum: 1 } } },
  ])
  const userCounts = new Map(counts.map(({ _id, count }) => [_id, count]))
  const builtIns = Object.entries(ROLE_DETAILS).map(([key, details]) => ({
    id: key,
    key,
    name: details.label,
    description: details.description,
    permissions: ROLE_PERMISSIONS[key],
    status: 'Active',
    builtIn: true,
    userCount: userCounts.get(key) || 0,
  }))
  const customRoles = await CustomRole.find().sort({ name: 1 })
  return [
    ...builtIns,
    ...customRoles.map((role) => ({
      ...role.toJSON(),
      builtIn: false,
      userCount: userCounts.get(role.key) || 0,
    })),
  ]
}
