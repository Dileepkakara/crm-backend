import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import test from 'node:test'
import { User } from '../src/models/index.js'
import { authenticate } from '../src/middleware/authenticate.js'

process.env.NODE_ENV = 'test'
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/design_blocks_test?replicaSet=rs0'
process.env.JWT_SECRET = 'test-only-jwt-secret-should-be-at-least-32-characters'

async function authenticateRequest(t, path, role = 'client') {
  t.mock.method(User, 'findById', () => ({
    select: async () => ({
      id: '507f1f77bcf86cd799439011',
      role,
      status: 'Active',
      tokenVersion: 0,
      mustChangePassword: true,
      $locals: {},
    }),
  }))
  const token = jwt.sign({ ver: 0 }, process.env.JWT_SECRET, {
    subject: '507f1f77bcf86cd799439011',
    expiresIn: '1m',
    issuer: 'design-blocks-crm-api',
    audience: 'design-blocks-crm',
  })
  let forwardedError
  const req = {
    baseUrl: '/api/v1/auth',
    path,
    get: () => `Bearer ${token}`,
  }
  await authenticate(req, {}, (error) => { forwardedError = error })
  return forwardedError
}

test('temporary-password accounts cannot access portal APIs before changing password', async (t) => {
  const error = await authenticateRequest(t, '/portal')
  assert.equal(error.statusCode, 403)
  assert.equal(error.code, 'PASSWORD_CHANGE_REQUIRED')
})

test('temporary-password accounts may restore their limited profile and submit a password change', async (t) => {
  assert.equal(await authenticateRequest(t, '/me'), undefined)
  assert.equal(await authenticateRequest(t, '/password'), undefined)
  assert.equal(await authenticateRequest(t, '/logout'), undefined)
})
