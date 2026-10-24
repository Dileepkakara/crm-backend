import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import * as controller from '../controllers/clientSignupController.js'
import { authenticate } from '../middleware/authenticate.js'
import { authorize } from '../middleware/authorize.js'
import { validate } from '../middleware/validate.js'
import { clientSignupSchemas } from '../validation/resourceSchemas.js'

const router = Router()
const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, error: { code: 'SIGNUP_RATE_LIMIT', message: 'Too many signup requests. Try again later.' } },
})
const paramsSchema = z.object({ id: z.string().trim().min(1).max(120) })

router.post('/', signupLimiter, validate({ body: clientSignupSchemas.submit }), controller.submit)
router.use(authenticate)
router.get('/', authorize('clients.signup.manage'), validate({ query: clientSignupSchemas.list }), controller.list)
router.post('/:id/approve', authorize('clients.signup.manage'), validate({
  params: paramsSchema,
  body: clientSignupSchemas.approve,
}), controller.approve)
router.post('/:id/reject', authorize('clients.signup.manage'), validate({
  params: paramsSchema,
  body: clientSignupSchemas.reject,
}), controller.reject)

export default router
