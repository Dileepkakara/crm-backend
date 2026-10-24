import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import test from 'node:test'
import { AuditLog, Client, Counter, FollowUp, Lead } from '../src/models/index.js'
import { convertLead, updateResource } from '../src/services/resources.js'

function query(value) {
  return { session: async () => value }
}

function mockTransaction(t) {
  t.mock.method(mongoose, 'startSession', async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  }))
  t.mock.method(AuditLog, 'create', async () => [])
}

test('completing a follow-up persists completion time and reopening clears it', async (t) => {
  mockTransaction(t)
  const followup = {
    id: 'FU-TEST-1',
    status: 'Upcoming',
    completedAt: undefined,
    set(values) { Object.assign(this, values) },
    async save() { return this },
    toJSON() { return { id: this.id, status: this.status, completedAt: this.completedAt } },
  }
  t.mock.method(FollowUp, 'findOne', () => query(followup))
  const request = { user: { id: 'staff-1', name: 'Staff', role: 'super_admin' } }

  const completed = await updateResource('followups', followup.id, { status: 'Completed' }, request)
  assert.equal(completed.status, 'Completed')
  assert.ok(completed.completedAt instanceof Date)

  const reopened = await updateResource('followups', followup.id, { status: 'Upcoming' }, request)
  assert.equal(reopened.status, 'Upcoming')
  assert.equal(reopened.completedAt, undefined)
})

test('lead conversion links a unique existing client with the same email without duplicating it', async (t) => {
  mockTransaction(t)
  const lead = {
    id: 'LD-TEST-1',
    email: 'existing@example.test',
    name: 'Existing Contact',
    company: 'Existing Company',
    phone: '+91 90000 00000',
    status: 'Qualified',
    async save() { return this },
  }
  const client = {
    id: 'CL-EXISTING-1',
    email: 'existing@example.test',
    leadId: undefined,
    async save() { return this },
    toJSON() { return { id: this.id, email: this.email, leadId: this.leadId } },
  }
  t.mock.method(Lead, 'findOne', () => query(lead))
  t.mock.method(Client, 'findOne', () => query(null))
  t.mock.method(Client, 'find', (filter) => {
    assert.deepEqual(filter, { email: 'existing@example.test' })
    return query([client])
  })
  const clientCreate = t.mock.method(Client, 'create', async () => {
    throw new Error('Conversion should reuse the existing client.')
  })
  const counterUpdate = t.mock.method(Counter, 'findOneAndUpdate', async () => {
    throw new Error('Conversion should not allocate a duplicate client ID.')
  })

  const result = await convertLead('LD-TEST-1', {
    id: 'request-convert-test',
    user: { id: 'staff-1', name: 'Staff', role: 'super_admin' },
  })

  assert.equal(result.created, false)
  assert.equal(result.client.id, client.id)
  assert.equal(client.leadId, lead.id)
  assert.equal(lead.status, 'Won')
  assert.equal(lead.convertedClientId, client.id)
  assert.equal(clientCreate.mock.callCount(), 0)
  assert.equal(counterUpdate.mock.callCount(), 0)
})

test('lead conversion fails explicitly if its email matches multiple clients', async (t) => {
  mockTransaction(t)
  const lead = { id: 'LD-TEST-2', email: 'duplicate@example.test', status: 'Qualified' }
  t.mock.method(Lead, 'findOne', () => query(lead))
  t.mock.method(Client, 'findOne', () => query(null))
  t.mock.method(Client, 'find', () => query([{ id: 'CL-1' }, { id: 'CL-2' }]))

  await assert.rejects(
    convertLead(lead.id, {
      user: { id: 'staff-1', name: 'Staff', role: 'super_admin' },
    }),
    { code: 'CLIENT_MATCH_AMBIGUOUS' },
  )
  assert.equal(lead.status, 'Qualified')
})
