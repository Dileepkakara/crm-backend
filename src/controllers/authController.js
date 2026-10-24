import { asyncRoute } from '../middleware/asyncRoute.js'
import { AppError } from '../errors/AppError.js'
import { User } from '../models/index.js'
import * as authService from '../services/auth.js'
import { serializeUser } from '../services/roles.js'
import { success } from '../utils/response.js'

export const login = asyncRoute(async (req, res) => {
  const session = await authService.login(req.body, res)
  success(res, session)
})

export const clientLogin = asyncRoute(async (req, res) => {
  const session = await authService.login(req.body, res, 'client')
  success(res, session)
})

export const refresh = asyncRoute(async (req, res) => {
  const session = await authService.refresh(req, res)
  success(res, session)
})

export const logout = asyncRoute(async (req, res) => {
  await authService.logout(req, res)
  success(res, null, 200, 'Signed out.')
})

export const me = asyncRoute(async (req, res) => {
  const user = await User.findById(req.user.id)
  if (!user || user.status !== 'Active') throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.')
  success(res, await serializeUser(user))
})

export const changePassword = asyncRoute(async (req, res) => {
  await authService.changePassword(req.user.id, req.body)
  authService.clearRefreshCookie(res)
  success(res, null, 200, 'Password updated. Sign in again.')
})
