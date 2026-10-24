import { Router } from 'express'
import * as controller from '../controllers/userController.js'
import { authorize } from '../middleware/authorize.js'
import { authenticate } from '../middleware/authenticate.js'
import { validate } from '../middleware/validate.js'
import { userSchemas } from '../validation/resourceSchemas.js'

const router = Router()

router.use(authenticate)
router.get('/assignees', authorize('leads.assign', 'followups.create', 'projects.manage', 'tasks.create'), controller.listAssignees)
router.get('/', authorize('users.view', 'users.manage'), controller.listUsers)
router.post('/', authorize('users.manage'), validate({ body: userSchemas.create }), controller.createUser)
router.get('/:id', authorize('users.view', 'users.manage'), controller.getUser)
router.patch('/:id', authorize('users.manage'), validate({ body: userSchemas.update }), controller.updateUser)
router.delete('/:id', authorize('users.manage'), controller.deleteUser)
router.put('/:id/password', authorize('users.manage'), validate({ body: userSchemas.setPassword }), controller.setPassword)

export default router
