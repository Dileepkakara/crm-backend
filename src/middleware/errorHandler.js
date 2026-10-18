import { ZodError } from 'zod'
import { AppError } from '../errors/AppError.js'
import { logger } from '../config/logger.js'

export function notFoundHandler(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} was not found.`))
}

export function errorHandler(error, req, res, _next) {
  let statusCode = error.statusCode || 500
  let code = error.code || 'INTERNAL_ERROR'
  let message = error.message || 'An unexpected error occurred.'
  let details

  if (error instanceof ZodError) {
    statusCode = 400
    code = 'VALIDATION_ERROR'
    message = 'Request validation failed.'
    details = error.issues.map(({ path, message: issueMessage }) => ({ path: path.join('.'), message: issueMessage }))
  } else if (error.name === 'CastError') {
    statusCode = 400
    code = 'INVALID_ID'
    message = 'The supplied record identifier is invalid.'
  } else if (error.code === 11000) {
    statusCode = 409
    code = 'DUPLICATE_RECORD'
    message = 'A record with one of these unique values already exists.'
  } else if (error.name === 'ValidationError') {
    statusCode = 400
    code = 'MODEL_VALIDATION_ERROR'
    message = 'The supplied data is invalid.'
    details = Object.values(error.errors || {}).map(({ path, message: issueMessage }) => ({ path, message: issueMessage }))
  } else if (error.code === 20 && error.name === 'MongoServerError') {
    statusCode = 503
    code = 'REPLICA_SET_REQUIRED'
    message = 'This operation requires MongoDB transactions. Configure MongoDB as a replica set and set replicaSet in MONGODB_URI.'
  } else if (error.status === 413) {
    statusCode = 413
    code = 'REQUEST_TOO_LARGE'
    message = 'The request body is too large.'
  } else if (error.status === 400 && error.type === 'entity.parse.failed') {
    statusCode = 400
    code = 'INVALID_JSON'
    message = 'The request body must contain valid JSON.'
  } else if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
    statusCode = 401
    code = 'UNAUTHENTICATED'
    message = 'Authentication is required.'
  }

  if (statusCode >= 500) {
    logger.error({ err: error, requestId: req.id, method: req.method, path: req.path }, 'Request failed')
    if (code !== 'REPLICA_SET_REQUIRED') {
      message = 'An unexpected server error occurred.'
      details = undefined
    }
  } else if (!(error instanceof AppError)) {
    logger.warn({ err: error, requestId: req.id, method: req.method, path: req.path }, 'Request rejected')
  }

  res.status(statusCode).json({
    success: false,
    error: { code, message, requestId: req.id, ...(details ? { details } : {}) },
  })
}
