import mongoose from 'mongoose'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '../errors/AppError.js'
import { hasPermission } from '../middleware/authorize.js'
import { modelsByResource, Client, Invoice, Payment, Project, Quotation, Agreement, User, Lead, Task } from '../models/index.js'
import { recordAudit } from './audit.js'
import { nextId } from './ids.js'
import { createNotification } from './notifications.js'
import { calculateDocument, toMoney } from './financials.js'
import { paginationSchema } from '../middleware/pagination.js'

export const resourcePermissions = {
  leads: { read: ['leads.view.all', 'leads.view.assigned'], create: ['leads.create'], update: ['leads.update'], delete: ['leads.delete'] },
  followups: { read: ['followups.view'], create: ['followups.create'], update: ['followups.update'], delete: ['followups.delete'] },
  clients: { read: ['clients.view'], create: ['clients.manage'], update: ['clients.manage'], delete: ['clients.manage'] },
  quotations: { read: ['quotations.view', 'quotations.view.own'], create: ['quotations.create'], update: ['quotations.create'], delete: ['quotations.create'] },
  agreements: { read: ['agreements.view', 'agreements.view.own'], create: ['agreements.approve'], update: ['agreements.approve'], delete: [] },
  invoices: { read: ['invoices.view', 'invoices.view.own', 'invoices.manage'], create: ['invoices.manage'], update: ['invoices.manage'], delete: [] },
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
const snapshotFields = (record, fields) => record
  ? Object.fromEntries(fields.filter((field) => record[field] !== undefined).map((field) => [field, record[field]]))
  : undefined
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
    return {
      clientId: user.clientId,
      ...(resource === 'quotations' ? { status: { $ne: 'Draft' } } : {}),
    }
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

async function findScoped(resource, id, user, session) {
  const Model = modelsByResource[resource]
  let query = Model.findOne({ id, ...(await buildScope(resource, user)) })
  if (session) query = query.session(session)
  const record = await query
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
  if (resource === 'projects' && existing?.status === 'Closed') {
    throw new AppError(409, 'PROJECT_CLOSED', 'Closed projects are read-only so their delivery history remains intact.')
  }
  if (resource === 'projects' && next.status === 'Closed') {
    throw new AppError(409, 'PROJECT_CLOSE_WORKFLOW_REQUIRED', 'Use the project handover workflow to close a project.')
  }
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
  delete next.acceptedBy
  delete next.acceptance
  delete next.acceptedSnapshot
  delete next.rejectedAt
  delete next.rejectedBy
  delete next.rejection
  delete next.invoiceAllocationVersion
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
    if (Object.hasOwn(next, 'status')) {
      next.completedAt = next.status === 'Completed'
        ? (existing?.status === 'Completed' ? existing.completedAt || new Date() : new Date())
        : undefined
    }
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
    let agreement
    if (projectId) {
      const project = await Project.findOne({ id: projectId }).session(session || null)
      if (!project) throw new AppError(400, 'PROJECT_NOT_FOUND', 'The linked project was not found.')
      if (project.clientId !== (next.clientId || existing?.clientId)) throw new AppError(400, 'CLIENT_MISMATCH', 'The project belongs to a different client.')
      next.project = project.name
    }
    if (agreementId) {
      if (!hasPermission(user, 'agreements.view') && !hasPermission(user, 'agreements.view.own')) {
        throw new AppError(404, 'RECORD_NOT_FOUND', 'Record was not found.')
      }
      agreement = await Agreement.findOne({
        id: agreementId,
        ...(await buildScope('agreements', user)),
      }).session(session || null)
      if (!agreement || !recordCanAccess('agreements', agreement, user)) {
        throw new AppError(404, 'RECORD_NOT_FOUND', 'Record was not found.')
      }
      if (!agreement || agreement.status !== 'Accepted') throw new AppError(400, 'AGREEMENT_NOT_ACCEPTED', 'Invoices can only reference an accepted work order.')
      if (agreement.clientId !== (next.clientId || existing?.clientId)) throw new AppError(400, 'CLIENT_MISMATCH', 'The work order belongs to a different client.')
    }

    const quotationId = next.quotationId || existing?.quotationId || agreement?.quotationId
    if (existing?.quotationId && next.quotationId && next.quotationId !== existing.quotationId) {
      throw new AppError(409, 'INVOICE_SOURCE_LOCKED', 'An invoice source cannot be changed after creation.')
    }
    if (existing?.agreementId && next.agreementId && next.agreementId !== existing.agreementId) {
      throw new AppError(409, 'INVOICE_SOURCE_LOCKED', 'An invoice source cannot be changed after creation.')
    }
    let quotation
    if (quotationId) {
      if (agreement?.quotationId && agreement.quotationId !== quotationId) {
        throw new AppError(400, 'QUOTATION_MISMATCH', 'The quotation does not match the accepted work order.')
      }
      if (!hasPermission(user, 'quotations.view') && !hasPermission(user, 'quotations.view.own')) {
        throw new AppError(404, 'RECORD_NOT_FOUND', 'Record was not found.')
      }
      quotation = await Quotation.findOne({
        id: quotationId,
        ...(await buildScope('quotations', user)),
      }).session(session || null)
      if (!quotation || !recordCanAccess('quotations', quotation, user)) {
        throw new AppError(404, 'RECORD_NOT_FOUND', 'Record was not found.')
      }
      if (quotation.status !== 'Accepted') {
        throw new AppError(400, 'QUOTATION_NOT_ACCEPTED', 'Invoices can only reference an accepted quotation.')
      }
      if (agreement && quotation.clientId !== agreement.clientId) {
        throw new AppError(400, 'CLIENT_MISMATCH', 'The quotation and work order belong to different clients.')
      }
    }

    if (agreement || quotationId) {
      const sourceClientId = agreement?.clientId || quotation?.clientId
      if (!sourceClientId || (next.clientId && next.clientId !== sourceClientId)) {
        throw new AppError(400, 'CLIENT_MISMATCH', 'The invoice client must match its accepted source.')
      }
      const acceptedQuotation = quotation?.acceptedSnapshot
      const sourceData = quotation
        ? (acceptedQuotation?.items?.length || acceptedQuotation?.lineItems?.length
          ? acceptedQuotation
          : quotation.toJSON())
        : (agreement?.quotationSnapshot || agreement?.acceptedSnapshot?.quotationSnapshot)
      const sourceItems = sourceData?.items?.length ? sourceData.items : sourceData?.lineItems
      if (!sourceItems?.length) {
        throw new AppError(400, 'SOURCE_ITEMS_REQUIRED', 'The accepted source has no saved line items to invoice.')
      }
      const sourceKey = `contract:${quotationId ? `quotation:${quotationId}` : `agreement:${agreement.id}`}`
      const allocationModel = quotation ? Quotation : Agreement
      const allocationId = quotation?.id || agreement?.id
      const allocationUpdate = await allocationModel.updateOne(
        { id: allocationId, status: 'Accepted' },
        { $inc: { invoiceAllocationVersion: 1 } },
      ).session(session || null)
      if (!allocationUpdate.matchedCount) {
        throw new AppError(409, 'CONTRACT_NOT_ACCEPTED', 'The accepted contract changed. Reload it before creating an invoice.')
      }

      next.clientId = sourceClientId
      next.client = quotation?.client || agreement?.client || next.client
      next.agreementId = agreement?.id
      next.quotationId = quotationId
      next.billingSourceKey = existing?.billingSourceKey || sourceKey
      next.sourceSnapshot = existing?.sourceSnapshot || {
        kind: agreement ? 'agreement' : 'quotation',
        agreement: snapshotFields(agreement?.toObject?.(), [
          'id', 'quotationId', 'clientId', 'client', 'projectId', 'project',
          'scope', 'deliverables', 'startDate', 'deadline', 'paymentMilestones',
          'terms', 'status', 'acceptedAt',
        ]),
        quotation: snapshotFields(sourceData, [
          'id', 'number', 'clientId', 'client', 'title', 'issueDate', 'validUntil',
          'items', 'lineItems', 'subtotal', 'discount', 'taxableValue', 'gstEnabled',
          'sgstEnabled', 'cgstEnabled', 'sgstRate', 'cgstRate', 'sgstAmount',
          'cgstAmount', 'tax', 'total', 'amount', 'terms', 'billingName',
          'billingAddress', 'customerGstin', 'contactEmail', 'contactPhone',
          'companyGstin', 'companyAddress', 'bankDetails',
        ]),
      }
      if (!quoteLineItems(next)?.length) next.items = existing?.items?.length ? existing.items : sourceItems
      delete next.lineItems
      next.discount ??= existing?.discount ?? sourceData.discount ?? 0
      next.gstEnabled ??= existing?.gstEnabled ?? Boolean(sourceData.gstEnabled)
      next.sgstEnabled ??= existing?.sgstEnabled ?? sourceData.sgstEnabled ?? true
      next.cgstEnabled ??= existing?.cgstEnabled ?? sourceData.cgstEnabled ?? true
      next.sgstRate ??= existing?.sgstRate ?? sourceData.sgstRate ?? 0
      next.cgstRate ??= existing?.cgstRate ?? sourceData.cgstRate ?? 0
      next.terms ??= existing?.terms ?? sourceData.terms
      next.billingName ??= existing?.billingName ?? sourceData.billingName
      next.billingAddress ??= existing?.billingAddress ?? sourceData.billingAddress
      next.customerGstin ??= existing?.customerGstin ?? sourceData.customerGstin
      next.contactEmail ??= existing?.contactEmail ?? sourceData.contactEmail
      next.contactPhone ??= existing?.contactPhone ?? sourceData.contactPhone
      next.project = next.project || existing?.project || agreement?.project || sourceData.title
      if (agreement?.projectId) {
        const agreementProject = await Project.findOne({ id: agreement.projectId }).session(session || null)
        if (!agreementProject || agreementProject.clientId !== sourceClientId
          || agreementProject.agreementId !== agreement.id) {
          throw new AppError(400, 'PROJECT_MISMATCH', 'The linked project does not belong to this accepted work order.')
        }
        if (agreementProject.status === 'Closed') {
          throw new AppError(409, 'PROJECT_CLOSED', 'A closed project cannot receive new invoices.')
        }
        next.projectId = agreementProject.id
        next.project = agreementProject.name
      }
    }
    if (next.projectId || existing?.projectId) {
      const linkedProject = await Project.findOne({ id: next.projectId || existing.projectId }).session(session || null)
      if (linkedProject?.status === 'Closed') {
        throw new AppError(409, 'PROJECT_CLOSED', 'A closed project cannot receive new invoices.')
      }
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
    if (project.status === 'Closed') throw new AppError(409, 'PROJECT_CLOSED', 'Tasks in a closed project cannot be changed.')
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

async function validateInvoiceAllocation(payload, existing, session) {
  if (!payload.quotationId && !payload.agreementId) return
  const source = payload.sourceSnapshot?.quotation || payload.sourceSnapshot?.agreement
  const contractTotal = Number(source?.total ?? source?.amount)
  if (!Number.isFinite(contractTotal) || contractTotal <= 0) {
    throw new AppError(400, 'CONTRACT_TOTAL_REQUIRED', 'The accepted contract does not have a valid total for invoice allocation.')
  }

  const sources = []
  if (payload.quotationId) sources.push({ quotationId: payload.quotationId })
  if (payload.agreementId) sources.push({ agreementId: payload.agreementId })
  const invoices = await Invoice.find({
    $or: sources,
    status: { $ne: 'Cancelled' },
  }).session(session || null)
  const allocated = invoices
    .filter((invoice) => invoice.id !== existing?.id)
    .reduce((sum, invoice) => sum + Number(invoice.total || invoice.amount || 0), 0)
  const totalWithCurrent = toMoney(allocated + Number(payload.total || payload.amount || 0))
  if (totalWithCurrent > toMoney(contractTotal)) {
    const remaining = toMoney(Math.max(0, contractTotal - allocated))
    throw new AppError(
      409,
      'INVOICE_EXCEEDS_CONTRACT',
      `This invoice exceeds the remaining accepted contract amount of ${remaining}.`,
    )
  }
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
  if (query.status && resource !== 'notifications') {
    filter.status = resource === 'quotations' && req.user.role === 'client' && query.status === 'Draft'
      ? '__client_cannot_view_draft__'
      : query.status
  }
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

export function safeResource(resource, record, user) {
  const value = record.toJSON()
  if (user.role === 'client' && resource === 'payments') {
    delete value.recordedBy
    delete value.recordedById
  }
  if (user.role === 'client' && resource === 'quotations') {
    delete value.owner
    delete value.ownerId
    delete value.acceptedSnapshot
  }
  if (user.role === 'client' && resource === 'agreements') {
    delete value.acceptedSnapshot
    if (value.quotationSnapshot) {
      value.quotationSnapshot = { ...value.quotationSnapshot }
      for (const field of [
        'owner',
        'ownerId',
        'acceptedBy',
        'acceptedAt',
        'acceptance',
        'acceptedSnapshot',
        'rejectedBy',
        'rejectedAt',
        'rejection',
      ]) {
        delete value.quotationSnapshot[field]
      }
    }
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
      if (resource === 'invoices' && payload.billingSourceKey) {
        payload.billingSourceKey = `${payload.billingSourceKey}:invoice:${payload.id}`
      }
      if (resource === 'invoices') await validateInvoiceAllocation(payload, null, session)
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
  if (resource === 'invoices' && Object.keys(body).some((field) => [
    'status', 'amountPaid', 'balance', 'payments', 'paymentIds',
  ].includes(field))) {
    throw new AppError(
      409,
      'USE_INVOICE_WORKFLOW',
      'Invoice status and payment totals are managed through the issue, payment, and refund workflows.',
    )
  }
  const session = await mongoose.startSession()
  let record
  try {
    await session.withTransaction(async () => {
      const current = await findScoped(resource, id, req.user, session)
      let payload = await preparePayload(resource, body, req.user, current, session)
      if (resource === 'invoices') await validateInvoiceAllocation(payload, current, session)
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

export async function closeProject(id, body, req) {
  if (!hasPermission(req.user, 'projects.manage')) {
    throw new AppError(403, 'FORBIDDEN', 'You cannot close this project.')
  }
  const session = await mongoose.startSession()
  let project
  try {
    await session.withTransaction(async () => {
      const current = await Project.findOne({
        id,
        ...(await buildScope('projects', req.user)),
      }).session(session)
      if (!current || !recordCanAccess('projects', current, req.user)) {
        throw new AppError(404, 'RECORD_NOT_FOUND', 'Record was not found.')
      }
      if (current.status !== 'Completed') {
        throw new AppError(409, 'PROJECT_NOT_COMPLETE', 'Complete project delivery before recording handover and closing it.')
      }

      const tasks = await Task.find({ projectId: current.id }).session(session)
      if (tasks.some((task) => task.status !== 'Completed')) {
        throw new AppError(409, 'DELIVERY_TASKS_INCOMPLETE', 'Complete all project tasks before closing the project.')
      }

      const invoiceLinks = [{ projectId: current.id }]
      if (current.agreementId) invoiceLinks.push({ agreementId: current.agreementId })
      else if (current.quotationId) invoiceLinks.push({ quotationId: current.quotationId })
      const invoices = await Invoice.find({ $or: invoiceLinks }).session(session)
      const billableInvoices = invoices.filter((invoice) => invoice.status !== 'Cancelled')
      if (!billableInvoices.length) {
        throw new AppError(409, 'FINAL_INVOICE_REQUIRED', 'Record and settle the project’s final invoice before closing it.')
      }
      const unpaidInvoices = billableInvoices.filter((invoice) =>
        invoice.status !== 'Paid'
        || Number(invoice.balance ?? (Number(invoice.total || 0) - Number(invoice.amountPaid || 0))) > 0
        || Number(invoice.amountPaid || 0) < Number(invoice.total || 0))
      if (unpaidInvoices.length) {
        throw new AppError(409, 'INVOICES_UNSETTLED', 'Settle every project invoice before recording final handover.')
      }

      current.status = 'Closed'
      current.handover = {
        notes: body.handoverNotes.trim(),
        clientReceived: true,
        confirmedAt: new Date(),
        confirmedBy: req.user.id,
      }
      current.closedAt = current.handover.confirmedAt
      current.closedBy = req.user.id
      project = await current.save({ session })
      await recordAudit(req, 'projects.handover_closed', 'projects', project.id, {
        status: project.status,
        clientReceived: true,
        handoverNotes: project.handover.notes,
        invoiceIds: billableInvoices.map((invoice) => invoice.id),
      }, session)
    })
  } finally {
    await session.endSession()
  }
  return project.toJSON()
}

export async function deleteResource(resource, id, req) {
  if (resource === 'quotations') return deleteQuotation(id, req)
  if (resource === 'payments' || resource === 'invoices' || resource === 'agreements') {
    throw new AppError(409, 'IMMUTABLE_RESOURCE', 'This record cannot be deleted; use its cancellation or reversal workflow.')
  }
  const record = await findScoped(resource, id, req.user)
  await record.deleteOne()
  await recordAudit(req, `${resource}.deleted`, resource, id, {})
  return { id }
}

async function deleteQuotation(id, req) {
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      const quotation = await Quotation.findOne({
        id,
        ...(await buildScope('quotations', req.user)),
      }).session(session)
      if (!quotation || !recordCanAccess('quotations', quotation, req.user)) {
        throw new AppError(404, 'RECORD_NOT_FOUND', 'Record was not found.')
      }
      if (quotation.status !== 'Draft') {
        throw new AppError(409, 'QUOTATION_DELETE_RESTRICTED', 'Only draft quotations can be deleted.')
      }

      const [agreement, invoice, project, revision] = await Promise.all([
        Agreement.exists({ quotationId: id }).session(session),
        Invoice.exists({ quotationId: id }).session(session),
        Project.exists({ quotationId: id }).session(session),
        Quotation.exists({ revisionOf: id }).session(session),
      ])
      if (agreement || invoice || project || revision) {
        throw new AppError(
          409,
          'QUOTATION_LINKED',
          'This quotation is linked to another business record or revision and cannot be deleted.',
        )
      }

      await quotation.deleteOne({ session })
      await recordAudit(req, 'quotations.deleted', 'quotations', id, {}, session)
    })
  } finally {
    await session.endSession()
  }
  return { id }
}

async function createPayment(body, req) {
  const suppliedKey = req.get('Idempotency-Key')?.trim()
  const fingerprint = createHash('sha256').update(JSON.stringify([
    body.invoiceId, body.amount, body.date, body.method, body.reference || '', body.transactionReference || '',
  ])).digest('hex')
  const key = suppliedKey
    ? `${req.user.id}:${suppliedKey}`
    : `auto:${createHash('sha256').update(`${req.user.id}:${Math.floor(Date.now() / 300000)}:${fingerprint}`).digest('hex')}`
  if (key.length > 160) throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key is too long.')
  const replay = await findPaymentReplay(key, fingerprint, req.user)
  if (replay) return replay
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
    if (error.code === 11000) {
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
  const emailMatches = await Client.find({ email: lead.email.toLowerCase() }).session(session)
  if (emailMatches.length > 1) {
    throw new AppError(409, 'CLIENT_MATCH_AMBIGUOUS', 'More than one client uses this lead email. Resolve the duplicate client records before conversion.')
  }
  if (emailMatches.length === 1) {
    const client = emailMatches[0]
    if (!client.leadId) {
      client.leadId = lead.id
      await client.save({ session })
    }
    await recordAudit(req, 'leads.converted', 'leads', lead.id, { clientId: client.id, linkedExistingClient: true }, session)
    return { client: client.toJSON(), created: false }
  }
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
      const lead = await findScoped('leads', id, req.user, session)
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
    const previousStatus = quote.status
    quote.status = action === 'send' ? 'Sent' : action === 'approve' ? 'Accepted' : 'Rejected'
    const changes = { status: quote.status }
    if (action === 'send') {
      quote.sentAt = new Date()
      changes.sentAt = quote.sentAt
    }
    if (action === 'approve') {
      quote.acceptedAt = new Date()
      quote.acceptedBy = req.user.id
      quote.acceptance = {
        quotationId: quote.id,
        version: quote.version,
        acceptedBy: req.user.id,
        acceptedByRole: req.user.role,
        acceptedAt: quote.acceptedAt,
        method: isClientTransition ? 'client-portal' : 'staff-approval',
      }
      quote.acceptedSnapshot = quote.toObject()
      changes.acceptedAt = quote.acceptedAt
      changes.acceptedBy = quote.acceptedBy
      changes.acceptance = quote.acceptance
      changes.acceptedSnapshot = quote.acceptedSnapshot
    }
    if (action === 'reject') {
      quote.rejectedAt = new Date()
      quote.rejectedBy = req.user.id
      quote.rejection = {
        quotationId: quote.id,
        version: quote.version,
        rejectedBy: req.user.id,
        rejectedByRole: req.user.role,
        rejectedAt: quote.rejectedAt,
        method: isClientTransition ? 'client-portal' : 'staff-decision',
      }
      changes.rejectedAt = quote.rejectedAt
      changes.rejectedBy = quote.rejectedBy
      changes.rejection = quote.rejection
    }
    const session = await mongoose.startSession()
    try {
      await session.withTransaction(async () => {
        const transition = await Quotation.updateOne({
          ...(quote._id ? { _id: quote._id } : { id: quote.id }),
          status: action === 'send' ? 'Draft' : { $in: ['Sent', 'Viewed'] },
        }, { $set: changes }, { session })
        if (transition.matchedCount !== 1) {
          throw new AppError(409, 'INVALID_TRANSITION', 'This quotation has already been sent or decided. Refresh the page and try again.')
        }
        await recordAudit(req, `quotations.${action}`, 'quotations', quote.id, {
          status: quote.status,
          ...(action === 'approve' ? {
            version: quote.version,
            acceptedBy: quote.acceptedBy,
            acceptedByRole: quote.acceptance.acceptedByRole,
            method: quote.acceptance.method,
            acceptedAt: quote.acceptedAt,
          } : action === 'reject' ? {
            version: quote.version,
            rejectedBy: quote.rejectedBy,
            rejectedByRole: quote.rejection.rejectedByRole,
            method: quote.rejection.method,
            rejectedAt: quote.rejectedAt,
          } : { previousStatus }),
        }, session)

        if (action === 'send' && quote.clientId) {
          const account = await User.findOne({ clientId: quote.clientId, role: 'client', status: 'Active' }).session(session)
          if (account) await createNotification({
            recipientId: account.id, title: 'Quotation updated', body: `${quote.id} · ${quote.title}`,
            category: 'Sales', href: '/client-portal', eventType: `quotation.${action}`,
            dedupeKey: `quotation:${quote.id}:v${quote.version}:sent:${account.id}`,
          }, session)
        } else if (isClientTransition) {
          const recipients = new Map()
          if (quote.ownerId && mongoose.isValidObjectId(quote.ownerId)) {
            const owner = await User.findOne({
              _id: quote.ownerId,
              role: { $ne: 'client' },
              status: 'Active',
            }).select('id').session(session)
            if (owner) recipients.set(owner.id, owner)
          }
          const admins = await User.find({ role: 'super_admin', status: 'Active' }).select('id').session(session)
          for (const admin of admins) recipients.set(admin.id, admin)
          if (!recipients.size) {
            throw new AppError(503, 'NO_NOTIFICATION_RECIPIENT', 'The quotation decision could not be recorded because no internal recipient is available.')
          }
          const decision = action === 'approve' ? 'accepted' : 'rejected'
          for (const recipient of recipients.values()) {
            await createNotification({
              recipientId: recipient.id,
              title: `Quotation ${decision} by client`,
              body: `${quote.client || 'Client'} · ${quote.number || quote.id} · ${quote.title}`,
              category: 'Sales',
              href: '/quotations',
              eventType: `quotation.client_${decision}`,
              dedupeKey: `quotation:${quote.id}:v${quote.version}:client_${decision}:${recipient.id}`,
            }, session)
          }
        }
      })
    } finally {
      await session.endSession()
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
      acceptedBy: undefined,
      acceptedSnapshot: undefined,
      acceptance: undefined,
      rejectedAt: undefined,
      rejectedBy: undefined,
      rejection: undefined,
      invoiceAllocationVersion: 0,
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

export async function decideInvoice(id, body, req) {
  if (req.user.role !== 'client' || !req.user.clientId) {
    throw new AppError(403, 'CLIENT_PORTAL_ONLY', 'Only a linked client account can record an invoice decision.')
  }
  const invoice = await findScoped('invoices', id, req.user)
  if (!['Issued', 'Partially Paid', 'Overdue'].includes(invoice.status)) {
    throw new AppError(409, 'INVALID_TRANSITION', 'Only issued, overdue, or partially paid invoices can be accepted or rejected.')
  }
  if (invoice.clientDecision?.status) {
    throw new AppError(409, 'INVALID_TRANSITION', 'This invoice already has a client decision.')
  }
  if (body.decision === 'Rejected' && !body.reason?.trim()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'A reason is required when rejecting an invoice.')
  }

  const decision = {
    status: body.decision,
    decidedAt: new Date(),
    decidedBy: req.user.id,
    ...(body.decision === 'Rejected' ? { reason: body.reason.trim() } : {}),
  }
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      const result = await Invoice.updateOne({
        ...(invoice._id ? { _id: invoice._id } : { id: invoice.id }),
        clientId: req.user.clientId,
        status: { $in: ['Issued', 'Partially Paid', 'Overdue'] },
        'clientDecision.status': { $exists: false },
      }, { $set: { clientDecision: decision } }, { session })
      if (result.matchedCount !== 1) {
        throw new AppError(409, 'INVALID_TRANSITION', 'This invoice has already been decided or is no longer eligible. Refresh the page and try again.')
      }

      await recordAudit(req, `invoices.client_${body.decision.toLowerCase()}`, 'invoices', invoice.id, {
        decision: body.decision,
        ...(decision.reason ? { reason: decision.reason } : {}),
      }, session)

      const admins = await User.find({ role: 'super_admin', status: 'Active' }).select('id').session(session)
      if (!admins.length) {
        throw new AppError(503, 'NO_NOTIFICATION_RECIPIENT', 'The invoice decision could not be recorded because no internal recipient is available.')
      }
      for (const admin of admins) {
        await createNotification({
          recipientId: admin.id,
          title: `Invoice ${body.decision.toLowerCase()} by client`,
          body: `${invoice.client || 'Client'} · ${invoice.number || invoice.id}`,
          category: 'Finance',
          href: '/invoices',
          eventType: `invoice.client_${body.decision.toLowerCase()}`,
          dedupeKey: `invoice:${invoice.id}:client_${body.decision.toLowerCase()}:${admin.id}`,
        }, session)
      }
    })
  } finally {
    await session.endSession()
  }
  invoice.clientDecision = decision
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
