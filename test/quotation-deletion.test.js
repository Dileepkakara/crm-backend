import assert from 'node:assert/strict'
import test from 'node:test'
import mongoose from 'mongoose'
import { Agreement, AuditLog, Invoice, Project, Quotation } from '../src/models/index.js'
import { resourcePermissions, deleteResource } from '../src/services/resources.js'

function query(value) {
  return { session: async () => value }
}

function mockSession(t) {
  t.mock.method(mongoose, 'startSession', async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  }))
}

test('allows deleting a draft quotation and records the deletion', async (t) => {
  mockSession(t)
  const record = { id: 'QT-100', status: 'Draft', deleteOne: t.mock.fn(async () => {}) }
  const audit = t.mock.method(AuditLog, 'create', async () => {})
  t.mock.method(Quotation, 'findOne', () => query(record))
  t.mock.method(Agreement, 'exists', () => query(null))
  t.mock.method(Invoice, 'exists', () => query(null))
  t.mock.method(Project, 'exists', () => query(null))
  t.mock.method(Quotation, 'exists', () => query(null))

  const result = await deleteResource('quotations', record.id, {
    id: 'request-1',
    user: { id: 'user-1', role: 'super_admin' },
  })

  assert.deepEqual(result, { id: record.id })
  assert.equal(record.deleteOne.mock.callCount(), 1)
  assert.equal(audit.mock.callCount(), 1)
  assert.deepEqual(resourcePermissions.quotations.delete, ['quotations.create'])
})

test('refuses to delete a quotation after it leaves draft status', async (t) => {
  mockSession(t)
  const record = { id: 'QT-101', status: 'Sent', deleteOne: t.mock.fn(async () => {}) }
  t.mock.method(Quotation, 'findOne', () => query(record))
  const audit = t.mock.method(AuditLog, 'create', async () => {})

  await assert.rejects(
    deleteResource('quotations', record.id, {
      id: 'request-2',
      user: { id: 'user-1', role: 'super_admin' },
    }),
    (error) => error.code === 'QUOTATION_DELETE_RESTRICTED',
  )

  assert.equal(record.deleteOne.mock.callCount(), 0)
  assert.equal(audit.mock.callCount(), 0)
})

test('protects a draft quotation referenced by a financial or revision record', async (t) => {
  mockSession(t)
  const record = { id: 'QT-102', status: 'Draft', deleteOne: t.mock.fn(async () => {}) }
  t.mock.method(Quotation, 'findOne', () => query(record))
  t.mock.method(Agreement, 'exists', () => query(null))
  t.mock.method(Invoice, 'exists', () => query({ _id: 'invoice-1' }))
  t.mock.method(Project, 'exists', () => query(null))
  t.mock.method(Quotation, 'exists', () => query(null))
  const audit = t.mock.method(AuditLog, 'create', async () => {})

  await assert.rejects(
    deleteResource('quotations', record.id, {
      id: 'request-3',
      user: { id: 'user-1', role: 'super_admin' },
    }),
    (error) => error.code === 'QUOTATION_LINKED',
  )

  assert.equal(record.deleteOne.mock.callCount(), 0)
  assert.equal(audit.mock.callCount(), 0)
})
