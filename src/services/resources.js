import mongoose from 'mongoose'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '../errors/AppError.js'
import { hasPermission } from '../middleware/authorize.js'
import { modelsByResource, Client, Invoice, Payment, Project, Quotation, Agreement, User, Lead } from '../models/index.js'
import { recordAudit } from './audit.js'
import { nextId } from './ids.js'
import { createNotification } from './notifications.js'
import { calculateDocument, toMoney } from './financials.js'
import { paginationSchema } from '../middleware/pagination.js'

export const resourcePermissions = {
  leads: { read: ['leads.view.all', 'leads.view.assigned'], create: ['leads.create'], update: ['leads.update'], delete: ['leads.delete'] },
  followups: { read: ['followups.view'], create: ['followups.create'], update: ['followups.update'], delete: ['followups.delete'] },
  clients: { read: ['clients.view'], create: ['clients.manage'], update: ['clients.manage'], delete: ['clients.manage'] },
  quotations: { read: ['quotations.view', 'quotations.view.own'], create: ['quotations.create'], update: ['quotations.create'], delete: [] },
  agreements: { read: ['agreements.view', 'agreements.view.own'], create: ['agreements.approve'], update: ['agreements.approve'], delete: [] },
  invoices: { read: ['invoices.view', 'invoices.view.own'], create: ['invoices.manage'], update: ['invoices.manage'], delete: [] },
  payments: { read: ['payments.view', 'payments.view.own'], create: ['payments.manage'], update: ['payments.manage'], delete: [] },
  projects: { read: ['projects.view', 'projects.view.assigned'], create: ['projects.manage'], update: ['projects.manage'], delete: [] },
  tasks: { read: ['tasks.view', 'tasks.view.assigned'], create: ['tasks.create'], update: ['tasks.update', 'tasks.update.assigned'], delete: ['tasks.delete'] },
  notifications: { read: ['notifications.view'], create: [], update: ['notifications.view'], delete: [] },
}

async function findPaymentReplay(key, fingerprint, user) {
  const existing = await Payment.findOne({ idempotencyKey: key }).select('+idempotencyFingerprint')
  if (!existing) return null
  if (!recordCanAccess('payments', existing, user)) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment was not found.')
  if (existing.idempotencyFingerprint !== fingerprint) {
    throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different payment.')
  }
  return { record: existing.toJSON(), replayed: true }
}

const quoteLineItems = (body) => body.items || body.lineItems
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const resourceQuerySchema = paginationSchema.extend({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  read: z.enum(['true', 'false']).optional(),
  assigneeId: z.string().trim().max(100).optional(),
})

async function buildScope(resource, user) {
  if (user.role === 'client') {
    if (resource === 'notifications') return { recipientId: user.id }
    if (!user.clientId) return { _id: new mongoose.Types.ObjectId('000000000000000000000000') }
    if (resource === 'clients') return { id: user.clientId }
    if (['leads', 'users'].includes(resource)) return { _id: new mongoose.Types.ObjectId('000000000000000000000000') }
    return { clientId: user.clientId }
  }
  if (resource === 'notifications') return { recipientId: user.id }
  if (resource === 'leads' && hasPermission(user, 'leads.view.assigned') && !hasPermission(user, 'leads.view.all')) {
    return { $or: [{ assigneeId: user.id }, { id: { $in: user.assignedLeadIds || [] } }] }
  }
  if (resource === 'clients' && ['sales_executive', 'accounts'].includes(user.role)) {
    return { $or: [
      { id: { $in: user.assignedClientIds || [] } },
      ...(user.role === 'sales_executive' ? [{ leadId: { $in: user.assignedLeadIds || [] } }] : []),
    ] }
  }
  if (resource === 'followups' && user.role === 'sales_executive') {
    return { $or: [{ assigneeId: user.id }, { leadId: { $in: user.assignedLeadIds || [] } }] }
  }
  if (resource === 'quotations' && hasPermission(user, 'quotations.view.own') && !hasPermission(user, 'quotations.view')) {
    return { $or: [{ ownerId: user.id }, { leadId: { $in: user.assignedLeadIds || [] } }] }
  }
  if (resource === 'projects' && hasPermission(user, 'projects.view.assigned') && !hasPermission(user, 'projects.view')) {
    return { $or: [{ managerId: user.id }, { id: { $in: user.assignedProjectIds || [] } }, { teamMemberIds: user.id }] }
  }
  if (resource === 'tasks' && hasPermission(user, 'tasks.view.assigned') && !hasPermission(user, 'tasks.view')) {
    if (user.role === 'project_manager') {
      return { $or: [{ assigneeId: user.id }, { id: { $in: user.assignedTaskIds || [] } }, { projectId: { $in: user.assignedProjectIds || [] } }] }
    }
    return { $or: [{ assigneeId: user.id }, { id: { $in: user.assignedTaskIds || [] } }] }
  }
  if (['agreements', 'invoices', 'payments'].includes(resource)
    && hasPermission(user, `${resource}.view.own`) && !hasPermission(user, `${resource}.view`)) {
    return user.clientId
      ? { clientId: user.clientId }
      : { _id: new mongoose.Types.ObjectId('000000000000000000000000') }
  }
  return {}
}

