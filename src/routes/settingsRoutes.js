import { Router } from 'express'
import { z } from 'zod'
import { getCompanySettings, updateCompanySettings } from '../controllers/settingsController.js'
import { authenticate } from '../middleware/authenticate.js'
import { authorize } from '../middleware/authorize.js'
import { validate } from '../middleware/validate.js'

const router = Router()
const settingsSchema = z.object({
  companyName: z.string().trim().min(1).max(160).optional(),
  subtitle: z.string().trim().max(200).optional(),
  currency: z.enum(['INR · Indian Rupee', 'USD · US Dollar']).optional(),
  companyBusiness: z.string().trim().max(200).optional(),
  companyAddress: z.string().trim().max(1000).optional(),
  companyGstin: z.string().trim().max(20).optional(),
  companyPhone: z.string().trim().max(40).optional(),
  companyContactName: z.string().trim().max(120).optional(),
  companyWard: z.string().trim().max(40).optional(),
  companyDate: z.string().trim().max(40).optional(),
  bankDetails: z.string().trim().max(1000).optional(),
  documentTerms: z.string().trim().max(10000).optional(),
})

router.use(authenticate)
router.get('/company', getCompanySettings)
router.patch('/company', authorize('settings.manage'), validate({ body: settingsSchema }), updateCompanySettings)

export default router
