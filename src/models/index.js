import mongoose from 'mongoose'

const { Schema, model, models } = mongoose

const transformDocument = (_doc, ret) => {
  ret.id = ret.id || ret._id.toString()
  delete ret._id
  delete ret.__v
  delete ret.passwordHash
  delete ret.refreshTokenHash
  delete ret.tokenVersion
  delete ret.idempotencyKey
  delete ret.idempotencyFingerprint
  for (const [key, value] of Object.entries(ret)) {
    if (value instanceof Date && (key.toLowerCase().includes('date') || ['since', 'followUp'].includes(key))) {
      ret[key] = value.toISOString().slice(0, 10)
    }
  }
  return ret
}

const baseOptions = {
  timestamps: true,
  toJSON: { transform: transformDocument },
  toObject: { transform: transformDocument },
}

const userSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, lowercase: true, trim: true, unique: true, index: true },
  phone: { type: String, trim: true, maxlength: 40 },
  passwordHash: { type: String, required: true, select: false },
  mustChangePassword: { type: Boolean, default: false },
  role: { type: String, required: true, trim: true, maxlength: 100 },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active', index: true },
  teamId: { type: String, trim: true },
  department: { type: String, trim: true, maxlength: 120 },
  clientId: { type: String, index: true },
  assignedLeadIds: { type: [String], default: [] },
  assignedClientIds: { type: [String], default: [] },
  assignedProjectIds: { type: [String], default: [] },
  assignedTaskIds: { type: [String], default: [] },
  initials: { type: String, maxlength: 4 },
  tokenVersion: { type: Number, default: 0, select: false },
  refreshTokenHash: { type: String, select: false },
}, baseOptions)

