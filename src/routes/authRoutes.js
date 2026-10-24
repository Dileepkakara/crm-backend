import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import * as controller from '../controllers/authController.js'
import { authenticate } from '../middleware/authenticate.js'
import { validate } from '../middleware/validate.js'
import { authSchemas } from '../validation/resourceSchemas.js'

const router = Router()
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, error: { code: 'LOGIN_RATE_LIMIT', message: 'Too many login attempts. Try again later.' } },
})

router.post('/login', loginLimiter, validate({ body: authSchemas.login }), controller.login)
router.post('/client-login', loginLimiter, validate({ body: authSchemas.login }), controller.clientLogin)
router.post('/logout', controller.logout)
router.post('/refresh', controller.refresh)
router.get('/me', authenticate, controller.me)
router.patch('/password', authenticate, validate({ body: authSchemas.changePassword }), controller.changePassword)

export default router
