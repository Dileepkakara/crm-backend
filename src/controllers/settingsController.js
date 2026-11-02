import { asyncRoute } from '../middleware/asyncRoute.js'
import mongoose from 'mongoose'
import { modelsByResource, Setting } from '../models/index.js'
import { recordAudit } from '../services/audit.js'
import { success } from '../utils/response.js'

const defaults = {
  companyName: 'Design Blocks',
  subtitle: 'CRM & Project Management',
  currency: 'INR · Indian Rupee',
}
const documentSettings = [
  'companyName', 'companyBusiness', 'companyAddress', 'companyGstin', 'companyPhone',
  'companyContactName', 'companyWard', 'companyDate', 'bankDetails', 'documentTerms',
]

export const getCompanySettings = asyncRoute(async (_req, res) => {
  const record = await Setting.findOne({ key: 'company' })
  success(res, { ...defaults, ...(record?.value || {}) })
})

export const updateCompanySettings = asyncRoute(async (req, res) => {
  const session = await mongoose.startSession()
  let record
  try {
    await session.withTransaction(async () => {
      const existing = await Setting.findOne({ key: 'company' }).session(session)
      const previousSettings = { ...defaults, ...(existing?.value || {}) }
      const nextSettings = { ...defaults, ...req.body }
      const printableSettingsChanged = documentSettings.some((field) =>
        previousSettings[field] !== nextSettings[field])
      record = await Setting.findOneAndUpdate(
        { key: 'company' },
        { $set: { value: nextSettings } },
        { new: true, upsert: true, runValidators: true, session },
      )
      if (printableSettingsChanged) {
        await Promise.all(['quotations', 'invoices', 'agreements'].map((resource) =>
          modelsByResource[resource].updateMany(
            { 'documentVersions.0': { $exists: true } },
            { $set: { documentNeedsRegeneration: true } },
            { session },
          )))
      }
      await recordAudit(req, 'settings.company_updated', 'settings', 'company', {
        fields: Object.keys(req.body),
        printableSettingsChanged,
      }, session)
    })
  } finally {
    await session.endSession()
  }
  success(res, { ...defaults, ...record.value })
})
