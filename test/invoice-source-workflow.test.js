import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import test from 'node:test'
import {
  Agreement,
  AuditLog,
  Client,
  Counter,
  Invoice,
  Notification,
  Payment,
  Quotation,
  User,
} from '../src/models/index.js'
import { createResource, decideInvoice, transitionQuotation, updateResource } from '../src/services/resources.js'
import { invoiceDecisionSchema, resourceSchemas } from '../src/validation/resourceSchemas.js'

function query(value) {
  return { session: async () => value }
}

function mockTransaction(t) {
  t.mock.method(mongoose, 'startSession', async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  }))
}

function mockDecisionNotifications(t) {
  t.mock.method(User, 'find', () => ({
    select() { return this },
    session: async () => [{ id: 'admin-1' }],
  }))
  t.mock.method(Notification, 'findOneAndUpdate', async (_filter, update) => update.$setOnInsert)
}

function mockSourceRecords(t, { agreement, quotation, existingInvoices = [] }) {
  mockTransaction(t)
  const client = { id: 'CL-1', company: 'Example Client', name: 'Client Contact' }
  t.mock.method(Client, 'findOne', () => query(client))
  t.mock.method(Agreement, 'findOne', () => query(agreement || null))
  t.mock.method(Quotation, 'findOne', () => query(quotation || null))
  t.mock.method(Quotation, 'updateOne', () => query({ matchedCount: 1 }))
  t.mock.method(Agreement, 'updateOne', () => query({ matchedCount: 1 }))
  t.mock.method(Invoice, 'find', () => query(existingInvoices))
  t.mock.method(Counter, 'findOneAndUpdate', async () => ({ value: 3 }))
  const invoiceSave = t.mock.method(Invoice.prototype, 'save', async function save() { return this })
  t.mock.method(AuditLog, 'create', async () => [])
  return { client, invoiceSave }
}

const acceptedQuotation = {
  id: 'QT-100',
  clientId: 'CL-1',
  client: 'Example Client',
  title: 'Website redesign',
  status: 'Accepted',
  acceptedSnapshot: {
    id: 'QT-100',
    clientId: 'CL-1',
    client: 'Example Client',
    title: 'Website redesign',
    status: 'Accepted',
    items: [{ description: 'Design and delivery', quantity: 1, rate: 50000 }],
    subtotal: 50000,
    total: 50000,
    amount: 50000,
    discount: 0,
    gstEnabled: false,
    sgstEnabled: true,
    cgstEnabled: true,
    sgstRate: 0,
    cgstRate: 0,
    terms: 'Payment due within 30 days.',
  },
  toJSON() { return this },
}

const invoiceRequest = {
  clientId: 'CL-1',
  quotationId: 'QT-100',
  issueDate: '2026-06-11',
  dueDate: '2026-07-11',
  items: [{ description: 'Advance payment', quantity: 1, rate: 20000 }],
  discount: 0,
  gstEnabled: false,
  sgstEnabled: true,
  cgstEnabled: true,
  sgstRate: 0,
  cgstRate: 0,
}

test('creates a separate Draft advance invoice from an accepted quotation', async (t) => {
  mockSourceRecords(t, { quotation: acceptedQuotation })
  const result = await createResource('invoices', invoiceRequest, {
    id: 'request-1',
    user: { id: 'admin-1', name: 'Admin', role: 'super_admin' },
  })

  assert.equal(result.record.status, 'Draft')
  assert.equal(result.record.clientId, 'CL-1')
  assert.equal(result.record.quotationId, 'QT-100')
  assert.match(result.record.billingSourceKey, /^contract:quotation:QT-100:invoice:/)
  assert.deepEqual(result.record.items, [{ description: 'Advance payment', quantity: 1, rate: 20000, amount: 20000 }])
  assert.equal(result.record.total, 20000)
  assert.equal(result.record.terms, 'Payment due within 30 days.')
  assert.equal(result.record.sourceSnapshot.quotation.id, 'QT-100')
  assert.equal(result.record.sourceSnapshot.quotation.ownerId, undefined)
})

