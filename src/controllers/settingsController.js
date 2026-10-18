import { asyncRoute } from '../middleware/asyncRoute.js'
import { Setting } from '../models/index.js'
import { success } from '../utils/response.js'

const defaults = {
  companyName: 'Design Blocks',
  subtitle: 'CRM & Project Management',
  currency: 'INR · Indian Rupee',
}

export const getCompanySettings = asyncRoute(async (_req, res) => {
  const record = await Setting.findOne({ key: 'company' })
  success(res, { ...defaults, ...(record?.value || {}) })
})

export const updateCompanySettings = asyncRoute(async (req, res) => {
  const record = await Setting.findOneAndUpdate(
    { key: 'company' },
    { $set: { value: { ...defaults, ...req.body } } },
    { new: true, upsert: true, runValidators: true },
  )
  success(res, { ...defaults, ...record.value })
})
