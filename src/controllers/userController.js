import bcrypt from 'bcrypt'
import mongoose from 'mongoose'
import { AppError } from '../errors/AppError.js'
import { asyncRoute } from '../middleware/asyncRoute.js'
import { Client, User } from '../models/index.js'
import { recordAudit } from '../services/audit.js'
import { ROLES } from '../permissions/rolePermissions.js'
import { success } from '../utils/response.js'
import { paginationOptions } from '../middleware/pagination.js'
import { findActiveRole, listRoleDefinitions, serializeUser } from '../services/roles.js'
import { assertUserCanBeDeleted } from '../services/userDeletion.js'

export const listUsers = asyncRoute(async (req, res) => {
  const { page, limit, skip, sort } = paginationOptions(req.query)
  const filter = { ...(req.query.search ? { $or: [
    { name: new RegExp(escapeRegex(req.query.search), 'i') },
    { email: new RegExp(escapeRegex(req.query.search), 'i') },
    { role: new RegExp(escapeRegex(req.query.search), 'i') },
  ] } : {}) }
  const [users, total] = await Promise.all([
    User.find(filter).sort(sort).skip(skip).limit(limit),
    User.countDocuments(filter),
  ])
  const roleDefinitions = await listRoleDefinitions()
  const labels = new Map(roleDefinitions.map((role) => [role.key, role.name]))
  success(res, users.map((user) => ({ ...user.toJSON(), roleLabel: labels.get(user.role) || user.role })), 200, undefined, { page, limit, total, pages: Math.ceil(total / limit) })
})

export const listAssignees = asyncRoute(async (_req, res) => {
  const users = await User.find({ status: 'Active', role: { $ne: ROLES.CLIENT } })
    .select('name role department')
    .sort({ name: 1 })
  success(res, users.map((user) => ({
    id: user.id,
    name: user.name,
    role: user.role,
    department: user.department,
  })))
})

export const getUser = asyncRoute(async (req, res) => {
  const user = await User.findById(req.params.id)
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found.')
  success(res, await serializeUser(user))
})

export const createUser = asyncRoute(async (req, res) => {
  if (req.user.role !== ROLES.SUPER_ADMIN) {
    throw new AppError(403, 'USER_MANAGEMENT_FORBIDDEN', 'Only a Super Admin can create employee accounts.')
  }
  if (!(await findActiveRole(req.body.role))) {
    throw new AppError(400, 'ROLE_NOT_ASSIGNABLE', 'Select an active role.')
  }
  if (req.body.role === ROLES.CLIENT && !req.body.clientId) {
    throw new AppError(400, 'CLIENT_LINK_REQUIRED', 'Client accounts must be linked to a client record.')
  }
  if (req.body.clientId && !(await Client.exists({ id: req.body.clientId }))) {
    throw new AppError(400, 'CLIENT_NOT_FOUND', 'The linked client record was not found.')
  }
  const user = await User.create({
    ...req.body,
    email: req.body.email.toLowerCase(),
    passwordHash: await bcrypt.hash(req.body.password, 12),
    mustChangePassword: true,
    initials: req.body.name.trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(),
  })
  await recordAudit(req, 'user.created', 'users', user.id, { role: user.role })
  success(res, user.toJSON(), 201)
})

export const updateUser = asyncRoute(async (req, res) => {
  if (req.user.role !== ROLES.SUPER_ADMIN) {
    throw new AppError(403, 'USER_MANAGEMENT_FORBIDDEN', 'Only a Super Admin can update employee accounts.')
  }
  const user = await User.findById(req.params.id).select('+tokenVersion +refreshTokenHash')
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found.')
  if (req.body.role && !(await findActiveRole(req.body.role))) {
    throw new AppError(400, 'ROLE_NOT_ASSIGNABLE', 'Select an active role.')
  }
  if (user.id === req.user.id && req.body.role && req.body.role !== user.role) {
    throw new AppError(403, 'SELF_ROLE_CHANGE_FORBIDDEN', 'You cannot change your own role.')
  }
  if (req.body.role === ROLES.CLIENT && !(req.body.clientId || user.clientId)) {
    throw new AppError(400, 'CLIENT_LINK_REQUIRED', 'Client accounts must be linked to a client record.')
  }
  if (user.id === req.user.id && req.body.status === 'Inactive') {
    throw new AppError(403, 'SELF_DEACTIVATION_FORBIDDEN', 'You cannot deactivate your own account.')
  }
  if (user.role === ROLES.SUPER_ADMIN
    && (req.body.status === 'Inactive' || (req.body.role && req.body.role !== ROLES.SUPER_ADMIN))) {
    const activeAdmins = await User.countDocuments({ role: ROLES.SUPER_ADMIN, status: 'Active', _id: { $ne: user._id } })
    if (activeAdmins === 0) {
      throw new AppError(409, 'LAST_SUPER_ADMIN', 'At least one active Super Admin must remain.')
    }
  }
  if (req.body.clientId && !(await Client.exists({ id: req.body.clientId }))) {
    throw new AppError(400, 'CLIENT_NOT_FOUND', 'The linked client record was not found.')
  }
  const changes = {}
  for (const [key, value] of Object.entries(req.body)) {
    changes[key] = { from: user[key], to: value }
    user[key] = key === 'email' ? value.toLowerCase() : value
  }
  if (req.body.name) user.initials = req.body.name.trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
  if (req.body.status === 'Inactive') {
    user.tokenVersion += 1
    user.refreshTokenHash = undefined
  }
  await user.save()
  await recordAudit(req, 'user.updated', 'users', user.id, changes)
  success(res, user.toJSON())
})

export const setPassword = asyncRoute(async (req, res) => {
  if (req.user.role !== ROLES.SUPER_ADMIN) {
    throw new AppError(403, 'USER_MANAGEMENT_FORBIDDEN', 'Only a Super Admin can reset employee passwords.')
  }
  const user = await User.findById(req.params.id).select('+passwordHash +tokenVersion +refreshTokenHash')
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found.')
  user.passwordHash = await bcrypt.hash(req.body.newPassword, 12)
  user.mustChangePassword = true
  user.tokenVersion += 1
  user.refreshTokenHash = undefined
  await user.save()
  await recordAudit(req, 'user.password_changed', 'users', user.id, {})
  success(res, null, 200, 'Password updated.')
})

export const deleteUser = asyncRoute(async (req, res) => {
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      const user = await User.findById(req.params.id).session(session)
      if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found.')
      const activeSuperAdminCount = user.role === ROLES.SUPER_ADMIN && user.status === 'Active'
        ? await User.countDocuments({
          role: ROLES.SUPER_ADMIN,
          status: 'Active',
        }).session(session)
        : null
      assertUserCanBeDeleted(req.user, user, activeSuperAdminCount)
      await recordAudit(req, 'user.deleted', 'users', user.id, {
        name: user.name,
        email: user.email,
        role: user.role,
      }, session)
      const result = await user.deleteOne({ session })
      if (result.deletedCount !== 1) {
        throw new AppError(409, 'USER_DELETE_CONFLICT', 'The user account could not be deleted. Refresh the page and try again.')
      }
    })
  } finally {
    await session.endSession()
  }
  success(res, { id: req.params.id }, 200, 'User account deleted.')
})

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
