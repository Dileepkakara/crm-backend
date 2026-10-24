import test from 'node:test'
import assert from 'node:assert/strict'
import { assertUserCanBeDeleted } from '../src/services/userDeletion.js'
import { ROLES } from '../src/permissions/rolePermissions.js'

const superAdmin = { id: 'admin-1', role: ROLES.SUPER_ADMIN }

test('allows deleting a regular user without affecting active Super Admins', () => {
  assert.doesNotThrow(() => assertUserCanBeDeleted(superAdmin, {
    id: 'user-1',
    role: ROLES.SALES_EXECUTIVE,
    status: 'Active',
  }, null))
})

test('does not allow deleting the signed-in account', () => {
  assert.throws(
    () => assertUserCanBeDeleted(superAdmin, { ...superAdmin, status: 'Active' }, 2),
    { code: 'SELF_DELETION_FORBIDDEN' },
  )
})

test('does not allow a non-Super Admin to delete accounts', () => {
  assert.throws(
    () => assertUserCanBeDeleted({ id: 'manager-1', role: ROLES.SALES_MANAGER }, {
      id: 'user-1',
      role: ROLES.SALES_EXECUTIVE,
      status: 'Active',
    }, null),
    { code: 'USER_MANAGEMENT_FORBIDDEN' },
  )
})

test('preserves the last active Super Admin account', () => {
  assert.throws(
    () => assertUserCanBeDeleted(superAdmin, { id: 'admin-2', role: ROLES.SUPER_ADMIN, status: 'Active' }, 1),
    { code: 'LAST_SUPER_ADMIN' },
  )
})

test('allows deleting one of multiple active Super Admins', () => {
  assert.doesNotThrow(() => assertUserCanBeDeleted(
    superAdmin,
    { id: 'admin-2', role: ROLES.SUPER_ADMIN, status: 'Active' },
    2,
  ))
})