function recordCanAccess(resource, record, user) {
  if (!record || !user) return false
  const data = record.toObject ? record.toObject() : record
  if (user.role === 'client') {
    if (!user.clientId && resource !== 'notifications') return false
    if (resource === 'clients') return data.id === user.clientId
    if (resource === 'notifications') return data.recipientId === user.id
    return data.clientId === user.clientId
  }
  if (resource === 'leads' && hasPermission(user, 'leads.view.assigned') && !hasPermission(user, 'leads.view.all')) {
    return data.assigneeId === user.id || user.assignedLeadIds?.includes(data.id)
  }
  if (resource === 'clients' && ['sales_executive', 'accounts'].includes(user.role)) {
    return user.assignedClientIds?.includes(data.id)
      || (user.role === 'sales_executive' && user.assignedLeadIds?.includes(data.leadId))
  }
  if (resource === 'followups' && user.role === 'sales_executive') {
    return data.assigneeId === user.id || user.assignedLeadIds?.includes(data.leadId)
  }
  if (resource === 'quotations' && hasPermission(user, 'quotations.view.own') && !hasPermission(user, 'quotations.view')) {
    return data.ownerId === user.id || user.assignedLeadIds?.includes(data.leadId)
  }
  if (['agreements', 'invoices', 'payments'].includes(resource)
    && hasPermission(user, `${resource}.view.own`) && !hasPermission(user, `${resource}.view`)) {
    return Boolean(user.clientId && data.clientId === user.clientId)
  }
  if (resource === 'projects' && hasPermission(user, 'projects.view.assigned') && !hasPermission(user, 'projects.view')) {
    return data.managerId === user.id
      || user.assignedProjectIds?.includes(data.id) || data.teamMemberIds?.includes(user.id)
  }
  if (resource === 'tasks' && hasPermission(user, 'tasks.view.assigned') && !hasPermission(user, 'tasks.view')) {
    return data.assigneeId === user.id
      || user.assignedTaskIds?.includes(data.id)
      || (user.role === 'project_manager' && user.assignedProjectIds?.includes(data.projectId))
  }
  return true
}

async function findScoped(resource, id, user) {
  const Model = modelsByResource[resource]
  const record = await Model.findOne({ id, ...(await buildScope(resource, user)) })
  if (!record || !recordCanAccess(resource, record, user)) throw new AppError(404, 'RECORD_NOT_FOUND', 'Record was not found.')
  return record
}

async function resolveClient(fields, session, user) {
  if (!fields.clientId) return {}
  const client = await Client.findOne({ id: fields.clientId }).session(session || null)
  if (!client) throw new AppError(400, 'CLIENT_NOT_FOUND', 'The selected client was not found.')
  if (user && !recordCanAccess('clients', client, user)) throw new AppError(404, 'CLIENT_NOT_FOUND', 'The selected client was not found.')
  return { client: client.company || client.name }
}

async function resolveAssignee(fields, session) {
  const query = fields.assigneeId ? { _id: fields.assigneeId } : { name: fields.assignee, status: 'Active' }
  if (!fields.assigneeId && !fields.assignee) return {}
  const user = await User.findOne(query).session(session || null)
  if (!user || user.status !== 'Active' || user.role === 'client') {
    throw new AppError(400, 'ASSIGNEE_NOT_FOUND', 'Select an active employee as assignee.')
  }
  return { assigneeId: user.id, assignee: user.name }
}

async function calculateFinancialPayload(resource, payload, existing) {
  if (!['quotations', 'invoices'].includes(resource)) return payload
  const items = quoteLineItems(payload) ?? existing?.items ?? existing?.lineItems
  if (!items?.length && existing) {
    const rest = { ...payload }
    delete rest.total
    delete rest.amount
    return rest
  }
  const calculated = calculateDocument({ ...existing?.toObject?.(), ...payload, items })
  const fields = { ...payload }
  delete fields.lineItems
  return { ...fields, ...calculated, items: calculated.items }
}

