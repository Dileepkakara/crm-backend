import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import test from 'node:test'
import { AuditLog, Invoice, Project, Task } from '../src/models/index.js'
import { closeProject } from '../src/services/resources.js'

function query(value) {
  return { session: async () => value }
}

function prepareMocks(t, { project, tasks = [], invoices = [] }) {
  t.mock.method(mongoose, 'startSession', async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  }))
  t.mock.method(Project, 'findOne', () => query(project))
  t.mock.method(Task, 'find', () => query(tasks))
  t.mock.method(Invoice, 'find', () => query(invoices))
  t.mock.method(AuditLog, 'create', async () => [])
}

function request() {
  return {
    user: { id: 'pm-1', role: 'project_manager' },
  }
}

function completedProject() {
  return {
    id: 'PR-1',
    name: 'Client website',
    clientId: 'CL-1',
    managerId: 'pm-1',
    agreementId: 'WO-1',
    quotationId: 'QT-1',
    status: 'Completed',
    save: async function save() { return this },
    toJSON() { return this },
  }
}

const settledInvoice = {
  id: 'INV-1',
  projectId: 'PR-1',
  agreementId: 'WO-1',
  status: 'Paid',
  total: 20000,
  amountPaid: 20000,
  balance: 0,
}

test('closes completed project only after final invoice settlement and records handover evidence', async (t) => {
  const project = completedProject()
  prepareMocks(t, {
    project,
    tasks: [{ id: 'TS-1', status: 'Completed' }],
    invoices: [settledInvoice],
  })

  const result = await closeProject('PR-1', {
    handoverNotes: 'Source files and production access delivered.',
    clientReceived: true,
  }, request())

  assert.equal(result.status, 'Closed')
  assert.equal(result.handover.notes, 'Source files and production access delivered.')
  assert.equal(result.handover.clientReceived, true)
  assert.equal(result.handover.confirmedBy, 'pm-1')
  assert.ok(result.closedAt)
  assert.equal(result.closedBy, 'pm-1')
})

test('does not close a project while delivery tasks remain incomplete', async (t) => {
  prepareMocks(t, {
    project: completedProject(),
    tasks: [{ id: 'TS-1', status: 'In Progress' }],
    invoices: [settledInvoice],
  })

  await assert.rejects(
    closeProject('PR-1', { handoverNotes: 'Delivered.', clientReceived: true }, request()),
    { code: 'DELIVERY_TASKS_INCOMPLETE' },
  )
})

test('does not close a project with an unpaid invoice', async (t) => {
  prepareMocks(t, {
    project: completedProject(),
    tasks: [],
    invoices: [{ ...settledInvoice, status: 'Partially Paid', amountPaid: 10000, balance: 10000 }],
  })

  await assert.rejects(
    closeProject('PR-1', { handoverNotes: 'Delivered.', clientReceived: true }, request()),
    { code: 'INVOICES_UNSETTLED' },
  )
})

test('requires an active invoice before final project closure', async (t) => {
  prepareMocks(t, {
    project: completedProject(),
    invoices: [{ ...settledInvoice, status: 'Cancelled' }],
  })

  await assert.rejects(
    closeProject('PR-1', { handoverNotes: 'Delivered.', clientReceived: true }, request()),
    { code: 'FINAL_INVOICE_REQUIRED' },
  )
})