test('allows multiple invoices when their combined amount stays within the accepted quotation', async (t) => {
  mockSourceRecords(t, {
    quotation: acceptedQuotation,
    existingInvoices: [{ id: 'INV-ADVANCE', quotationId: 'QT-100', total: 20000, status: 'Issued' }],
  })
  const result = await createResource('invoices', invoiceRequest, {
    id: 'request-2',
    user: { id: 'admin-1', name: 'Admin', role: 'super_admin' },
  })

  assert.equal(result.record.total, 20000)
  assert.equal(result.record.quotationId, 'QT-100')
})

test('rejects an invoice that exceeds the remaining accepted quotation amount', async (t) => {
  const { invoiceSave } = mockSourceRecords(t, {
    quotation: acceptedQuotation,
    existingInvoices: [{ id: 'INV-PREVIOUS', quotationId: 'QT-100', total: 35000, status: 'Paid' }],
  })

  await assert.rejects(
    createResource('invoices', invoiceRequest, {
      id: 'request-3',
      user: { id: 'admin-1', name: 'Admin', role: 'super_admin' },
    }),
    (error) => error.code === 'INVOICE_EXCEEDS_CONTRACT',
  )
  assert.equal(invoiceSave.mock.callCount(), 0)
})

test('rejects invoices sourced from quotations that are not accepted', async (t) => {
  const quotation = { ...acceptedQuotation, status: 'Draft' }
  const { invoiceSave } = mockSourceRecords(t, { quotation })

  await assert.rejects(
    createResource('invoices', invoiceRequest, {
      id: 'request-4',
      user: { id: 'admin-1', name: 'Admin', role: 'super_admin' },
    }),
    (error) => error.code === 'QUOTATION_NOT_ACCEPTED',
  )
  assert.equal(invoiceSave.mock.callCount(), 0)
})

test('prevents agreement invoices from exceeding the accepted quotation allocation', async (t) => {
  const agreement = {
    id: 'WO-100',
    clientId: 'CL-1',
    client: 'Example Client',
    quotationId: 'QT-100',
    status: 'Accepted',
    toObject() { return this },
  }
  const { invoiceSave } = mockSourceRecords(t, {
    agreement,
    quotation: acceptedQuotation,
    existingInvoices: [{ id: 'INV-EXISTING', quotationId: 'QT-100', total: 35000, status: 'Issued' }],
  })

  await assert.rejects(
    createResource('invoices', { ...invoiceRequest, agreementId: agreement.id }, {
      id: 'request-5',
      user: { id: 'admin-1', name: 'Admin', role: 'super_admin' },
    }),
    (error) => error.code === 'INVOICE_EXCEEDS_CONTRACT',
  )
  assert.equal(invoiceSave.mock.callCount(), 0)
})

test('rejects invoices sourced from agreements that are not accepted', async (t) => {
  const agreement = {
    id: 'WO-101',
    clientId: 'CL-1',
    quotationId: 'QT-100',
    status: 'Pending approval',
  }
  const { invoiceSave } = mockSourceRecords(t, { agreement, quotation: acceptedQuotation })

  await assert.rejects(
    createResource('invoices', { ...invoiceRequest, agreementId: agreement.id }, {
      id: 'request-6',
      user: { id: 'admin-1', name: 'Admin', role: 'super_admin' },
    }),
    (error) => error.code === 'AGREEMENT_NOT_ACCEPTED',
  )
  assert.equal(invoiceSave.mock.callCount(), 0)
})