async function preparePayload(resource, payload, user, existing, session) {
  let next = { ...payload }
  delete next.id
  delete next.number
  delete next.amount
  delete next.total
  delete next.balance
  delete next.amountPaid
  delete next.ownerId
  delete next.recordedById
  delete next.createdAt
  delete next.updatedAt
  delete next.acceptedAt
  delete next.acceptance
  delete next.acceptedSnapshot
  if (resource === 'leads') {
    if (next.phone) next.normalizedPhone = normalizePhone(next.phone)
    if (!hasPermission(user, 'leads.assign')) {
      next.assigneeId = user.id
      next.assignee = user.name
    } else if (next.assigneeId || next.assignee) Object.assign(next, await resolveAssignee(next, session))
    if (existing && (next.assigneeId || next.assignee) && existing.assigneeId !== next.assigneeId) {
      next.assignmentHistory = [...(existing.assignmentHistory || []), {
        fromUserId: existing.assigneeId || '',
        from: existing.assignee || '',
        toUserId: next.assigneeId,
        to: next.assignee,
        changedBy: user.id,
        changedAt: new Date(),
      }]
    }
  }
  if (resource === 'followups') {
    const requestedAssignee = next.assigneeId || next.assignee
    if (!existing && !hasPermission(user, 'followups.assign')) {
      next.assigneeId = user.id
      next.assignee = user.name
    } else if (requestedAssignee) {
      if (!hasPermission(user, 'followups.assign')) {
        if (requestedAssignee !== existing?.assigneeId && requestedAssignee !== existing?.assignee) {
          throw new AppError(403, 'ASSIGNMENT_FORBIDDEN', 'You cannot reassign this follow-up.')
        }
        next.assigneeId = existing.assigneeId
        next.assignee = existing.assignee
      } else {
        Object.assign(next, await resolveAssignee(next, session))
      }
    }
  }
  if (['quotations', 'agreements', 'invoices', 'payments', 'projects'].includes(resource)) {
    Object.assign(next, await resolveClient(next.clientId ? next : existing?.toObject?.() || {}, session, user))
  }
  if (resource === 'followups') {
    const lead = next.leadId ? await Lead.findOne({ id: next.leadId }).session(session || null) : null
    const client = next.clientId ? await Client.findOne({ id: next.clientId }).session(session || null) : null
    if (next.leadId && (!lead || !recordCanAccess('leads', lead, user))) {
      throw new AppError(404, 'LEAD_NOT_FOUND', 'The linked lead was not found.')
    }
    if (next.clientId && (!client || !recordCanAccess('clients', client, user))) {
      throw new AppError(404, 'CLIENT_NOT_FOUND', 'The linked client was not found.')
    }
    if (lead) {
      next.contact = lead.name
      next.company = lead.company
      next.assigneeId = next.assigneeId || lead.assigneeId
      next.assignee = next.assignee || lead.assignee
    }
    if (client) {
      next.contact = next.contact || client.name
      next.company = client.company || client.name
    }
  }
  if (resource === 'quotations') {
    if (existing && existing.status !== 'Draft') throw new AppError(409, 'QUOTATION_LOCKED', 'Only draft quotations can be edited. Create a revision instead.')
    next.ownerId = existing?.ownerId || user.id
    next.owner = existing?.owner || user.name
    next.version = existing?.version || 1
    if (next.status && next.status !== (existing?.status || 'Draft')) next.status = existing?.status || 'Draft'
  }
  if (resource === 'agreements') {
    if (existing?.status === 'Accepted') throw new AppError(409, 'AGREEMENT_LOCKED', 'Accepted work orders cannot be edited; create a new version.')
    if (next.quotationId) {
      const quote = await Quotation.findOne({ id: next.quotationId }).session(session || null)
      if (!quote || quote.status !== 'Accepted') throw new AppError(400, 'QUOTATION_NOT_ACCEPTED', 'A work order can only reference an accepted quotation.')
      if (next.clientId && quote.clientId !== next.clientId) throw new AppError(400, 'CLIENT_MISMATCH', 'The quotation belongs to a different client.')
      next.clientId = quote.clientId
      next.client = quote.client
      next.quotationSnapshot = quote.toJSON()
    }
    if (next.status && next.status !== (existing?.status || 'Draft')) next.status = existing?.status || 'Draft'
    if (!existing) next.createdAt = next.createdAt || new Date()
  }
  if (resource === 'invoices') {
    if (existing && !['Draft'].includes(existing.status)) throw new AppError(409, 'INVOICE_LOCKED', 'Only draft invoices can be edited.')
    next.status = existing?.status || 'Draft'
    delete next.issuedAt
    const projectId = next.projectId || existing?.projectId
    const agreementId = next.agreementId || existing?.agreementId
    if (projectId) {
      const project = await Project.findOne({ id: projectId }).session(session || null)
      if (!project) throw new AppError(400, 'PROJECT_NOT_FOUND', 'The linked project was not found.')
      if (project.clientId !== (next.clientId || existing?.clientId)) throw new AppError(400, 'CLIENT_MISMATCH', 'The project belongs to a different client.')
      next.project = project.name
    }
    if (agreementId) {
      const agreement = await Agreement.findOne({ id: agreementId }).session(session || null)
      if (!agreement || agreement.status !== 'Accepted') throw new AppError(400, 'AGREEMENT_NOT_ACCEPTED', 'Invoices can only reference an accepted work order.')
      if (agreement.clientId !== (next.clientId || existing?.clientId)) throw new AppError(400, 'CLIENT_MISMATCH', 'The work order belongs to a different client.')
    }
  }
  if (resource === 'payments') {
    if (existing && existing.status !== 'Pending') throw new AppError(409, 'PAYMENT_IMMUTABLE', 'Recorded payments cannot be edited. Use the refund or correction workflow.')
  }
  if (resource === 'projects') {
    if (next.managerId || next.manager) Object.assign(next, await resolveAssignee({ assigneeId: next.managerId, assignee: next.manager }, session)
      .then(({ assigneeId, assignee }) => ({ managerId: assigneeId, manager: assignee })))
    if (next.agreementId) {
      const agreement = await Agreement.findOne({ id: next.agreementId }).session(session || null)
      if (!agreement || agreement.status !== 'Accepted') throw new AppError(400, 'AGREEMENT_NOT_ACCEPTED', 'Projects can only be linked to an accepted work order.')
      next.clientId = agreement.clientId
      next.client = agreement.client
      next.quotationId = agreement.quotationId
    }
  }
  if (resource === 'tasks') {
    const project = await Project.findOne({ id: next.projectId || existing?.projectId }).session(session || null)
    if (!project) throw new AppError(400, 'PROJECT_NOT_FOUND', 'The selected project was not found.')
    if (user.role === 'developer' && Object.keys(next).some((field) => !['status', 'progress'].includes(field))) {
      throw new AppError(403, 'TASK_FIELDS_FORBIDDEN', 'Developers may update only task status and progress.')
    }
    const unchangedProject = existing && project.id === existing.projectId
    if (!unchangedProject && !recordCanAccess('projects', project, user)) {
      throw new AppError(403, 'PROJECT_ACCESS_DENIED', 'You cannot assign work to this project.')
    }
    next.projectId = project.id
    next.project = project.name
    if (next.assigneeId || next.assignee) Object.assign(next, await resolveAssignee(next, session))
  }
  if (resource === 'notifications') {
    if (existing && existing.recipientId !== user.id) throw new AppError(404, 'RECORD_NOT_FOUND', 'Record was not found.')
  }
  if (resource === 'quotations' || resource === 'invoices') {
    const calculated = await calculateFinancialPayload(resource, next, existing)
    next = { ...next, ...calculated }
    if (resource === 'invoices' && existing && !next.items?.length && !existing.items?.length && !existing.lineItems?.length) {
      next.total = existing.total
      next.amount = existing.amount || existing.total
    }
  }
  return next
}

