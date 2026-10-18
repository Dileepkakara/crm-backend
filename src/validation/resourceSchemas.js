import { z } from 'zod'

const text = (max = 500) => z.string().trim().max(max)
const optionalText = (max = 500) => text(max).optional().or(z.literal(''))
const email = z.string().trim().email().max(254)
const money = z.coerce.number().finite().min(0).max(1000000000000)
const date = z.coerce.date()
const itemSchema = z.object({
  description: text(1000).min(1),
  quantity: z.coerce.number().finite().positive().max(1000000000),
  rate: money,
})

const leadFields = {
  name: text(120).min(1),
  company: text(160).min(1),
  email,
  phone: text(40).min(1),
  source: text(60).min(1),
  service: text(160).min(1),
  budget: money.optional(),
  timeline: optionalText(120),
  priority: z.enum(['Low', 'Medium', 'High', 'Urgent']).optional(),
  status: z.enum(['New', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost']).optional(),
  assigneeId: optionalText(100),
  assignee: optionalText(120),
  followUp: date.optional(),
  notes: optionalText(10000),
}

const followupFields = {
  leadId: optionalText(100),
  clientId: optionalText(100),
  contact: text(120).min(1),
  company: text(160).min(1),
  type: text(60).min(1),
  dueDate: date,
  assigneeId: optionalText(100),
  assignee: optionalText(120),
  status: z.enum(['Upcoming', 'Due today', 'Overdue', 'Completed']).optional(),
  notes: optionalText(10000),
  meetingDetails: optionalText(5000),
}

const clientFields = {
  name: text(120).min(1),
  company: text(160).min(1),
  email,
  phone: text(40).min(1),
  address: optionalText(1000),
  gstin: optionalText(20),
  status: z.enum(['Active', 'Prospect', 'Inactive']).optional(),
  leadId: optionalText(100),
  since: date.optional(),
  contacts: z.array(z.object({
    name: text(120).min(1),
    email: email.optional(),
    phone: optionalText(40),
    title: optionalText(100),
  })).max(30).optional(),
}

const commercialFields = {
  clientId: text(100).min(1),
  client: optionalText(160),
  leadId: optionalText(100),
  title: text(200).min(1),
  issueDate: date,
  validUntil: date,
  version: z.coerce.number().int().positive().optional(),
  items: z.array(itemSchema).min(1).max(100).optional(),
  lineItems: z.array(itemSchema).min(1).max(100).optional(),
  discount: money.optional(),
  gstEnabled: z.boolean().optional(),
  sgstEnabled: z.boolean().optional(),
  cgstEnabled: z.boolean().optional(),
  sgstRate: z.coerce.number().finite().min(0).max(100).optional(),
  cgstRate: z.coerce.number().finite().min(0).max(100).optional(),
  terms: optionalText(10000),
  billingName: optionalText(120),
  billingAddress: optionalText(1000),
  customerGstin: optionalText(20),
  contactEmail: z.union([email, z.literal('')]).optional(),
  contactPhone: optionalText(40),
  companyGstin: optionalText(20),
  companyAddress: optionalText(1000),
  bankDetails: optionalText(1000),
  status: z.enum(['Draft', 'Sent', 'Viewed', 'Accepted', 'Rejected', 'Expired', 'Revised']).optional(),
}

const agreementFields = {
  clientId: text(100).min(1),
  client: optionalText(160),
  quotationId: optionalText(100),
  project: text(200).min(1),
  version: z.coerce.number().int().positive().optional(),
  createdAt: date.optional(),
  startDate: date.optional(),
  deadline: date.optional(),
  scope: optionalText(20000),
  deliverables: optionalText(10000),
  paymentMilestones: optionalText(10000),
  terms: optionalText(10000),
  status: z.enum(['Draft', 'Pending approval', 'Accepted', 'Rejected']).optional(),
  billingName: optionalText(120),
  billingAddress: optionalText(1000),
  customerGstin: optionalText(20),
  contactEmail: z.union([email, z.literal('')]).optional(),
  contactPhone: optionalText(40),
  companyGstin: optionalText(20),
  companyAddress: optionalText(1000),
  bankDetails: optionalText(1000),
}

const invoiceFields = {
  clientId: text(100).min(1),
  client: optionalText(160),
  projectId: optionalText(100),
  project: optionalText(200),
  agreementId: optionalText(100),
  quotationId: optionalText(100),
  issueDate: date,
  dueDate: date,
  items: z.array(itemSchema).min(1).max(100).optional(),
  lineItems: z.array(itemSchema).min(1).max(100).optional(),
  discount: money.optional(),
  gstEnabled: z.boolean().optional(),
  sgstEnabled: z.boolean().optional(),
  cgstEnabled: z.boolean().optional(),
  sgstRate: z.coerce.number().finite().min(0).max(100).optional(),
  cgstRate: z.coerce.number().finite().min(0).max(100).optional(),
  status: z.enum(['Draft', 'Issued', 'Partially Paid', 'Paid', 'Overdue', 'Cancelled']).optional(),
  billingName: optionalText(120),
  billingAddress: optionalText(1000),
  customerGstin: optionalText(20),
  contactEmail: z.union([email, z.literal('')]).optional(),
  contactPhone: optionalText(40),
  terms: optionalText(10000),
  companyGstin: optionalText(20),
  companyAddress: optionalText(1000),
  bankDetails: optionalText(1000),
}

const paymentFields = {
  invoiceId: text(100).min(1),
  clientId: optionalText(100),
  client: optionalText(160),
  projectId: optionalText(100),
  project: optionalText(200),
  date,
  amount: z.coerce.number().finite().positive().max(1000000000000),
  method: text(60).min(1),
  reference: optionalText(160),
  transactionReference: optionalText(160),
}

const projectFields = {
  name: text(200).min(1),
  clientId: text(100).min(1),
  client: optionalText(160),
  quotationId: optionalText(100),
  agreementId: optionalText(100),
  managerId: optionalText(100),
  manager: optionalText(120),
  teamMemberIds: z.array(text(100)).max(100).optional(),
  scope: optionalText(20000),
  startDate: date.optional(),
  deadline: date.optional(),
  progress: z.coerce.number().int().min(0).max(100).optional(),
  status: z.enum(['Planning', 'Not Started', 'In Progress', 'On Hold', 'In Review', 'Completed', 'Cancelled']).optional(),
  milestones: z.array(z.object({
    id: optionalText(100),
    name: text(200).min(1),
    dueDate: date.optional(),
    amount: money.optional(),
    status: z.enum(['Pending', 'In Progress', 'Completed']).optional(),
  })).max(100).optional(),
  deliveryRequirements: optionalText(10000),
}

const taskFields = {
  title: text(200).min(1),
  description: optionalText(10000),
  projectId: text(100).min(1),
  project: optionalText(200),
  assigneeId: optionalText(100),
  assignee: optionalText(120),
  priority: z.enum(['Low', 'Medium', 'High', 'Urgent']).optional(),
  dueDate: date.optional(),
  status: z.enum(['To Do', 'In Progress', 'In Review', 'Blocked', 'Completed']).optional(),
  progress: z.coerce.number().int().min(0).max(100).optional(),
  dependencies: z.array(text(100)).max(100).optional(),
}

const notificationFields = {
  read: z.boolean(),
}

export const resourceSchemas = {
  leads: { create: z.object(leadFields), update: z.object(leadFields).partial() },
  followups: { create: z.object(followupFields), update: z.object(followupFields).partial() },
  clients: { create: z.object(clientFields), update: z.object(clientFields).partial() },
  quotations: { create: z.object(commercialFields), update: z.object(commercialFields).partial() },
  agreements: { create: z.object(agreementFields), update: z.object(agreementFields).partial() },
  invoices: { create: z.object(invoiceFields), update: z.object(invoiceFields).partial() },
  payments: { create: z.object(paymentFields), update: z.object(paymentFields).partial() },
  projects: { create: z.object(projectFields), update: z.object(projectFields).partial() },
  tasks: { create: z.object(taskFields), update: z.object(taskFields).partial() },
  notifications: { create: z.object({ title: text(200).min(1), body: optionalText(2000), category: optionalText(80) }), update: z.object(notificationFields) },
}

export const authSchemas = {
  login: z.object({ email, password: z.string().min(1).max(200) }),
  changePassword: z.object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(12).max(200),
  }),
}