test('recording the actual invoice payment settles only that invoice balance', async (t) => {
  mockTransaction(t)
  const invoice = {
    id: 'INV-ADVANCE',
    clientId: 'CL-1',
    client: 'Example Client',
    project: 'Website redesign',
    total: 20000,
    amountPaid: 0,
    balance: 20000,
    status: 'Issued',
  }
  invoice.save = t.mock.fn(async function save() { return this })
  t.mock.method(Invoice, 'findOne', () => query(invoice))
  t.mock.method(Payment, 'findOne', () => ({
    select() { return Promise.resolve(null) },
  }))
  t.mock.method(Payment, 'find', () => query([]))
  t.mock.method(Payment, 'create', async ([payment]) => [{
    ...payment,
    id: 'PAY-2026-000001',
    toJSON() { return this },
  }])
  t.mock.method(Counter, 'findOneAndUpdate', async () => ({ value: 1 }))
  t.mock.method(AuditLog, 'create', async () => [])
  t.mock.method(User, 'findOne', () => query(null))

  const result = await createResource('payments', {
    invoiceId: invoice.id,
    amount: 20000,
    date: '2026-10-21',
    method: 'Bank Transfer',
    reference: 'VERIFIED-ADVANCE',
  }, {
    id: 'request-payment-1',
    user: { id: 'accounts-1', name: 'Accounts', role: 'super_admin' },
    get: () => undefined,
  })

  assert.equal(result.record.invoiceId, invoice.id)
  assert.equal(result.record.amount, 20000)
  assert.equal(invoice.amountPaid, 20000)
  assert.equal(invoice.balance, 0)
  assert.equal(invoice.status, 'Paid')
})

test('generic invoice updates reject status and payment-total changes', async () => {
  for (const status of ['Paid', 'Cancelled', 'Issued', 'Partially Paid']) {
    assert.throws(() => resourceSchemas.invoices.update.parse({ status }), /Invoice status must be changed/)
  }
  await assert.rejects(
    updateResource('invoices', 'INV-1', { status: 'Paid' }, { user: { id: 'admin-1' } }),
    (error) => error.code === 'USE_INVOICE_WORKFLOW',
  )
  await assert.rejects(
    updateResource('invoices', 'INV-1', { amountPaid: 100, balance: 0 }, { user: { id: 'admin-1' } }),
    (error) => error.code === 'USE_INVOICE_WORKFLOW',
  )
})

test('client invoice decision is persisted separately from financial status and notifies team', async (t) => {
  mockTransaction(t)
  mockDecisionNotifications(t)
  const invoice = {
    _id: 'mongo-invoice-1',
    id: 'INV-1',
    number: 'INV-1',
    clientId: 'CL-1',
    client: 'Example Client',
    status: 'Issued',
    clientDecision: undefined,
    toObject() { return { id: this.id, clientId: this.clientId, status: this.status } },
    toJSON() {
      return {
        id: this.id,
        status: this.status,
        clientDecision: this.clientDecision,
      }
    },
  }
  let transitionFilter
  let audit
  t.mock.method(Invoice, 'findOne', async () => invoice)
  t.mock.method(Invoice, 'updateOne', async (filter) => {
    transitionFilter = filter
    return { matchedCount: 1 }
  })
  t.mock.method(AuditLog, 'create', async (entry) => { audit = entry })

  const result = await decideInvoice('INV-1', { decision: 'Rejected', reason: 'The billed scope is incorrect.' }, {
    user: { id: 'client-user-1', role: 'client', clientId: 'CL-1' },
  })

  assert.equal(result.status, 'Issued')
  assert.equal(result.clientDecision.status, 'Rejected')
  assert.equal(result.clientDecision.reason, 'The billed scope is incorrect.')
  assert.equal(result.clientDecision.decidedBy, 'client-user-1')
  assert.equal(transitionFilter.clientId, 'CL-1')
  assert.deepEqual(transitionFilter.status.$in, ['Issued', 'Partially Paid', 'Overdue'])
  assert.equal(transitionFilter['clientDecision.status'].$exists, false)
  assert.equal(audit[0].action, 'invoices.client_rejected')
})

