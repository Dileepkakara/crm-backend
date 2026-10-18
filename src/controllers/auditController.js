import { asyncRoute } from '../middleware/asyncRoute.js'
import { AuditLog } from '../models/index.js'
import { paginationOptions } from '../middleware/pagination.js'
import { success } from '../utils/response.js'

export const listAuditLogs = asyncRoute(async (req, res) => {
  const { page, limit, skip, sort } = paginationOptions(req.query)
  const filter = {
    ...(req.query.entity ? { entity: String(req.query.entity).slice(0, 80) } : {}),
    ...(req.query.entityId ? { entityId: String(req.query.entityId).slice(0, 120) } : {}),
    ...(req.query.actorId ? { actorId: String(req.query.actorId).slice(0, 120) } : {}),
  }
  const [logs, total] = await Promise.all([
    AuditLog.find(filter).sort(sort).skip(skip).limit(limit),
    AuditLog.countDocuments(filter),
  ])
  success(res, logs, 200, undefined, { page, limit, total, pages: Math.ceil(total / limit) })
})
