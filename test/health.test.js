import assert from 'node:assert/strict'
import test from 'node:test'
import request from 'supertest'
import { errorHandler } from '../src/middleware/errorHandler.js'

process.env.NODE_ENV = 'test'
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/design_blocks_test?replicaSet=rs0'
process.env.JWT_SECRET = 'test-only-jwt-secret-should-be-at-least-32-characters'
process.env.FRONTEND_URL = 'http://localhost:5173'

const { app } = await import('../src/app.js')

test('reports API health without requiring a live database in test mode', async () => {
  const response = await request(app).get('/health')
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { success: true, data: { status: 'ok' } })
})

test('allows the deployed Vercel frontend to call the API', async () => {
  const response = await request(app)
    .post('/api/v1/auth/refresh')
    .set('Origin', 'https://crm-frontend-rho-lilac.vercel.app')

  assert.equal(response.status, 401)
  assert.equal(response.headers['access-control-allow-origin'], 'https://crm-frontend-rho-lilac.vercel.app')
  assert.equal(response.headers['access-control-allow-credentials'], 'true')
})

test('protects user management and clears the refresh cookie on logout', async () => {
  const [users, logout] = await Promise.all([
    request(app).get('/api/v1/users'),
    request(app).post('/api/v1/auth/logout'),
  ])

  assert.equal(users.status, 401)
  assert.equal(users.body.error.code, 'UNAUTHENTICATED')
  assert.equal(logout.status, 200)
  assert.match(logout.headers['set-cookie'][0], /dbcrm_refresh=;/)
})

test('explains when MongoDB transactions require a replica set', () => {
  const error = Object.assign(new Error('Transaction numbers are only allowed on a replica set member or mongos'), {
    name: 'MongoServerError',
    code: 20,
  })
  let response
  const res = {
    status(statusCode) {
      response = { statusCode }
      return this
    },
    json(body) {
      response.body = body
      return this
    },
  }

  errorHandler(error, { id: 'test-request', method: 'POST', path: '/api/v1/clients' }, res, () => {})

  assert.equal(response.statusCode, 503)
  assert.equal(response.body.error.code, 'REPLICA_SET_REQUIRED')
  assert.match(response.body.error.message, /Configure MongoDB as a replica set/)
})
