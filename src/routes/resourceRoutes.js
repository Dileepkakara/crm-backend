import { Router } from 'express'
import { z } from 'zod'
import * as controller from '../controllers/resourceController.js'
import { authenticate } from '../middleware/authenticate.js'
import { authorize } from '../middleware/authorize.js'
import { validate } from '../middleware/validate.js'
import { resourcePermissions } from '../services/resources.js'
import { invoiceDecisionSchema, resourceSchemas } from '../validation/resourceSchemas.js'

const idSchema = z.object({ id: z.string().trim().min(1).max(120) })
const agreementIdSchema = z.object({ agreementId: z.string().trim().min(1).max(120) })
const activitySchema = z.object({
  type: z.enum(['Call', 'Email', 'Meeting', 'Note', 'Status change', 'Other']),
  text: z.string().trim().min(1).max(5000),
})
const reviseSchema = z.object({ reason: z.string().trim().min(1).max(1000) })
const refundSchema = z.object({ reason: z.string().trim().min(1).max(1000) })
const agreementRejectSchema = z.object({ reason: z.string().trim().min(1).max(1000) })
const commentSchema = z.object({ text: z.string().trim().min(1).max(500) })
const projectCloseSchema = z.object({
  handoverNotes: z.string().trim().min(1).max(5000),
  clientReceived: z.literal(true),
})

export function resourceRouter(resource) {
  const router = Router()
  const permissions = resourcePermissions[resource]
  const schema = resourceSchemas[resource]
  router.use(authenticate)
  router.get('/', authorize(...permissions.read), controller.list(resource))
  router.post('/', authorize(...permissions.create), validate({ body: schema.create }), controller.create(resource))

  if (resource === 'leads') {
    router.post('/:id/convert', authorize('leads.update'), validate({ params: idSchema }), controller.convertLeadRoute)
    router.post('/:id/activities', authorize('leads.update', 'followups.create'), validate({ params: idSchema, body: activitySchema }), controller.addLeadActivityRoute)
  }
  if (resource === 'quotations') {
    router.post('/:id/:action', validate({
      params: z.object({ id: z.string().trim().min(1).max(120), action: z.enum(['send', 'approve', 'reject', 'revise']) }),
      body: z.union([reviseSchema, z.object({}).optional()]).optional(),
    }), controller.quotationActionRoute)
  }
  if (resource === 'agreements') {
    router.post('/:id/accept', authorize('agreements.view.own', 'agreements.approve'), validate({ params: idSchema }), controller.acceptAgreementRoute)
    router.post('/:id/reject', authorize('agreements.view.own', 'agreements.approve'), validate({ params: idSchema, body: agreementRejectSchema }), controller.rejectAgreementRoute)
    router.post('/:id/submit', authorize('agreements.approve'), validate({ params: idSchema }), controller.agreementSubmitRoute)
  }
  if (resource === 'invoices') {
    router.post('/:id/decision', validate({ params: idSchema, body: invoiceDecisionSchema }), controller.invoiceDecisionRoute)
    router.post('/:id/issue', authorize('invoices.manage'), validate({ params: idSchema }), controller.issueInvoiceRoute)
  }
  if (resource === 'payments') {
    router.post('/:id/refund', authorize('payments.manage'), validate({ params: idSchema, body: refundSchema }), controller.refundPaymentRoute)
  }
  if (resource === 'tasks') {
    router.post('/:id/comments', authorize('tasks.comment.internal'), validate({ params: idSchema, body: commentSchema }), controller.taskCommentRoute)
  }
  if (resource === 'notifications') {
    router.post('/read-all', authorize('notifications.view'), controller.markAllNotificationsRead)
  }
  if (resource === 'projects') {
    router.post('/from-agreement/:agreementId', authorize('projects.manage'), validate({ params: agreementIdSchema }), controller.createProjectFromAgreement)
    router.post('/:id/close', authorize('projects.manage'), validate({ params: idSchema, body: projectCloseSchema }), controller.closeProjectRoute)
  }

  router.get('/:id', authorize(...permissions.read), validate({ params: idSchema }), controller.get(resource))
  router.patch('/:id', authorize(...permissions.update), validate({ params: idSchema, body: schema.update }), controller.update(resource))
  router.put('/:id', authorize(...permissions.update), validate({ params: idSchema, body: schema.update }), controller.update(resource))
  router.delete('/:id', authorize(...permissions.delete), validate({ params: idSchema }), controller.remove(resource))
  return router
}
