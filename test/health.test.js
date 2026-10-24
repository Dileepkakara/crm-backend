import assert from 'node:assert/strict'
import test from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
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

test('disables validators and caching for API responses', async () => {
  assert.equal(app.get('etag'), false)
  const response = await request(app)
    .get('/api/v1/portal')
    .set('If-None-Match', '*')

  assert.equal(response.status, 401)
  assert.equal(response.headers.etag, undefined)
  assert.equal(response.headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate')
  assert.equal(response.headers.pragma, 'no-cache')
})

test('allows the deployed Vercel frontend domains to call the API', async () => {
  const origins = [
    'https://crm-frontend-rho-lilac.vercel.app',
    'https://crm-frontend-git-main-dileeps-projects-efeb0f16.vercel.app',
    'https://crm-frontend-audztfl0o-dileeps-projects-efeb0f16.vercel.app',
  ]

  for (const origin of origins) {
    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Origin', origin)

    assert.equal(response.status, 401)
    assert.equal(response.headers['access-control-allow-origin'], origin)
    assert.equal(response.headers['access-control-allow-credentials'], 'true')
  }
})

test('allows local Vite ports to call the API outside production', async () => {
  const response = await request(app)
    .options('/api/v1/auth/login')
    .set('Origin', 'http://localhost:5174')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type')

  assert.equal(response.status, 204)
  assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:5174')
  assert.equal(response.headers['access-control-allow-credentials'], 'true')
})

test('does not allow arbitrary localhost ports in production CORS', async () => {
  const originalNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  let productionApp
  try {
    productionApp = createApp()
  } finally {
    process.env.NODE_ENV = originalNodeEnv
  }

  const response = await request(productionApp)
    .options('/api/v1/auth/login')
    .set('Origin', 'http://localhost:5174')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type')

  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'CORS_ORIGIN_DENIED')
})

test('rejects unconfigured frontend origins', async () => {
  const response = await request(app)
    .post('/api/v1/auth/refresh')
    .set('Origin', 'https://untrusted.example')

  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'CORS_ORIGIN_DENIED')
})

test('protects user management and clears the refresh cookie on logout', async () => {
  const users = await request(app).get('/api/v1/users')

  assert.equal(users.status, 401)
  assert.equal(users.body.error.code, 'UNAUTHENTICATED')

  const originalNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  let logout
  try {
    logout = await request(app).post('/api/v1/auth/logout')
  } finally {
    process.env.NODE_ENV = originalNodeEnv
  }

  assert.equal(logout.status, 200)
  assert.match(logout.headers['set-cookie'][0], /dbcrm_refresh=;/)
  assert.match(logout.headers['set-cookie'][0], /SameSite=None/i)
  assert.match(logout.headers['set-cookie'][0], /Secure/i)
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
