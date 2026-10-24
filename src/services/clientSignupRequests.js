import { randomBytes, randomUUID } from 'node:crypto'
import bcrypt from 'bcrypt'
import mongoose from 'mongoose'
import { AppError } from '../errors/AppError.js'
import { Client, ClientSignupRequest, User } from '../models/index.js'
import { ROLES } from '../permissions/rolePermissions.js'
import { recordAudit } from './audit.js'
import { createNotification } from './notifications.js'

const normalizeCompany = (value) => String(value || '').trim().toLocaleLowerCase()
const normalizePhone = (value) => String(value || '').replace(/\D/g, '')
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function duplicatePendingRequest(error) {
  if (error?.code === 11000 && error?.keyPattern?.normalizedEmail) {
    throw new AppError(409, 'CLIENT_REQUEST_PENDING', 'A signup request for this email is already awaiting approval.')
  }
  throw error
}

export async function submitClientSignup(body, req) {
  const email = body.email.trim().toLowerCase()
  const session = await mongoose.startSession()
  let request
  try {
    await session.withTransaction(async () => {
      if (await User.exists({ email }).session(session)) {
        throw new AppError(409, 'ACCOUNT_EXISTS', 'An account already uses this email. Contact Design Blocks for access help.')
      }
      if (await ClientSignupRequest.exists({ normalizedEmail: email, status: 'Pending' }).session(session)) {
        throw new AppError(409, 'CLIENT_REQUEST_PENDING', 'A signup request for this email is already awaiting approval.')
      }
      const admins = await User.find({ role: ROLES.SUPER_ADMIN, status: 'Active' })
        .select('id')
        .session(session)
      if (!admins.length) {
        throw new AppError(503, 'NO_ACTIVE_SUPER_ADMIN', 'Client signup requests cannot be accepted right now. Please contact Design Blocks.')
      }

      request = await new ClientSignupRequest({
        id: `CSR-${randomUUID()}`,
        name: body.name,
        company: body.company,
        email,
        normalizedEmail: email,
        phone: body.phone,
        address: body.address || undefined,
      }).save({ session })

      for (const admin of admins) {
        await createNotification({
          recipientId: admin.id,
          title: 'New client signup request',
          body: `${request.name} · ${request.company}`,
          category: 'Client access',
          href: '/client-signup-requests',
          eventType: 'client_signup.submitted',
          dedupeKey: `client-signup:${request.id}:submitted:${admin.id}`,
        }, session)
      }
      await recordAudit(req, 'client_signup.submitted', 'client-signup-requests', request.id, { status: 'Pending' }, session)
    })
  } catch (error) {
    duplicatePendingRequest(error)
  } finally {
    await session.endSession()
  }
  return request.toJSON()
}

export async function listClientSignupRequests(status = 'Pending') {
  const filter = status === 'All' ? {} : { status }
  const requests = await ClientSignupRequest.find(filter)
    .sort({ status: 1, createdAt: -1 })
    .limit(200)
  return requests.map((request) => request.toJSON())
}

async function findOrCreateClient(request, requestedClientId, session) {
  const sameEmail = await Client.findOne({ email: request.normalizedEmail }).session(session)
  if (sameEmail) {
    if (requestedClientId && requestedClientId !== sameEmail.id) {
      throw new AppError(409, 'CLIENT_EMAIL_ALREADY_LINKED', 'This email already belongs to a different client record.')
    }
    if (normalizeCompany(sameEmail.company) !== normalizeCompany(request.company)
      || (normalizePhone(sameEmail.phone) && normalizePhone(request.phone)
        && normalizePhone(sameEmail.phone) !== normalizePhone(request.phone))) {
      throw new AppError(409, 'CLIENT_IDENTITY_MISMATCH', 'An existing client uses this email but its company or phone does not match. Verify the client record before approving.')
    }
    if (sameEmail.status === 'Inactive') {
      throw new AppError(409, 'CLIENT_INACTIVE', 'Reactivate the existing client record before approving portal access.')
    }
    if (sameEmail.status !== 'Active') {
      sameEmail.status = 'Active'
      await sameEmail.save({ session })
    }
    return sameEmail
  }

  if (requestedClientId) {
    const selected = await Client.findOne({ id: requestedClientId }).session(session)
    if (!selected) throw new AppError(404, 'CLIENT_NOT_FOUND', 'The selected client record was not found.')
    if (selected.status === 'Inactive'
      || normalizeCompany(selected.company) !== normalizeCompany(request.company)
      || !normalizePhone(selected.phone)
      || normalizePhone(selected.phone) !== normalizePhone(request.phone)) {
      throw new AppError(409, 'CLIENT_IDENTITY_MISMATCH', 'The selected client must be active and match the request company and phone.')
    }
    return selected
  }

  const phone = normalizePhone(request.phone)
  const possibleMatches = await Client.find({
    company: new RegExp(`^${escapeRegex(request.company)}$`, 'i'),
  }).session(session)
  const identityMatch = possibleMatches.find((client) => normalizePhone(client.phone) === phone)
  if (identityMatch) {
    throw new AppError(409, 'CLIENT_MATCH_REVIEW_REQUIRED', 'A client with the same company and phone already exists. Select that client record before approving.')
  }

  return new Client({
    id: `CL-${randomUUID()}`,
    name: request.name,
    company: request.company,
    email: request.normalizedEmail,
    phone: request.phone,
    normalizedPhone: phone,
    address: request.address,
    status: 'Active',
    since: new Date(),
  }).save({ session })
}

