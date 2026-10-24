import { asyncRoute } from '../middleware/asyncRoute.js'
import { success } from '../utils/response.js'
import {
  approveClientSignupRequest,
  listClientSignupRequests,
  rejectClientSignupRequest,
  submitClientSignup,
} from '../services/clientSignupRequests.js'

export const submit = asyncRoute(async (req, res) => {
  const request = await submitClientSignup(req.body, req)
  success(res, request, 201, 'Your request was submitted and is awaiting approval.')
})

export const list = asyncRoute(async (req, res) => {
  success(res, await listClientSignupRequests(req.query.status || 'Pending'))
})

export const approve = asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store')
  const result = await approveClientSignupRequest(req.params.id, req.body || {}, req)
  success(res, result, 200, 'Client access approved. Share the temporary password with the client through a safe channel.')
})

export const reject = asyncRoute(async (req, res) => {
  success(res, await rejectClientSignupRequest(req.params.id, req.body?.reason, req))
})