function searchableFields(resource) {
  return {
    leads: ['id', 'name', 'company', 'email', 'phone', 'service', 'source'],
    followups: ['id', 'contact', 'company', 'leadId', 'type', 'assignee'],
    clients: ['id', 'name', 'company', 'email', 'phone'],
    quotations: ['id', 'client', 'title', 'status'],
    agreements: ['id', 'client', 'quotationId', 'project', 'status'],
    invoices: ['id', 'client', 'project', 'status'],
    payments: ['id', 'client', 'invoiceId', 'reference', 'transactionReference'],
    projects: ['id', 'name', 'client', 'manager', 'status'],
    tasks: ['id', 'title', 'project', 'assignee', 'status'],
    notifications: ['id', 'title', 'body', 'category'],
  }[resource]
}

export async function listResources(resource, req) {
  const Model = modelsByResource[resource]
  const query = resourceQuerySchema.parse(req.query)
  const { page, limit, sort, order } = query
  const filter = { ...(await buildScope(resource, req.user)) }
  if (query.status && resource !== 'notifications') filter.status = query.status
  if (query.read !== undefined && resource === 'notifications') filter.read = query.read === 'true'
  if (query.assigneeId && ['leads', 'followups', 'tasks'].includes(resource)) filter.assigneeId = query.assigneeId
  if (query.from || query.to) {
    const dateField = resource === 'invoices' ? 'issueDate' : resource === 'payments' ? 'date' : resource === 'followups' || resource === 'tasks' ? 'dueDate' : 'createdAt'
    filter[dateField] = {
      ...(query.from ? { $gte: query.from } : {}),
      ...(query.to ? { $lte: query.to } : {}),
    }
  }
  if (query.search) {
    const term = new RegExp(escapeRegex(query.search), 'i')
    filter.$and = [{ $or: searchableFields(resource).map((field) => ({ [field]: term })) }]
  }
  const pageNumber = Math.max(1, Number(page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 25))
  const sortField = ['createdAt', 'updatedAt', 'issueDate', 'dueDate', 'date', 'name', 'status'].includes(sort) ? sort : 'createdAt'
  const sortOrder = order === 'asc' ? 1 : -1
  const [rows, total] = await Promise.all([
    Model.find(filter).sort({ [sortField]: sortOrder }).skip((pageNumber - 1) * pageSize).limit(pageSize),
    Model.countDocuments(filter),
  ])
  const records = rows.map((row) => {
    const record = safeResource(resource, row, req.user)
    if (resource === 'followups' && record.status !== 'Completed') {
      const due = new Date(`${record.dueDate}T00:00:00`)
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      due.setHours(0, 0, 0, 0)
      const tomorrow = new Date(today)
      tomorrow.setDate(tomorrow.getDate() + 1)
      record.status = due < today ? 'Overdue' : due < tomorrow ? 'Due today' : 'Upcoming'
    }
    if (resource === 'invoices' && record.status !== 'Draft' && record.status !== 'Paid' && record.status !== 'Cancelled'
      && Number(record.balance) > 0 && new Date(`${record.dueDate}T00:00:00`) < new Date(new Date().setHours(0, 0, 0, 0))) {
      record.status = 'Overdue'
    }
    return record
  })
  return { records, meta: { page: pageNumber, limit: pageSize, total, pages: Math.ceil(total / pageSize) } }
}

