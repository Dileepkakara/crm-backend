import assert from 'node:assert/strict'
import test from 'node:test'
import { hasPermission } from '../src/middleware/authorize.js'
import { roleSchemas } from '../src/validation/roleSchemas.js'
import { userSchemas } from '../src/validation/resourceSchemas.js'

test('custom-role permission checks grant only the stored permissions', () => {
  const user = { role: 'custom_hr_manager', permissions: ['clients.view', 'users.view'] }

  assert.equal(hasPermission(user, 'clients.view'), true)
  assert.equal(hasPermission(user, 'users.view'), true)
  assert.equal(hasPermission(user, 'invoices.view'), false)
  assert.equal(hasPermission(user, 'roles.manage'), false)
})

test('role validation accepts known permissions and rejects unknown permissions', () => {
  const valid = roleSchemas.create.safeParse({
    name: 'HR Manager',
    description: 'People operations',
    permissions: ['users.view', 'dashboard.view'],
    status: 'Active',
  })
  const invalid = roleSchemas.create.safeParse({
    name: 'HR Manager',
    permissions: ['database.drop'],
  })

  assert.equal(valid.success, true)
  assert.equal(invalid.success, false)
})

test('role patch fields do not reset omitted values', () => {
  const patch = roleSchemas.update.safeParse({ status: 'Inactive' })

  assert.equal(patch.success, true)
  assert.deepEqual(patch.data, { status: 'Inactive' })
})

test('user validation accepts generated custom role keys but rejects arbitrary role values', () => {
  const user = {
    name: 'Example User',
    email: 'example@example.com',
    password: 'long-enough-temporary-password',
    role: 'custom_hr_manager',
  }

  assert.equal(userSchemas.create.safeParse(user).success, true)
  assert.equal(userSchemas.create.safeParse({ ...user, role: 'root' }).success, false)
})
