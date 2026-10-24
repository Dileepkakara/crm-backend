import assert from 'node:assert/strict'
import bcrypt from 'bcrypt'
import test from 'node:test'
import { Client, User } from '../src/models/index.js'
import { login } from '../src/services/auth.js'

test('client-only login rejects a valid staff account', async (t) => {
  const passwordHash = await bcrypt.hash('correct horse battery staple', 4)
  t.mock.method(User, 'findOne', () => ({
    select: async () => ({
      id: 'staff-1',
      role: 'sales_manager',
      status: 'Active',
      passwordHash,
    }),
  }))
  const clientLookup = t.mock.method(Client, 'findOne', async () => null)

  await assert.rejects(
    login({ email: 'staff@example.com', password: 'correct horse battery staple' }, {}, 'client'),
    { code: 'INVALID_CREDENTIALS' },
  )
  assert.equal(clientLookup.mock.calls.length, 0)
})

test('client-only login rejects an account without an active linked client record', async (t) => {
  const passwordHash = await bcrypt.hash('correct horse battery staple', 4)
  t.mock.method(User, 'findOne', () => ({
    select: async () => ({
      id: 'client-user-1',
      role: 'client',
      status: 'Active',
      clientId: 'CL-1',
      passwordHash,
    }),
  }))
  const clientLookup = t.mock.method(Client, 'findOne', async () => null)

  await assert.rejects(
    login({ email: 'client@example.com', password: 'correct horse battery staple' }, {}, 'client'),
    { code: 'INVALID_CREDENTIALS' },
  )
  assert.deepEqual(clientLookup.mock.calls[0].arguments[0], { id: 'CL-1', status: 'Active' })
})