export async function summarizeResource(resource, user) {
  const Model = modelsByResource[resource]
  const pipeline = [{ $match: await buildScope(resource, user) }]
  let statusField = '$status'
  if (resource === 'followups' || resource === 'invoices') {
    const startOfToday = new Date()
    startOfToday.setUTCHours(0, 0, 0, 0)
    const startOfTomorrow = new Date(startOfToday)
    startOfTomorrow.setUTCDate(startOfTomorrow.getUTCDate() + 1)
    if (resource === 'invoices') {
      pipeline.push({
        $addFields: {
          summaryStatus: {
            $switch: {
              branches: [
                { case: { $in: ['$status', ['Draft', 'Paid', 'Cancelled']] }, then: '$status' },
                { case: { $lt: ['$dueDate', startOfToday] }, then: 'Overdue' },
              ],
              default: '$status',
            },
          },
        },
      })
      statusField = '$summaryStatus'
    } else {
      pipeline.push({
        $addFields: {
          summaryStatus: {
            $switch: {
              branches: [
                { case: { $eq: ['$status', 'Completed'] }, then: 'Completed' },
                { case: { $lt: ['$dueDate', startOfToday] }, then: 'Overdue' },
                { case: { $lt: ['$dueDate', startOfTomorrow] }, then: 'Due today' },
              ],
              default: 'Upcoming',
            },
          },
        },
      })
      statusField = '$summaryStatus'
    }
  }
  pipeline.push({
    $group: {
      _id: statusField,
      count: { $sum: 1 },
      total: { $sum: { $ifNull: ['$total', 0] } },
      amount: { $sum: { $ifNull: ['$amount', 0] } },
      amountPaid: { $sum: { $ifNull: ['$amountPaid', 0] } },
      balance: { $sum: { $ifNull: ['$balance', 0] } },
      progress: { $sum: { $ifNull: ['$progress', 0] } },
    },
  })
  const groups = await Model.aggregate(pipeline)
  return groups.reduce((summary, group) => {
    const status = group._id || 'Unspecified'
    summary.total += group.count
    summary.byStatus[status] = group.count
    summary.totalAmount += group.total
    summary.amount += group.amount
    summary.amountPaid += group.amountPaid
    summary.balance += group.balance
    summary.progress += group.progress
    summary.totalByStatus[status] = group.total
    summary.amountByStatus[status] = group.amount
    summary.balanceByStatus[status] = group.balance
    summary.progressByStatus[status] = group.progress
    return summary
  }, {
    total: 0, byStatus: {}, totalAmount: 0, amount: 0, amountPaid: 0, balance: 0, progress: 0,
    totalByStatus: {}, amountByStatus: {}, balanceByStatus: {}, progressByStatus: {},
  })
}

export async function summarizeLeadSources(user) {
  return modelsByResource.leads.aggregate([
    { $match: await buildScope('leads', user) },
    { $group: { _id: { $ifNull: ['$source', 'Other'] }, value: { $sum: 1 } } },
    { $sort: { value: -1, _id: 1 } },
  ]).then((groups) => groups.map(({ _id, value }) => ({ name: _id, value })))
}

export async function getResource(resource, id, user) {
  const record = await findScoped(resource, id, user)
  return safeResource(resource, record, user)
}

function safeResource(resource, record, user) {
  const value = record.toJSON()
  if (user.role === 'client' && resource === 'payments') {
    delete value.recordedBy
    delete value.recordedById
  }
  return value
}

export async function createResource(resource, body, req) {
  if (resource === 'payments') return createPayment(body, req)
  const Model = modelsByResource[resource]
  const session = await mongoose.startSession()
  let record
  let warnings = []
  try {
    await session.withTransaction(async () => {
      let payload = await preparePayload(resource, body, req.user, null, session)
      payload.id = await nextId(resource, session)
      if (resource === 'leads') {
        payload.status = 'New'
        payload.createdAt = payload.createdAt || new Date()
        const emailMatches = await Model.find({ email: payload.email.toLowerCase() }).select('id').session(session)
        const phone = normalizePhone(payload.phone)
        const phoneMatches = phone ? await Model.find({ normalizedPhone: phone }).select('id').session(session) : []
        warnings = [...new Set([
          ...emailMatches.map((item) => item.id),
          ...phoneMatches.map((item) => item.id),
        ])]
        if (payload.assigneeId && payload.assigneeId !== req.user.id) {
          await createNotification({
            recipientId: payload.assigneeId,
            title: 'Lead assigned to you',
            body: `${payload.name} · ${payload.company}`,
            category: 'Leads',
            href: '/leads',
            eventType: 'lead.assignment',
          }, session)
        }
      }
      if (resource === 'quotations') payload.status = 'Draft'
      if (resource === 'agreements') payload.status = 'Draft'
      if (resource === 'invoices') {
        payload.status = 'Draft'
      }
      if (resource === 'payments') payload.status = 'Recorded'
      record = await new Model(payload).save({ session })
      await recordAudit(req, `${resource}.created`, resource, record.id, { fields: Object.keys(payload) }, session)
    })
  } finally {
    await session.endSession()
  }
  return { record: record.toJSON(), warnings: warnings.length ? { possibleDuplicateIds: warnings } : undefined }
}