test('invoice decision rejects unlinked clients and non-decisionable invoices', async (t) => {
  await assert.rejects(
    decideInvoice('INV-1', { decision: 'Accepted' }, { user: { id: 'staff-1', role: 'super_admin' } }),
    { code: 'CLIENT_PORTAL_ONLY' },
  )

  const invoice = {
    id: 'INV-1',
    clientId: 'CL-1',
    status: 'Paid',
    toObject() { return { id: this.id, clientId: this.clientId, status: this.status } },
  }
  t.mock.method(Invoice, 'findOne', async (filter) => filter.clientId === 'CL-1' ? invoice : null)
  await assert.rejects(
    decideInvoice('INV-1', { decision: 'Accepted' }, {
      user: { id: 'client-user-1', role: 'client', clientId: 'CL-1' },
    }),
    { code: 'INVALID_TRANSITION' },
  )
  await assert.rejects(
    decideInvoice('INV-1', { decision: 'Accepted' }, {
      user: { id: 'client-user-2', role: 'client', clientId: 'CL-2' },
    }),
    { code: 'RECORD_NOT_FOUND' },
  )
})

test('invoice rejection validation requires a reason', () => {
  assert.equal(invoiceDecisionSchema.safeParse({ decision: 'Accepted' }).success, true)
  assert.equal(invoiceDecisionSchema.safeParse({ decision: 'Rejected' }).success, false)
  assert.equal(invoiceDecisionSchema.safeParse({ decision: 'Rejected', reason: 'Incorrect amount' }).success, true)
})

function mockPaymentCreation(t, invoice, initialPayments = []) {
  mockTransaction(t)
  const storedPayments = [...initialPayments]
  t.mock.method(Invoice, 'findOne', () => query(invoice))
  t.mock.method(Payment, 'findOne', (filter) => ({
    select() {
      return Promise.resolve(storedPayments.find((payment) => payment.idempotencyKey === filter.idempotencyKey) || null)
    },
  }))
  t.mock.method(Payment, 'find', (filter) => query(storedPayments.filter((payment) =>
    payment.invoiceId === filter.invoiceId
    && payment.status === 'Recorded')))
  t.mock.method(Payment, 'create', async ([payment]) => {
    const created = {
      ...payment,
      id: `PAY-${storedPayments.length + 1}`,
      toJSON() { return { id: this.id, invoiceId: this.invoiceId, amount: this.amount, status: this.status } },
    }
    storedPayments.push(created)
    return [created]
  })
  t.mock.method(Counter, 'findOneAndUpdate', async () => ({ value: storedPayments.length + 1 }))
  t.mock.method(AuditLog, 'create', async () => [])
  t.mock.method(User, 'findOne', () => query(null))
  return storedPayments
}

const paymentRequest = {
  invoiceId: 'INV-RETRY',
  amount: 250,
  date: '2026-10-22',
  method: 'Bank Transfer',
  reference: 'BANK-REF-42',
}

test('replays an identical payment submission without requiring an Idempotency-Key', async (t) => {
  const invoice = {
    id: paymentRequest.invoiceId,
    clientId: 'CL-1',
    client: 'Example Client',
    total: 1000,
    amountPaid: 0,
    balance: 1000,
    status: 'Issued',
    save: t.mock.fn(async function save() { return this }),
  }
  const storedPayments = mockPaymentCreation(t, invoice)
  const request = {
    id: 'payment-request',
    user: { id: 'accounts-1', name: 'Accounts', role: 'super_admin' },
    get: () => undefined,
  }

  const first = await createResource('payments', paymentRequest, request)
  const replay = await createResource('payments', paymentRequest, request)

  assert.equal(storedPayments.length, 1)
  assert.equal(replay.replayed, true)
  assert.equal(replay.record.id, first.record.id)
  assert.equal(invoice.amountPaid, 250)
  assert.equal(invoice.balance, 750)
  assert.equal(invoice.status, 'Partially Paid')
})

