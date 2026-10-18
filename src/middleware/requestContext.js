import { randomUUID } from 'node:crypto'

export function requestContext(req, res, next) {
  req.id = req.headers['x-request-id']?.toString().slice(0, 100) || randomUUID()
  res.setHeader('x-request-id', req.id)
  next()
}
