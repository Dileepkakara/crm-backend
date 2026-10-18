import { z } from 'zod'

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).optional(),
  status: z.string().trim().max(40).optional(),
  sort: z.enum(['createdAt', 'updatedAt', 'issueDate', 'dueDate', 'date', 'name', 'status']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

export function paginationOptions(query) {
  const { page, limit, sort, order } = paginationSchema.parse(query)
  return { page, limit, skip: (page - 1) * limit, sort: { [sort]: order === 'asc' ? 1 : -1 } }
}