async function notifyOtherAdmins(req, request, status, session) {
  const admins = await User.find({
    role: ROLES.SUPER_ADMIN,
    status: 'Active',
    _id: { $ne: req.user.id },
  }).select('id').session(session)
  for (const admin of admins) {
    await createNotification({
      recipientId: admin.id,
      title: `Client signup ${status.toLowerCase()}`,
      body: `${request.name} · ${request.company}`,
      category: 'Client access',
      href: '/client-signup-requests',
      eventType: `client_signup.${status.toLowerCase()}`,
      dedupeKey: `client-signup:${request.id}:${status.toLowerCase()}:${admin.id}`,
    }, session)
  }
}

export async function approveClientSignupRequest(id, { existingClientId }, req) {
  const temporaryPassword = randomBytes(24).toString('base64url')
  const passwordHash = await bcrypt.hash(temporaryPassword, 12)
  const session = await mongoose.startSession()
  let result
  try {
    await session.withTransaction(async () => {
      const request = await ClientSignupRequest.findOne({ id }).session(session)
      if (!request) throw new AppError(404, 'CLIENT_REQUEST_NOT_FOUND', 'Client signup request was not found.')
      if (request.status !== 'Pending') {
        throw new AppError(409, 'CLIENT_REQUEST_ALREADY_REVIEWED', 'This signup request has already been reviewed.')
      }
      const client = await findOrCreateClient(request, existingClientId, session)
      let account = await User.findOne({ email: request.normalizedEmail })
        .select('+passwordHash +tokenVersion +refreshTokenHash')
        .session(session)
      if (account) {
        if (account.role !== ROLES.CLIENT || account.clientId !== client.id || account.status === 'Active') {
          throw new AppError(409, 'ACCOUNT_EXISTS', 'An account already uses this email. Resolve the existing account before approving.')
        }
        account.passwordHash = passwordHash
        account.mustChangePassword = true
        account.status = 'Active'
        account.tokenVersion = (account.tokenVersion || 0) + 1
        account.refreshTokenHash = undefined
        account.clientId = client.id
        account.phone = request.phone
        account.name = request.name
        await account.save({ session })
      } else {
        account = await new User({
          name: request.name,
          email: request.normalizedEmail,
          phone: request.phone,
          passwordHash,
          mustChangePassword: true,
          role: ROLES.CLIENT,
          status: 'Active',
          clientId: client.id,
          initials: request.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(),
        }).save({ session })
      }

      request.status = 'Approved'
      request.clientId = client.id
      request.userId = account.id
      request.reviewedBy = req.user.id
      request.reviewedAt = new Date()
      await request.save({ session })
      await notifyOtherAdmins(req, request, 'Approved', session)
      await recordAudit(req, 'client_signup.approved', 'client-signup-requests', request.id, {
        status: request.status,
        clientId: client.id,
        userId: account.id,
      }, session)
      result = {
        request: request.toJSON(),
        credentials: { email: account.email, temporaryPassword },
      }
    })
  } finally {
    await session.endSession()
  }
  return result
}

export async function rejectClientSignupRequest(id, reason, req) {
  const session = await mongoose.startSession()
  let result
  try {
    await session.withTransaction(async () => {
      const request = await ClientSignupRequest.findOne({ id }).session(session)
      if (!request) throw new AppError(404, 'CLIENT_REQUEST_NOT_FOUND', 'Client signup request was not found.')
      if (request.status !== 'Pending') {
        throw new AppError(409, 'CLIENT_REQUEST_ALREADY_REVIEWED', 'This signup request has already been reviewed.')
      }
      request.status = 'Rejected'
      request.rejectionReason = reason || undefined
      request.reviewedBy = req.user.id
      request.reviewedAt = new Date()
      await request.save({ session })
      await notifyOtherAdmins(req, request, 'Rejected', session)
      await recordAudit(req, 'client_signup.rejected', 'client-signup-requests', request.id, {
        status: request.status,
        ...(reason ? { reason } : {}),
      }, session)
      result = request.toJSON()
    })
  } finally {
    await session.endSession()
  }
  return result
}
