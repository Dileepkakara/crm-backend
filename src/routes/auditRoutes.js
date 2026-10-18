import { Router } from 'express'
import { listAuditLogs } from '../controllers/auditController.js'
import { authenticate } from '../middleware/authenticate.js'
import { authorize } from '../middleware/authorize.js'

const router = Router()
router.use(authenticate, authorize('users.manage'))
router.get('/', listAuditLogs)
export default router
