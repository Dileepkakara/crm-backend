import { AuditLog } from '../models/index.js'

export async function recordAudit(req, action, entity, entityId, changes, session) {
  await AuditLog.create([{
    actorId: req.user?.id,
    actorRole: req.user?.role,
    action,
    entity,
    entityId: String(entityId || ''),
    changes,
    requestId: req.id,
  }], { session })
}
