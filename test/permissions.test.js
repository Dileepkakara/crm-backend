import assert from 'node:assert/strict'
import test from 'node:test'
import { hasPermission } from '../src/middleware/authorize.js'

test('keeps role permissions scoped to the CRM role matrix', () => {
  assert.equal(hasPermission({ role: 'sales_executive' }, 'leads.view.assigned'), true)
  assert.equal(hasPermission({ role: 'sales_executive' }, 'invoices.manage'), false)
  assert.equal(hasPermission({ role: 'client' }, 'notifications.view'), true)
  assert.equal(hasPermission({ role: 'unknown' }, 'dashboard.view'), false)
})