test('rejects reuse of an explicit Idempotency-Key for a different payment', async (t) => {
  const invoice = {
    id: paymentRequest.invoiceId,
    clientId: 'CL-1',
    client: 'Example Client',
    total: 1000,
    amountPaid: 0,
    balance: 1000,
    status: 'Issued',
    save: t.mock.fn(async function save() { return this }),
  }
  const storedPayments = mockPaymentCreation(t, invoice)
  const request = {
    id: 'payment-key-reuse',
    user: { id: 'accounts-1', name: 'Accounts', role: 'super_admin' },
    get: (header) => header === 'Idempotency-Key' ? 'payment-once' : undefined,
  }

  await createResource('payments', paymentRequest, request)
  await assert.rejects(
    createResource('payments', { ...paymentRequest, amount: 300 }, request),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED',
  )

  assert.equal(storedPayments.length, 1)
  assert.equal(invoice.amountPaid, 250)
  assert.equal(invoice.balance, 750)
})

test('rejects a payment that would make invoice balance negative', async (t) => {
  const invoice = {
    id: paymentRequest.invoiceId,
    clientId: 'CL-1',
    client: 'Example Client',
    total: 1000,
    amountPaid: 800,
    balance: 200,
    status: 'Partially Paid',
  }
  const storedPayments = mockPaymentCreation(t, invoice, [{
    id: 'PAY-EXISTING',
    invoiceId: invoice.id,
    amount: 800,
    status: 'Recorded',
  }])

  await assert.rejects(
    createResource('payments', paymentRequest, {
      id: 'payment-over-balance',
      user: { id: 'accounts-1', name: 'Accounts', role: 'super_admin' },
      get: () => undefined,
    }),
    (error) => error.code === 'PAYMENT_EXCEEDS_BALANCE',
  )

  assert.equal(storedPayments.length, 1)
  assert.equal(invoice.amountPaid, 800)
  assert.equal(invoice.balance, 200)
  assert.equal(invoice.status, 'Partially Paid')
})

test('client quotation acceptance stores versioned acceptance evidence and an immutable snapshot', async (t) => {
  mockTransaction(t)
  mockDecisionNotifications(t)
  const quote = {
    id: 'QT-CLIENT-1',
    clientId: 'CL-1',
    status: 'Sent',
    version: 2,
    save: t.mock.fn(async function save() { return this }),
    toObject() {
      return {
        id: this.id,
        clientId: this.clientId,
        status: this.status,
        version: this.version,
        acceptedBy: this.acceptedBy,
        acceptance: this.acceptance,
        acceptedSnapshot: this.acceptedSnapshot,
      }
    },
    toJSON() { return this.toObject() },
  }
  t.mock.method(Quotation, 'findOne', async () => quote)
  t.mock.method(Quotation, 'updateOne', async () => ({ matchedCount: 1 }))
  const audit = t.mock.method(AuditLog, 'create', async () => [])

  const result = await transitionQuotation('QT-CLIENT-1', 'approve', {}, {
    id: 'request-accept-1',
    user: { id: 'client-user-1', role: 'client', clientId: 'CL-1' },
  })

  assert.equal(result.status, 'Accepted')
  assert.equal(result.acceptance.acceptedBy, 'client-user-1')
  assert.equal(result.acceptance.acceptedByRole, 'client')
  assert.equal(result.acceptance.version, 2)
  assert.equal(result.acceptance.method, 'client-portal')
  assert.equal(result.acceptedSnapshot.status, 'Accepted')
  assert.equal(result.acceptedSnapshot.acceptance.acceptedBy, 'client-user-1')
  assert.equal(audit.mock.calls[0].arguments[0][0].changes.method, 'client-portal')
})

