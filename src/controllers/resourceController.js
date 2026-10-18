import { AppError } from '../errors/AppError.js'
import { asyncRoute } from '../middleware/asyncRoute.js'
import { success } from '../utils/response.js'
import {
  acceptAgreement,
  addTaskComment,
  convertLead,
  createResource,
  deleteResource,
  getResource,
  listResources,
  recordLeadActivity,
  refundPayment,
  transitionQuotation,
  submitAgreement,
  issueInvoice,
  rejectAgreement,
  updateResource,
} from '../services/resources.js'
import { Agreement, Project, Notification } from '../models/index.js'
import { hasPermission } from '../middleware/authorize.js'
import { recordAudit } from '../services/audit.js'

export function list(resource) {
  return asyncRoute(async (req, res) => {
    const { records, meta } = await listResources(resource, req)
    success(res, records, 200, undefined, meta)
  })
}

export function get(resource) {
  return asyncRoute(async (req, res) => {
    success(res, await getResource(resource, req.params.id, req.user))
  })
}

export function create(resource) {
  return asyncRoute(async (req, res) => {
    const result = await createResource(resource, req.body, req)
    if (result.record) {
      success(res, result.record, 201, undefined, {
        ...(result.warnings || {}),
        ...(result.replayed ? { idempotentReplay: true } : {}),
      })
    } else success(res, result, 201)
  })
}

export function update(resource) {
  return asyncRoute(async (req, res) => {
    const result = await updateResource(resource, req.params.id, req.body, req)
    success(res, result)
  })
}

export function remove(resource) {
  return asyncRoute(async (req, res) => {
    success(res, await deleteResource(resource, req.params.id, req))
  })
}

export const convertLeadRoute = asyncRoute(async (req, res) => {
  const result = await convertLead(req.params.id, req)
  success(res, result, result.created ? 201 : 200)
})

export const addLeadActivityRoute = asyncRoute(async (req, res) => {
  success(res, await recordLeadActivity(req.params.id, req.body, req), 201)
})

export const quotationActionRoute = asyncRoute(async (req, res) => {
  const action = req.params.action
  const record = await transitionQuotation(req.params.id, action, req.body || {}, req)
  success(res, record, action === 'revise' ? 201 : 200)
})

export const acceptAgreementRoute = asyncRoute(async (req, res) => {
  success(res, await acceptAgreement(req.params.id, req), 200, 'Acceptance recorded. This is not a verified electronic signature.')
})

export const agreementSubmitRoute = asyncRoute(async (req, res) => {
  success(res, await submitAgreement(req.params.id, req))
})

export const rejectAgreementRoute = asyncRoute(async (req, res) => {
  success(res, await rejectAgreement(req.params.id, req.body.reason, req))
})

export const issueInvoiceRoute = asyncRoute(async (req, res) => {
  success(res, await issueInvoice(req.params.id, req))
})

export const refundPaymentRoute = asyncRoute(async (req, res) => {
  success(res, await refundPayment(req.params.id, req.body, req))
})

export const taskCommentRoute = asyncRoute(async (req, res) => {
  success(res, await addTaskComment(req.params.id, req.body, req), 201)
})

export const markAllNotificationsRead = asyncRoute(async (req, res) => {
  const result = await Notification.updateMany({ recipientId: req.user.id, read: false }, { $set: { read: true } })
  success(res, { modifiedCount: result.modifiedCount })
})

export const createProjectFromAgreement = asyncRoute(async (req, res) => {
  if (!hasPermission(req.user, 'agreements.view') && !hasPermission(req.user, 'agreements.approve')) {
    throw new AppError(403, 'FORBIDDEN', 'You cannot create a project from this work order.')
  }
  const agreement = await Agreement.findOne({ id: req.params.agreementId })
  if (!agreement || agreement.status !== 'Accepted') throw new AppError(400, 'AGREEMENT_NOT_ACCEPTED', 'Only accepted work orders can create a project.')
  const existing = await Project.findOne({ agreementId: agreement.id })
  if (existing) {
    if (agreement.projectId !== existing.id) {
      agreement.projectId = existing.id
      await agreement.save()
      await recordAudit(req, 'agreements.project_linked', 'agreements', agreement.id, { projectId: existing.id })
    }
    return success(res, existing.toJSON(), 200, 'Project already exists for this work order.')
  }
  const project = await createResource('projects', {
    name: agreement.project,
    clientId: agreement.clientId,
    quotationId: agreement.quotationId,
    agreementId: agreement.id,
    startDate: agreement.startDate,
    deadline: agreement.deadline,
    scope: agreement.scope,
    status: 'Planning',
  }, req)
  agreement.projectId = project.record.id
  await agreement.save()
  await recordAudit(req, 'agreements.project_linked', 'agreements', agreement.id, { projectId: project.record.id })
  success(res, project.record, 201)
})