export async function updateResource(resource, id, body, req) {
  if (resource === 'payments') return updatePayment(id, body, req)
  const session = await mongoose.startSession()
  let record
  try {
    await session.withTransaction(async () => {
      const current = await findScoped(resource, id, req.user)
      let payload = await preparePayload(resource, body, req.user, current, session)
      if (resource === 'notifications' && Object.hasOwn(payload, 'read')) {
        if (current.recipientId !== req.user.id) throw new AppError(404, 'RECORD_NOT_FOUND', 'Record was not found.')
      }
      if (resource === 'leads' && payload.status === 'Won') {
        const converted = await convertLeadInTransaction(current, req, session)
        payload.convertedClientId = converted.client.id
      }
      current.set(payload)
      record = await current.save({ session })
      await recordAudit(req, `${resource}.updated`, resource, record.id, { fields: Object.keys(payload) }, session)
    })
  } finally {
    await session.endSession()
  }
  return record.toJSON()
}

export async function deleteResource(resource, id, req) {
  if (resource === 'payments' || resource === 'invoices' || resource === 'quotations' || resource === 'agreements') {
    throw new AppError(409, 'IMMUTABLE_RESOURCE', 'This record cannot be deleted; use its cancellation or reversal workflow.')
  }
  const record = await findScoped(resource, id, req.user)
  await record.deleteOne()
  await recordAudit(req, `${resource}.deleted`, resource, id, {})
  return { id }
}

async function createPayment(body, req) {
  const suppliedKey = req.get('Idempotency-Key')?.trim()
  const key = suppliedKey ? `${req.user.id}:${suppliedKey}` : undefined
  if (key && key.length > 160) throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key is too long.')
  const fingerprint = createHash('sha256').update(JSON.stringify([
    body.invoiceId, body.amount, body.date, body.method, body.reference || '', body.transactionReference || '',
  ])).digest('hex')
  if (key) {
    const replay = await findPaymentReplay(key, fingerprint, req.user)
    if (replay) return replay
  }
  const session = await mongoose.startSession()
  let payment
  try {
    await session.withTransaction(async () => {
      const invoice = await Invoice.findOne({ id: body.invoiceId }).session(session)
      if (!invoice || invoice.status === 'Cancelled' || invoice.status === 'Draft') {
        throw new AppError(400, 'INVOICE_NOT_PAYABLE', 'Select an issued invoice that can accept payments.')
      }
      if (!recordCanAccess('invoices', invoice, req.user)) throw new AppError(404, 'INVOICE_NOT_FOUND', 'Invoice was not found.')
      const existingPayments = await Payment.find({ invoiceId: invoice.id, status: { $nin: ['Refunded', 'Pending'] } }).session(session)
      const paid = existingPayments.reduce((sum, item) => sum + Number(item.amount), 0)
      const remaining = toMoney(Math.max(0, invoice.total - paid))
      if (Number(body.amount) > remaining) throw new AppError(409, 'PAYMENT_EXCEEDS_BALANCE', 'Payment exceeds the remaining invoice balance.')
      payment = await Payment.create([{
        ...body,
        id: await nextId('payments', session),
        clientId: invoice.clientId,
        client: invoice.client,
        projectId: invoice.projectId,
        project: invoice.project,
        status: 'Recorded',
        recordedById: req.user.id,
        recordedBy: req.user.name,
        ...(key ? { idempotencyKey: key, idempotencyFingerprint: fingerprint } : {}),
      }], { session }).then(([created]) => created)
      const newPaid = toMoney(paid + Number(payment.amount))
      invoice.amountPaid = newPaid
      invoice.balance = toMoney(Math.max(0, invoice.total - newPaid))
      invoice.status = invoice.balance <= 0 ? 'Paid' : 'Partially Paid'
      await invoice.save({ session })
      await recordAudit(req, 'payments.recorded', 'payments', payment.id, { invoiceId: invoice.id, amount: payment.amount }, session)
      const clientUser = await User.findOne({ clientId: invoice.clientId, role: 'client', status: 'Active' }).session(session)
      await createNotification({
        recipientId: clientUser?.id,
        title: 'Payment recorded',
        body: `${payment.id} · ${invoice.id}`,
        category: 'Finance',
        href: '/client-portal',
        eventType: 'payment.recorded',
      }, session)
    })
  } catch (error) {
    if (key && error.code === 11000) {
      const replay = await findPaymentReplay(key, fingerprint, req.user)
      if (replay) return replay
    }
    throw error
  } finally {
    await session.endSession()
  }
  return { record: payment.toJSON() }
}

async function updatePayment(id, body, req) {
  if (Object.keys(body).some((key) => key !== 'status')) {
    throw new AppError(409, 'PAYMENT_IMMUTABLE', 'Recorded payment details cannot be edited; use the refund or correction workflow.')
  }
  const payment = await findScoped('payments', id, req.user)
  if (body.status !== payment.status) {
    throw new AppError(409, 'USE_REFUND_ACTION', 'Use the payment refund action to reverse a recorded payment.')
  }
  return payment.toJSON()
}

async function convertLeadInTransaction(lead, req, session) {
  const existing = await Client.findOne({ leadId: lead.id }).session(session)
  if (existing) return { client: existing.toJSON(), created: false }
  const client = await Client.create([{
    id: await nextId('clients', session),
    leadId: lead.id,
    name: lead.name,
    company: lead.company,
    email: lead.email,
    phone: lead.phone,
    normalizedPhone: normalizePhone(lead.phone),
    status: 'Active',
    since: new Date(),
  }], { session }).then(([created]) => created)
  await recordAudit(req, 'leads.converted', 'leads', lead.id, { clientId: client.id }, session)
  return { client: client.toJSON(), created: true }
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '')
}