test('client quotation decisions notify both the quotation owner and active super admins', async (t) => {
  mockTransaction(t)
  const ownerId = '507f1f77bcf86cd799439011'
  const quote = {
    id: 'QT-CLIENT-OWNER',
    clientId: 'CL-1',
    client: 'Example Client',
    title: 'Identity refresh',
    number: 'QT-2026-100',
    ownerId,
    status: 'Sent',
    version: 1,
    toObject() {
      return {
        id: this.id,
        clientId: this.clientId,
        status: this.status,
        version: this.version,
        acceptedBy: this.acceptedBy,
        acceptance: this.acceptance,
        acceptedSnapshot: this.acceptedSnapshot,
      }
    },
    toJSON() { return this.toObject() },
  }
  t.mock.method(Quotation, 'findOne', async () => quote)
  t.mock.method(Quotation, 'updateOne', async () => ({ matchedCount: 1 }))
  t.mock.method(User, 'findOne', () => ({
    select() { return this },
    session: async () => ({ id: ownerId }),
  }))
  t.mock.method(User, 'find', () => ({
    select() { return this },
    session: async () => [{ id: 'super-admin-1' }],
  }))
  const notifications = t.mock.method(Notification, 'findOneAndUpdate', async (_filter, update) => update.$setOnInsert)
  t.mock.method(AuditLog, 'create', async () => [])

  await transitionQuotation('QT-CLIENT-OWNER', 'approve', {}, {
    id: 'request-accept-owned-quote',
    user: { id: 'client-user-1', role: 'client', clientId: 'CL-1' },
  })

  assert.deepEqual(
    notifications.mock.calls.map((call) => call.arguments[1].$setOnInsert.recipientId).sort(),
    [ownerId, 'super-admin-1'].sort(),
  )
})

test('client rejection records the client, version, method, and timestamp', async (t) => {
  mockTransaction(t)
  mockDecisionNotifications(t)
  const quote = {
    id: 'QT-CLIENT-2',
    clientId: 'CL-1',
    status: 'Viewed',
    version: 3,
    save: t.mock.fn(async function save() { return this }),
    toObject() {
      return {
        id: this.id,
        clientId: this.clientId,
        status: this.status,
        version: this.version,
        rejectedAt: this.rejectedAt,
        rejectedBy: this.rejectedBy,
        rejection: this.rejection,
      }
    },
    toJSON() { return this.toObject() },
  }
  t.mock.method(Quotation, 'findOne', async () => quote)
  const update = t.mock.method(Quotation, 'updateOne', async () => ({ matchedCount: 1 }))
  const audit = t.mock.method(AuditLog, 'create', async () => [])

  const result = await transitionQuotation('QT-CLIENT-2', 'reject', {}, {
    id: 'request-reject-1',
    user: { id: 'client-user-1', role: 'client', clientId: 'CL-1' },
  })

  assert.equal(result.status, 'Rejected')
  assert.equal(result.rejectedBy, 'client-user-1')
  assert.equal(result.rejection.rejectedByRole, 'client')
  assert.equal(result.rejection.version, 3)
  assert.equal(result.rejection.method, 'client-portal')
  assert.ok(result.rejectedAt)
  assert.equal(update.mock.calls[0].arguments[0].status.$in[0], 'Sent')
  assert.equal(audit.mock.calls[0].arguments[0][0].changes.method, 'client-portal')
})

test('a client cannot decide another client’s quotation', async (t) => {
  const quote = { id: 'QT-OTHER', clientId: 'CL-1', status: 'Sent' }
  t.mock.method(Quotation, 'findOne', async () => quote)
  const update = t.mock.method(Quotation, 'updateOne', async () => ({ matchedCount: 1 }))

  await assert.rejects(transitionQuotation('QT-OTHER', 'approve', {}, {
    user: { id: 'client-user-2', role: 'client', clientId: 'CL-2' },
  }), { code: 'RECORD_NOT_FOUND' })
  assert.equal(update.mock.calls.length, 0)
})

test('a stale quotation decision cannot overwrite a concurrent decision', async (t) => {
  mockTransaction(t)
  const quote = {
    id: 'QT-STALE',
    clientId: 'CL-1',
    status: 'Sent',
    version: 1,
    toObject() { return { id: this.id, clientId: this.clientId, status: this.status, version: this.version } },
    toJSON() { return this.toObject() },
  }
  t.mock.method(Quotation, 'findOne', async () => quote)
  t.mock.method(Quotation, 'updateOne', async () => ({ matchedCount: 0 }))

  await assert.rejects(transitionQuotation('QT-STALE', 'approve', {}, {
    user: { id: 'client-user-1', role: 'client', clientId: 'CL-1' },
  }), { code: 'INVALID_TRANSITION' })
})