export const userSchemas = {
  create: z.object({
    name: text(120).min(1),
    email,
    password: z.string().min(12).max(200),
    phone: optionalText(40),
    role: z.string().trim().min(1).max(100).regex(/^(super_admin|director|sales_manager|sales_executive|accounts|project_manager|developer|client|custom_[a-z0-9_]+)$/),
    status: z.enum(['Active', 'Inactive']).optional(),
    teamId: optionalText(100),
    department: optionalText(120),
    clientId: optionalText(100),
    assignedLeadIds: z.array(text(100)).optional(),
    assignedClientIds: z.array(text(100)).optional(),
    assignedProjectIds: z.array(text(100)).optional(),
    assignedTaskIds: z.array(text(100)).optional(),
  }),
  update: z.object({
    name: text(120).min(1).optional(),
    email: email.optional(),
    phone: optionalText(40),
    role: z.string().trim().min(1).max(100).regex(/^(super_admin|director|sales_manager|sales_executive|accounts|project_manager|developer|client|custom_[a-z0-9_]+)$/).optional(),
    status: z.enum(['Active', 'Inactive']).optional(),
    teamId: optionalText(100),
    department: optionalText(120),
    clientId: optionalText(100),
    assignedLeadIds: z.array(text(100)).optional(),
    assignedClientIds: z.array(text(100)).optional(),
    assignedProjectIds: z.array(text(100)).optional(),
    assignedTaskIds: z.array(text(100)).optional(),
  }),
  setPassword: z.object({ newPassword: z.string().min(12).max(200) }),
}
