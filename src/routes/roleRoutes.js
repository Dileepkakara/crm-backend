import { Router } from 'express'
import * as controller from '../controllers/roleController.js'
import { authenticate } from '../middleware/authenticate.js'
import { authorize } from '../middleware/authorize.js'
import { validate } from '../middleware/validate.js'
import { roleSchemas } from '../validation/roleSchemas.js'

const router = Router()

router.use(authenticate, authorize('roles.manage'))
router.get('/', controller.listRoles)
router.post('/', validate({ body: roleSchemas.create }), controller.createRole)
router.patch('/:id', validate({ body: roleSchemas.update }), controller.updateRole)
router.put('/:id', validate({ body: roleSchemas.update }), controller.updateRole)

export default router
