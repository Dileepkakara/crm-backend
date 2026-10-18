import { z } from 'zod'
import { PERMISSION_CATALOG } from '../permissions/rolePermissions.js'

const knownPermissions = new Set(PERMISSION_CATALOG.map(({ key }) => key))

const roleFields = {
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional(),
  permissions: z.array(z.string().refine((permission) => knownPermissions.has(permission), 'Unknown permission'))
    .min(1).max(knownPermissions.size).refine((permissions) => new Set(permissions).size === permissions.length, 'Permissions must be unique'),
  status: z.enum(['Active', 'Inactive']).optional(),
}

export const roleSchemas = {
  create: z.object({
    ...roleFields,
    description: roleFields.description.default(''),
  }),
  update: z.object({
    ...roleFields,
    name: roleFields.name.optional(),
    description: roleFields.description.optional(),
    permissions: roleFields.permissions.optional(),
    status: roleFields.status.optional(),
  }).refine((fields) => Object.keys(fields).length > 0, 'At least one field is required'),
}