export async function convertLead(id, req) {
  const session = await mongoose.startSession()
  let result
  try {
    await session.withTransaction(async () => {
      const lead = await findScoped('leads', id, req.user)
      if (lead.status === 'Lost') throw new AppError(409, 'LEAD_NOT_CONVERTIBLE', 'Lost leads cannot be converted.')
      const conversion = await convertLeadInTransaction(lead, req, session)
      lead.status = 'Won'
      lead.convertedClientId = conversion.client.id
      await lead.save({ session })
      result = conversion
    })
  } finally {
    await session.endSession()
  }
  return result
}

export async function recordLeadActivity(id, body, req) {
  const lead = await findScoped('leads', id, req.user)
  const activity = {
    id: `ACT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: body.type,
    text: body.text,
    authorId: req.user.id,
    author: req.user.name,
    createdAt: new Date(),
  }
  lead.activities.push(activity)
  await lead.save()
  await recordAudit(req, 'leads.activity_recorded', 'leads', lead.id, { activityId: activity.id })
  return activity
}

export async function transitionQuotation(id, action, body, req) {
  const quote = await findScoped('quotations', id, req.user)
  if (action === 'send' || action === 'approve' || action === 'reject') {
    const isClientTransition = ['approve', 'reject'].includes(action) && req.user.role === 'client'
    const canSend = action === 'send' && hasPermission(req.user, 'quotations.create')
    if (!isClientTransition && !canSend && !hasPermission(req.user, 'quotations.approve')) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to change quotation status.')
    }
    if (action === 'send' && quote.status !== 'Draft') throw new AppError(409, 'INVALID_TRANSITION', 'Only draft quotations can be sent.')
    if (action === 'approve' && !['Sent', 'Viewed'].includes(quote.status)) throw new AppError(409, 'INVALID_TRANSITION', 'Only sent quotations can be accepted.')
    if (action === 'reject' && !['Sent', 'Viewed'].includes(quote.status)) throw new AppError(409, 'INVALID_TRANSITION', 'Only sent quotations can be rejected.')
    quote.status = action === 'send' ? 'Sent' : action === 'approve' ? 'Accepted' : 'Rejected'
    if (action === 'send') quote.sentAt = new Date()
    if (action === 'approve') {
      quote.acceptedAt = new Date()
      quote.acceptance = { acceptedBy: req.user.id, acceptedAt: quote.acceptedAt, method: 'authenticated-portal-acknowledgement' }
      quote.acceptedSnapshot = quote.toObject()
    }
    if (action === 'reject') quote.rejectedAt = new Date()
    await quote.save()
    await recordAudit(req, `quotations.${action}`, 'quotations', quote.id, { status: quote.status })
    if (action === 'send' && quote.clientId) {
      const account = await User.findOne({ clientId: quote.clientId, role: 'client', status: 'Active' })
      if (account) await createNotification({
        recipientId: account.id, title: 'Quotation updated', body: `${quote.id} · ${quote.title}`,
        category: 'Sales', href: '/client-portal', eventType: `quotation.${action}`,
      })
    }
    return quote.toJSON()
  }
  if (action === 'revise') {
    if (!hasPermission(req.user, 'quotations.create')) throw new AppError(403, 'FORBIDDEN', 'You cannot revise this quotation.')
    const copy = quote.toObject()
    delete copy._id
    delete copy.id
    delete copy.createdAt
    delete copy.updatedAt
    const revision = await new Quotation({
      ...copy,
      id: await nextId('quotations'),
      number: undefined,
      version: (quote.version || 1) + 1,
      revisionOf: quote.id,
      revisionReason: body.reason,
      revisionDate: new Date(),
      status: 'Draft',
      sentAt: undefined,
      acceptedAt: undefined,
      acceptedSnapshot: undefined,
      acceptance: undefined,
    }).save()
    await recordAudit(req, 'quotations.revised', 'quotations', revision.id, { revisionOf: quote.id, version: revision.version })
    return revision.toJSON()
  }
  throw new AppError(400, 'INVALID_ACTION', 'Unsupported quotation action.')
}

export async function acceptAgreement(id, req) {
  const agreement = await findScoped('agreements', id, req.user)
  if (req.user.role !== 'client' && !hasPermission(req.user, 'agreements.approve')) {
    throw new AppError(403, 'FORBIDDEN', 'You cannot accept this work order.')
  }
  if (agreement.status !== 'Pending approval') throw new AppError(409, 'INVALID_TRANSITION', 'Only work orders pending approval can be accepted.')
  agreement.status = 'Accepted'
  agreement.acceptedAt = new Date()
  agreement.acceptedBy = req.user.id
  agreement.acceptance = { acceptedBy: req.user.id, acceptedAt: agreement.acceptedAt, method: 'authenticated-portal-acknowledgement' }
  agreement.acceptedSnapshot = agreement.toObject()
  await agreement.save()
  await recordAudit(req, 'agreements.accepted', 'agreements', agreement.id, { version: agreement.version })
  return agreement.toJSON()
}

export async function rejectAgreement(id, reason, req) {
  const agreement = await findScoped('agreements', id, req.user)
  if (req.user.role !== 'client' && !hasPermission(req.user, 'agreements.approve')) {
    throw new AppError(403, 'FORBIDDEN', 'You cannot reject this work order.')
  }
  if (agreement.status !== 'Pending approval') throw new AppError(409, 'INVALID_TRANSITION', 'Only work orders pending approval can be rejected.')
  agreement.status = 'Rejected'
  agreement.rejectedAt = new Date()
  agreement.rejectionReason = reason
  await agreement.save()
  await recordAudit(req, 'agreements.rejected', 'agreements', agreement.id, { reason })
  const quote = agreement.quotationId ? await Quotation.findOne({ id: agreement.quotationId }) : null
  if (quote?.ownerId) await createNotification({
    recipientId: quote.ownerId,
    title: 'Work order rejected',
    body: `${agreement.id} · ${agreement.project}`,
    category: 'Delivery',
    href: '/agreements',
    eventType: 'agreement.rejected',
  })
  return agreement.toJSON()
}

export async function submitAgreement(id, req) {
  const agreement = await findScoped('agreements', id, req.user)
  if (!hasPermission(req.user, 'agreements.approve')) throw new AppError(403, 'FORBIDDEN', 'You cannot submit this work order for approval.')
  if (agreement.status !== 'Draft') throw new AppError(409, 'INVALID_TRANSITION', 'Only draft work orders can be submitted.')
  agreement.status = 'Pending approval'
  await agreement.save()
  await recordAudit(req, 'agreements.submitted', 'agreements', agreement.id, { status: agreement.status })
  const clientUser = await User.findOne({ clientId: agreement.clientId, role: 'client', status: 'Active' })
  if (clientUser) await createNotification({
    recipientId: clientUser.id,
    title: 'Work order awaiting your approval',
    body: `${agreement.id} · ${agreement.project}`,
    category: 'Delivery',
    href: '/client-portal',
    eventType: 'agreement.submitted',
  })
  return agreement.toJSON()
}

export async function issueInvoice(id, req) {
  const invoice = await findScoped('invoices', id, req.user)
  if (invoice.status !== 'Draft') throw new AppError(409, 'INVALID_TRANSITION', 'Only draft invoices can be issued.')
  invoice.status = 'Issued'
  invoice.issuedAt = new Date()
  invoice.balance = toMoney(Math.max(0, invoice.total - invoice.amountPaid))
  await invoice.save()
  await recordAudit(req, 'invoices.issued', 'invoices', invoice.id, { status: invoice.status })
  const clientUser = await User.findOne({ clientId: invoice.clientId, role: 'client', status: 'Active' })
  if (clientUser) await createNotification({
    recipientId: clientUser.id,
    title: 'New invoice',
    body: `${invoice.id} · ${invoice.client}`,
    category: 'Finance',
    href: '/client-portal',
    eventType: 'invoice.issued',
  })
  return invoice.toJSON()
}

export async function refundPayment(id, body, req) {
  const payment = await Payment.findOne({ id })
  if (!payment) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment was not found.')
  if (!hasPermission(req.user, 'payments.manage')) throw new AppError(403, 'FORBIDDEN', 'You cannot reverse this payment.')
  if (payment.status !== 'Recorded') throw new AppError(409, 'INVALID_PAYMENT_STATE', 'Only recorded payments can be refunded.')
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      const currentPayment = await Payment.findOne({ id }).session(session)
      if (!currentPayment || currentPayment.status !== 'Recorded') {
        throw new AppError(409, 'INVALID_PAYMENT_STATE', 'Only recorded payments can be refunded.')
      }
      const invoice = currentPayment.invoiceId ? await Invoice.findOne({ id: currentPayment.invoiceId }).session(session) : null
      currentPayment.status = 'Refunded'
      currentPayment.refundedAt = new Date()
      currentPayment.refundReason = body.reason
      await currentPayment.save({ session })
      if (invoice) {
        const activePayments = await Payment.find({ invoiceId: invoice.id, status: 'Recorded' }).session(session)
        const paid = toMoney(activePayments.reduce((sum, item) => sum + Number(item.amount), 0))
        invoice.amountPaid = paid
        invoice.balance = toMoney(Math.max(0, invoice.total - paid))
        invoice.status = paid >= invoice.total ? 'Paid' : paid > 0 ? 'Partially Paid' : (invoice.dueDate < new Date() ? 'Overdue' : 'Issued')
        await invoice.save({ session })
      }
      await recordAudit(req, 'payments.refunded', 'payments', id, { reason: body.reason }, session)
    })
  } finally {
    await session.endSession()
  }
  return (await Payment.findOne({ id })).toJSON()
}

export async function addTaskComment(id, body, req) {
  const task = await findScoped('tasks', id, req.user)
  if (!hasPermission(req.user, 'tasks.comment.internal')) throw new AppError(403, 'FORBIDDEN', 'You cannot add internal comments.')
  const comment = {
    id: `COMMENT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    authorId: req.user.id,
    author: req.user.name,
    createdAt: new Date(),
    text: body.text,
  }
  task.internalComments.push(comment)
  await task.save()
  await recordAudit(req, 'tasks.comment_added', 'tasks', id, { commentId: comment.id })
  return comment
}
