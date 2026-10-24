import assert from 'node:assert/strict'
import test from 'node:test'
import { Quotation } from '../src/models/index.js'
import { getResource, listResources, safeResource } from '../src/services/resources.js'

test('client quotation listing is restricted to the linked client and excludes drafts', async (t) => {
  const capturedFilters = []
  t.mock.method(Quotation, 'find', (filter) => {
    capturedFilters.push(filter)
    return {
      sort() { return this },
      skip() { return this },
      limit: async () => [],
    }
  })
  t.mock.method(Quotation, 'countDocuments', async (filter) => {
    capturedFilters.push(filter)
    return 0
  })
  const req = {
    query: { status: 'Draft' },
    user: { id: 'client-user-1', role: 'client', clientId: 'CL-1' },
  }

  await listResources('quotations', req)

  assert.equal(capturedFilters.length, 2)
  for (const filter of capturedFilters) {
    assert.equal(filter.clientId, 'CL-1')
    assert.equal(filter.status, '__client_cannot_view_draft__')
  }
})

test('client quotation details redact internal owner and accepted snapshot data', async (t) => {
  let requestedFilter
  const quote = {
    id: 'QT-1',
    clientId: 'CL-1',
    status: 'Accepted',
    owner: 'Internal staff',
    ownerId: 'staff-user-1',
    acceptedSnapshot: { ownerId: 'staff-user-1', status: 'Accepted' },
    toJSON() {
      return {
        id: this.id,
        clientId: this.clientId,
        status: this.status,
        owner: this.owner,
        ownerId: this.ownerId,
        acceptedSnapshot: this.acceptedSnapshot,
      }
    },
  }
  t.mock.method(Quotation, 'findOne', async (filter) => {
    requestedFilter = filter
    return filter.clientId === quote.clientId ? quote : null
  })

  const result = await getResource('quotations', 'QT-1', {
    id: 'client-user-1',
    role: 'client',
    clientId: 'CL-1',
  })

  assert.equal(requestedFilter.clientId, 'CL-1')
  assert.equal(requestedFilter.status.$ne, 'Draft')
  assert.equal(result.id, 'QT-1')
  assert.equal(result.owner, undefined)
  assert.equal(result.ownerId, undefined)
  assert.equal(result.acceptedSnapshot, undefined)
})

test('client cannot retrieve a quotation belonging to another client', async (t) => {
  let requestedFilter
  t.mock.method(Quotation, 'findOne', async (filter) => {
    requestedFilter = filter
    return null
  })

  await assert.rejects(
    getResource('quotations', 'QT-OTHER', { id: 'client-user-2', role: 'client', clientId: 'CL-2' }),
    { code: 'RECORD_NOT_FOUND' },
  )
  assert.equal(requestedFilter.clientId, 'CL-2')
})

test('client work-order serialization removes saved internal quotation metadata', () => {
  const agreement = {
    toJSON() {
      return {
        id: 'WO-1',
        acceptedSnapshot: { internalNote: 'Internal snapshot data' },
        quotationSnapshot: {
          id: 'QT-1',
          title: 'Client project',
          owner: 'Internal staff',
          ownerId: 'staff-user-1',
          acceptedBy: 'client-user-1',
          acceptance: { acceptedBy: 'client-user-1' },
          acceptedSnapshot: { ownerId: 'staff-user-1' },
        },
      }
    },
  }

  const result = safeResource('agreements', agreement, {
    id: 'client-user-1',
    role: 'client',
    clientId: 'CL-1',
  })

  assert.equal(result.acceptedSnapshot, undefined)
  assert.equal(result.quotationSnapshot.title, 'Client project')
  assert.equal(result.quotationSnapshot.owner, undefined)
  assert.equal(result.quotationSnapshot.ownerId, undefined)
  assert.equal(result.quotationSnapshot.acceptedBy, undefined)
  assert.equal(result.quotationSnapshot.acceptance, undefined)
  assert.equal(result.quotationSnapshot.acceptedSnapshot, undefined)
})
