import assert from 'node:assert/strict'
import test from 'node:test'
import { AuditLog, Quotation } from '../src/models/index.js'
import { resourcePermissions, deleteResource } from '../src/services/resources.js'

test('allows deleting a draft quotation and records the deletion', async (t) => {
  const record = { id: 'QT-100', status: 'Draft', deleteOne: t.mock.fn(async () => {}) }
  const audit = t.mock.method(AuditLog, 'create', async () => {})
  t.mock.method(Quotation, 'findOne', async () => record)

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
  const record = { id: 'QT-101', status: 'Sent', deleteOne: t.mock.fn(async () => {}) }
  t.mock.method(Quotation, 'findOne', async () => record)
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
