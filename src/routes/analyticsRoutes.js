import { Router } from 'express'
import { authenticate } from '../middleware/authenticate.js'
import { authorize } from '../middleware/authorize.js'
import { dashboard, portal, reports } from '../controllers/analyticsController.js'

const router = Router()

router.use(authenticate)
router.get('/portal', authorize('clientPortal.view.own'), portal)
router.get('/dashboard', authorize('dashboard.view'), dashboard)
router.get('/reports', authorize('reports.view', 'reports.view.sales', 'reports.view.financial'), reports)

export default router