const definitions = {
  Lead: {
    id: { type: String, unique: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    company: { type: String, required: true, trim: true, maxlength: 160 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    phone: { type: String, required: true, trim: true, maxlength: 40 },
    normalizedPhone: { type: String, index: true },
    source: { type: String, required: true, trim: true, maxlength: 60 },
    service: { type: String, required: true, trim: true, maxlength: 160 },
    budget: { type: Number, min: 0, default: 0 },
    timeline: { type: String, trim: true, maxlength: 120 },
    priority: { type: String, enum: ['Low', 'Medium', 'High', 'Urgent'], default: 'Medium' },
    status: { type: String, enum: ['New', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost'], default: 'New', index: true },
    assigneeId: { type: String, index: true },
    assignee: { type: String, trim: true },
    followUp: { type: Date },
    createdAt: { type: Date },
    notes: { type: String, maxlength: 10000 },
    activities: { type: [Schema.Types.Mixed], default: [] },
    assignmentHistory: { type: [Schema.Types.Mixed], default: [] },
    convertedClientId: { type: String },
  },
  FollowUp: {
    id: { type: String, unique: true, index: true },
    leadId: { type: String, index: true },
    clientId: { type: String, index: true },
    contact: { type: String, required: true, trim: true, maxlength: 120 },
    company: { type: String, required: true, trim: true, maxlength: 160 },
    type: { type: String, required: true, trim: true, maxlength: 60 },
    dueDate: { type: Date, required: true, index: true },
    assigneeId: { type: String, index: true },
    assignee: { type: String, trim: true },
    status: { type: String, enum: ['Upcoming', 'Due today', 'Overdue', 'Completed'], default: 'Upcoming', index: true },
    notes: { type: String, maxlength: 10000 },
    meetingDetails: { type: String, maxlength: 5000 },
    completedAt: { type: Date },
  },
  Client: {
    id: { type: String, unique: true, index: true },
    leadId: { type: String, unique: true, sparse: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    company: { type: String, required: true, trim: true, maxlength: 160 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    phone: { type: String, required: true, trim: true, maxlength: 40 },
    normalizedPhone: { type: String, index: true },
    address: { type: String, maxlength: 1000 },
    gstin: { type: String, trim: true, uppercase: true, maxlength: 20 },
    status: { type: String, enum: ['Active', 'Prospect', 'Inactive'], default: 'Active', index: true },
    since: { type: Date },
    contacts: { type: [Schema.Types.Mixed], default: [] },
  },
  Quotation: {
    id: { type: String, unique: true, index: true },
    number: { type: String, unique: true, sparse: true, index: true },
    clientId: { type: String, required: true, index: true },
    client: { type: String, trim: true },
    leadId: { type: String, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    ownerId: { type: String, index: true },
    owner: { type: String, trim: true },
    issueDate: { type: Date, required: true },
    validUntil: { type: Date, required: true },
    version: { type: Number, min: 1, default: 1 },
    revisionOf: { type: String, index: true },
    revisionReason: { type: String, maxlength: 1000 },
    revisionDate: { type: Date },
    status: { type: String, enum: ['Draft', 'Sent', 'Viewed', 'Accepted', 'Rejected', 'Expired', 'Revised'], default: 'Draft', index: true },
    invoiceAllocationVersion: { type: Number, default: 0 },
    items: { type: [Schema.Types.Mixed], default: [] },
    lineItems: { type: [Schema.Types.Mixed], default: undefined },
    subtotal: { type: Number, min: 0 },
    discount: { type: Number, min: 0, default: 0 },
    taxableValue: { type: Number, min: 0 },
    gstEnabled: { type: Boolean, default: false },
    sgstEnabled: { type: Boolean, default: true },
    cgstEnabled: { type: Boolean, default: true },
    sgstRate: { type: Number, min: 0, max: 100, default: 0 },
    cgstRate: { type: Number, min: 0, max: 100, default: 0 },
    sgstAmount: { type: Number, min: 0, default: 0 },
    cgstAmount: { type: Number, min: 0, default: 0 },
    tax: { type: Number, min: 0, default: 0 },
    amount: { type: Number, min: 0, default: 0 },
    total: { type: Number, min: 0, default: 0 },
    billingName: String,
    billingAddress: String,
    customerGstin: String,
    contactEmail: String,
    contactPhone: String,
    terms: String,
    companyGstin: String,
    companyAddress: String,
    bankDetails: String,
    sentAt: Date,
    acceptedAt: Date,
    acceptedBy: String,
    rejectedAt: Date,
    rejectedBy: String,
    rejection: Schema.Types.Mixed,
    acceptance: Schema.Types.Mixed,
    acceptedSnapshot: Schema.Types.Mixed,
  },
  Agreement: {
    id: { type: String, unique: true, index: true },
    clientId: { type: String, required: true, index: true },
    client: { type: String, trim: true },
    quotationId: { type: String, index: true },
    projectId: { type: String, index: true },
    project: { type: String, required: true, trim: true, maxlength: 200 },
    version: { type: Number, min: 1, default: 1 },
    createdAt: { type: Date },
    startDate: Date,
    deadline: Date,
    scope: String,
    deliverables: String,
    paymentMilestones: String,
    terms: String,
    status: { type: String, enum: ['Draft', 'Pending approval', 'Accepted', 'Rejected'], default: 'Draft', index: true },
    invoiceAllocationVersion: { type: Number, default: 0 },
    acceptedAt: Date,
    acceptedBy: String,
    rejectedAt: Date,
    rejectionReason: { type: String, maxlength: 1000 },
    acceptance: Schema.Types.Mixed,
    acceptedSnapshot: Schema.Types.Mixed,
    quotationSnapshot: Schema.Types.Mixed,
    billingName: String,
    billingAddress: String,
    customerGstin: String,
    contactEmail: String,
    contactPhone: String,
    companyGstin: String,
    companyAddress: String,
    bankDetails: String,
    total: { type: Number, min: 0 },
    amount: { type: Number, min: 0 },
  },
  Invoice: {
    id: { type: String, unique: true, index: true },
    number: { type: String, unique: true, sparse: true, index: true },
    clientId: { type: String, required: true, index: true },
    client: { type: String, trim: true },
    projectId: { type: String, index: true },
    project: { type: String, trim: true },
    agreementId: { type: String, index: true },
    quotationId: { type: String, index: true },
    billingSourceKey: { type: String, unique: true, sparse: true, index: true },
    sourceSnapshot: Schema.Types.Mixed,
    issueDate: { type: Date, required: true },
    dueDate: { type: Date, required: true, index: true },
    items: { type: [Schema.Types.Mixed], default: [] },
    lineItems: { type: [Schema.Types.Mixed], default: undefined },
    subtotal: { type: Number, min: 0 },
    discount: { type: Number, min: 0, default: 0 },
    taxableValue: { type: Number, min: 0 },
    gstEnabled: { type: Boolean, default: false },
    sgstEnabled: { type: Boolean, default: true },
    cgstEnabled: { type: Boolean, default: true },
    sgstRate: { type: Number, min: 0, max: 100, default: 0 },
    cgstRate: { type: Number, min: 0, max: 100, default: 0 },
    sgstAmount: { type: Number, min: 0, default: 0 },
    cgstAmount: { type: Number, min: 0, default: 0 },
    tax: { type: Number, min: 0, default: 0 },
    total: { type: Number, min: 0, default: 0 },
    amount: { type: Number, min: 0, default: 0 },
    amountPaid: { type: Number, min: 0, default: 0 },
    balance: { type: Number, min: 0, default: 0 },
    status: { type: String, enum: ['Draft', 'Issued', 'Partially Paid', 'Paid', 'Overdue', 'Cancelled'], default: 'Draft', index: true },
    clientDecision: {
      status: { type: String, enum: ['Accepted', 'Rejected'] },
      decidedAt: Date,
      decidedBy: String,
      reason: { type: String, trim: true, maxlength: 1000 },
    },
    billingName: String,
    billingAddress: String,
    customerGstin: String,
    contactEmail: String,
    contactPhone: String,
    terms: String,
    companyGstin: String,
    companyAddress: String,
    bankDetails: String,
    issuedAt: Date,
  },
  Payment: {
    id: { type: String, unique: true, index: true },
    invoiceId: { type: String, index: true },
    clientId: { type: String, required: true, index: true },
    client: { type: String, trim: true },
    projectId: String,
    project: String,
    date: { type: Date, required: true, index: true },
    amount: { type: Number, required: true, min: 0.01 },
    method: { type: String, required: true, trim: true, maxlength: 60 },
    reference: { type: String, trim: true, maxlength: 160 },
    transactionReference: { type: String, trim: true, maxlength: 160 },
    status: { type: String, enum: ['Pending', 'Recorded', 'Refunded'], default: 'Recorded', index: true },
    recordedById: String,
    recordedBy: String,
    idempotencyKey: { type: String, unique: true, sparse: true },
    idempotencyFingerprint: { type: String, select: false },
    refundedAt: Date,
    refundReason: String,
  },
  Project: {
    id: { type: String, unique: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    clientId: { type: String, required: true, index: true },
    client: String,
    quotationId: String,
    agreementId: { type: String, unique: true, sparse: true, index: true },
    managerId: { type: String, index: true },
    manager: String,
    teamMemberIds: { type: [String], default: [] },
    scope: String,
    startDate: Date,
    deadline: Date,
    progress: { type: Number, min: 0, max: 100, default: 0 },
    status: { type: String, enum: ['Planning', 'Not Started', 'In Progress', 'On Hold', 'In Review', 'Completed', 'Closed', 'Cancelled'], default: 'Planning', index: true },
    milestones: { type: [Schema.Types.Mixed], default: [] },
    deliveryRequirements: String,
    handover: Schema.Types.Mixed,
    closedAt: Date,
    closedBy: String,
  },
  Task: {
    id: { type: String, unique: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: String,
    projectId: { type: String, required: true, index: true },
    project: String,
    assigneeId: { type: String, index: true },
    assignee: String,
    priority: { type: String, enum: ['Low', 'Medium', 'High', 'Urgent'], default: 'Medium' },
    dueDate: { type: Date, index: true },
    status: { type: String, enum: ['To Do', 'In Progress', 'In Review', 'Blocked', 'Completed'], default: 'To Do', index: true },
    progress: { type: Number, min: 0, max: 100, default: 0 },
    dependencies: { type: [String], default: [] },
    internalComments: { type: [Schema.Types.Mixed], default: [] },
  },
  Notification: {
    id: { type: String, unique: true, index: true },
    dedupeKey: { type: String, unique: true, sparse: true },
    recipientId: { type: String, required: true, index: true },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, maxlength: 2000 },
    date: { type: Date, default: Date.now, index: true },
    category: { type: String, maxlength: 80 },
    read: { type: Boolean, default: false, index: true },
    href: { type: String, maxlength: 500 },
    eventType: { type: String, maxlength: 80 },
  },
  AuditLog: {
    actorId: { type: String, index: true },
    actorRole: String,
    action: { type: String, required: true, index: true },
    entity: { type: String, required: true, index: true },
    entityId: { type: String, index: true },
    changes: Schema.Types.Mixed,
    requestId: String,
    createdAt: { type: Date, default: Date.now, index: true },
  },
  Setting: {
    key: { type: String, unique: true, required: true },
    value: { type: Schema.Types.Mixed, default: {} },
  },
  Counter: {
    key: { type: String, unique: true, required: true },
    value: { type: Number, default: 0 },
  },
}

export const User = models.User || model('User', userSchema)

const clientSignupRequestSchema = new Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  company: { type: String, required: true, trim: true, maxlength: 160 },
  email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
  normalizedEmail: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, required: true, trim: true, maxlength: 40 },
  address: { type: String, trim: true, maxlength: 1000 },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending', index: true },
  clientId: { type: String },
  userId: { type: String },
  reviewedBy: { type: String },
  reviewedAt: { type: Date },
  rejectionReason: { type: String, maxlength: 1000 },
}, baseOptions)
clientSignupRequestSchema.index(
  { normalizedEmail: 1 },
  { unique: true, partialFilterExpression: { status: 'Pending' } },
)

export const ClientSignupRequest = models.ClientSignupRequest
  || model('ClientSignupRequest', clientSignupRequestSchema)

const customRoleSchema = new Schema({
  key: { type: String, required: true, unique: true, trim: true, match: /^custom_[a-z0-9_]+$/ },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  nameNormalized: { type: String, required: true, unique: true, trim: true, lowercase: true },
  description: { type: String, trim: true, maxlength: 500, default: '' },
  permissions: { type: [String], required: true, default: [] },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active', index: true },
}, baseOptions)

export const CustomRole = models.CustomRole || model('CustomRole', customRoleSchema)

export const modelsByResource = Object.fromEntries(
  Object.entries(definitions).map(([name, definition]) => {
    const schema = new Schema(definition, { ...baseOptions, strict: true })
    if (name === 'Lead') schema.index({ email: 1, phone: 1 })
    if (name === 'Client') schema.index({ email: 1, company: 1 })
    if (name === 'FollowUp') schema.index({ assigneeId: 1, dueDate: 1, status: 1 })
    if (name === 'Task') schema.index({ projectId: 1, assigneeId: 1, status: 1 })
    if (name === 'Notification') schema.index({ recipientId: 1, read: 1, date: -1 })
    return [name.toLowerCase() + 's', models[name] || model(name, schema)]
  }),
)

export const Lead = modelsByResource.leads
export const FollowUp = modelsByResource.followups
export const Client = modelsByResource.clients
export const Quotation = modelsByResource.quotations
export const Agreement = modelsByResource.agreements
export const Invoice = modelsByResource.invoices
export const Payment = modelsByResource.payments
export const Project = modelsByResource.projects
export const Task = modelsByResource.tasks
export const Notification = modelsByResource.notifications
export const AuditLog = models.AuditLog || model('AuditLog', new Schema(definitions.AuditLog, baseOptions))
export const Setting = models.Setting || model('Setting', new Schema(definitions.Setting, baseOptions))
export const Counter = models.Counter || model('Counter', new Schema(definitions.Counter, baseOptions))
