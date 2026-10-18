import { AppError } from '../errors/AppError.js'
import { asyncRoute } from '../middleware/asyncRoute.js'
import { PERMISSION_CATALOG, ROLE_DETAILS } from '../permissions/rolePermissions.js'
import { CustomRole, User } from '../models/index.js'
import { recordAudit } from '../services/audit.js'
import { listRoleDefinitions } from '../services/roles.js'
import { success } from '../utils/response.js'

const forbiddenPermissions = new Set(['users.manage', 'settings.manage', 'roles.manage', 'clientPortal.view.own'])

export const listRoles = asyncRoute(async (_req, res) => {
  success(res, await listRoleDefinitions(), 200, undefined, { permissions: PERMISSION_CATALOG })
})

export const createRole = asyncRoute(async (req, res) => {
  assertSuperAdmin(req)
  assertCustomPermissions(req.body.permissions)
  const name = req.body.name.trim()
  const nameNormalized = name.toLocaleLowerCase('en-US')
  await assertUniqueName(nameNormalized)
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!slug) throw new AppError(400, 'INVALID_ROLE_NAME', 'Role name must include letters or numbers.')
  const role = await CustomRole.create({
    key: `custom_${slug}`,
    name,
    nameNormalized,
    description: req.body.description || '',
    permissions: req.body.permissions,
    status: req.body.status || 'Active',
  })
  await recordAudit(req, 'role.created', 'roles', role.key, {
    name: role.name,
    permissions: role.permissions,
    status: role.status,
  })
  success(res, { ...role.toJSON(), builtIn: false, userCount: 0 }, 201)
})

export const updateRole = asyncRoute(async (req, res) => {
  assertSuperAdmin(req)
  const role = await CustomRole.findOne({ key: req.params.id })
  if (!role) throw new AppError(404, 'ROLE_NOT_FOUND', 'Custom role was not found.')

  if (req.body.permissions) assertCustomPermissions(req.body.permissions)
  if (req.body.name) {
    const previousName = role.name
    role.name = req.body.name.trim()
    role.nameNormalized = role.name.toLocaleLowerCase('en-US')
    await assertUniqueName(role.nameNormalized, role.id)
    role.$locals.previousName = previousName
  }
  if (req.body.status === 'Inactive' && role.status !== 'Inactive') {
    const assignedUsers = await User.countDocuments({ role: role.key })
    if (assignedUsers > 0) {
      throw new AppError(409, 'ROLE_HAS_USERS', 'This role cannot be deactivated while users are assigned to it. Reassign those users first.')
    }
  }

  const changes = {}
  if (req.body.name) {
    changes.name = { from: role.$locals.previousName, to: role.name }
  }
  for (const field of ['description', 'permissions', 'status']) {
    if (req.body[field] !== undefined) {
      changes[field] = { from: role[field], to: req.body[field] }
      role[field] = req.body[field]
    }
  }
  await role.save()
  await recordAudit(req, 'role.updated', 'roles', role.key, changes)
  success(res, { ...role.toJSON(), builtIn: false, userCount: await User.countDocuments({ role: role.key }) })
})

function assertSuperAdmin(req) {
  if (req.user.role !== 'super_admin') {
    throw new AppError(403, 'ROLE_MANAGEMENT_FORBIDDEN', 'Only a Super Admin can manage roles.')
  }
}

function assertCustomPermissions(permissions) {
  const forbidden = permissions.filter((permission) => forbiddenPermissions.has(permission))
  if (forbidden.length) {
    throw new AppError(400, 'PRIVILEGED_PERMISSION_FORBIDDEN', 'Custom roles cannot be granted user-management, role-management, system-settings, or client-portal permissions.', { permissions: forbidden })
  }
}

async function assertUniqueName(nameNormalized, exceptId) {
  const systemNames = Object.values(ROLE_DETAILS).map(({ label }) => label.toLocaleLowerCase('en-US'))
  if (systemNames.includes(nameNormalized)) {
    throw new AppError(409, 'DUPLICATE_ROLE_NAME', 'A built-in role already uses this name.')
  }
  const query = { nameNormalized, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }
  if (await CustomRole.exists(query)) {
    throw new AppError(409, 'DUPLICATE_ROLE_NAME', 'A role with this name already exists.')
  }
}
