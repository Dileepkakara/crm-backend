import { AppError } from '../errors/AppError.js'
import { asyncRoute } from '../middleware/asyncRoute.js'
import { hasPermission } from '../middleware/authorize.js'
import { Agreement, Client, Invoice, Payment, Project, Quotation } from '../models/index.js'
import { listResources, safeResource, summarizeLeadSources, summarizeResource } from '../services/resources.js'
import { success } from '../utils/response.js'

function requireClient(req) {
  if (req.user.role !== 'client' || !req.user.clientId) {
    throw new AppError(403, 'CLIENT_PORTAL_ONLY', 'Client portal access is only available to a linked client account.')
  }
}

export const portal = asyncRoute(async (req, res) => {
  requireClient(req)
  const clientId = req.user.clientId
  const [client, quotations, agreements, invoices, projects, payments] = await Promise.all([
    Client.findOne({ id: clientId }),
    Quotation.find({ clientId, status: { $ne: 'Draft' } }).sort({ issueDate: -1 }).limit(100),
    Agreement.find({ clientId }).sort({ createdAt: -1 }).limit(100),
    Invoice.find({ clientId }).sort({ issueDate: -1 }).limit(100),
    Project.find({ clientId }).sort({ updatedAt: -1 }).limit(100),
    Payment.find({ clientId, status: { $ne: 'Refunded' } }).sort({ date: -1 }).limit(100),
  ])
  if (!client) throw new AppError(404, 'CLIENT_NOT_FOUND', 'The linked client profile was not found.')
  const safePayments = payments.map((payment) => {
    const value = payment.toJSON()
    delete value.recordedBy
    delete value.recordedById
    delete value.idempotencyKey
    return value
  })
  success(res, {
    client: client.toJSON(),
    quotations: quotations.map((record) => {
      const value = record.toJSON()
      delete value.owner
      delete value.ownerId
      delete value.acceptedSnapshot
      return value
    }),
    agreements: agreements.map((record) => safeResource('agreements', record, req.user)),
    invoices: invoices.map((record) => safeResource('invoices', record, req.user)),
    projects: projects.map((record) => record.toJSON()),
    payments: safePayments,
  })
})

export const dashboard = asyncRoute(async (req, res) => {
  const allowed = {
    leads: hasPermission(req.user, 'leads.view.all') || hasPermission(req.user, 'leads.view.assigned'),
    followups: hasPermission(req.user, 'followups.view'),
    quotations: hasPermission(req.user, 'quotations.view') || hasPermission(req.user, 'quotations.view.own'),
    invoices: hasPermission(req.user, 'invoices.view') || hasPermission(req.user, 'invoices.view.own'),
    payments: hasPermission(req.user, 'payments.view') || hasPermission(req.user, 'payments.view.own'),
    projects: hasPermission(req.user, 'projects.view') || hasPermission(req.user, 'projects.view.assigned'),
    tasks: hasPermission(req.user, 'tasks.view') || hasPermission(req.user, 'tasks.view.assigned'),
  }
  const summaries = Object.fromEntries(await Promise.all(Object.entries(allowed)
    .filter(([, canView]) => canView)
    .map(async ([resource]) => [resource, await summarizeResource(resource, req.user)])))
  const recent = {}
  const sourcesPromise = allowed.leads ? summarizeLeadSources(req.user) : Promise.resolve(undefined)
  const recentTasks = allowed.tasks
    ? listResources('tasks', { user: req.user, query: { limit: 4, page: 1, sort: 'createdAt', order: 'desc' } })
    : Promise.resolve(undefined)
  const recentProjects = allowed.projects
    ? listResources('projects', { user: req.user, query: { limit: 4, page: 1, sort: 'updatedAt', order: 'desc' } })
    : Promise.resolve(undefined)
  const [leadRows, followupRows, invoiceRows, projectRows, taskRows, leadSources] = await Promise.all([
    allowed.leads ? listResources('leads', { user: req.user, query: { limit: 4, page: 1, sort: 'createdAt', order: 'desc' } }) : undefined,
    allowed.followups ? listResources('followups', { user: req.user, query: { limit: 20, page: 1, sort: 'dueDate', order: 'asc' } }) : undefined,
    allowed.invoices ? listResources('invoices', { user: req.user, query: { limit: 4, page: 1, sort: 'dueDate', order: 'asc' } }) : undefined,
    recentProjects,
    recentTasks,
    sourcesPromise,
  ])
  if (leadRows) recent.leads = leadRows.records
  if (followupRows) recent.followups = followupRows.records.filter((item) => item.status !== 'Completed').slice(0, 4)
  if (invoiceRows) recent.invoices = invoiceRows.records.filter((item) => !['Paid', 'Cancelled', 'Draft'].includes(item.status))
  if (projectRows) recent.projects = projectRows.records
  if (taskRows) recent.tasks = taskRows.records
  const leads = summaries.leads
  const quotes = summaries.quotations
  const invoices = summaries.invoices
  const payments = summaries.payments
  const outstanding = Object.entries(invoices?.balanceByStatus || {})
    .filter(([status]) => !['Draft', 'Paid', 'Cancelled'].includes(status))
    .reduce((sum, [, balance]) => sum + balance, 0)
  success(res, {
    ...(leads ? { leads: {
      total: leads.total, byStatus: leads.byStatus,
      conversionPercent: leads.total ? Math.round((leads.byStatus.Won || 0) / leads.total * 100) : 0,
    }, leadSources } : {}),
    ...(summaries.followups ? { followups: {
      due: summaries.followups.byStatus['Due today'] || 0,
      overdue: summaries.followups.byStatus.Overdue || 0,
    } } : {}),
    ...(quotes ? { quotations: {
      byStatus: quotes.byStatus,
      pipeline: ['Draft', 'Sent', 'Viewed'].reduce((sum, status) => sum + (quotes.totalByStatus[status] || 0), 0),
      openCount: ['Draft', 'Sent', 'Viewed'].reduce((sum, status) => sum + (quotes.byStatus[status] || 0), 0),
    } } : {}),
    ...(invoices || payments ? { finance: {
      invoiceTotal: invoices?.totalAmount || 0,
      paymentsReceived: payments?.amountByStatus.Recorded || 0,
      outstanding,
    } } : {}),
    ...(summaries.projects ? { projects: { total: summaries.projects.total, byStatus: summaries.projects.byStatus } } : {}),
    ...(summaries.tasks ? {
      tasks: {
        total: summaries.tasks.total,
        completed: summaries.tasks.byStatus.Completed || 0,
        inProgress: summaries.tasks.byStatus['In Progress'] || 0,
        open: summaries.tasks.total - (summaries.tasks.byStatus.Completed || 0),
      },
    } : {}),
    recent,
  })
})

export const reports = asyncRoute(async (req, res) => {
  const requestedSections = req.query.sections
  const sections = String(requestedSections || ['sales', 'financial', 'delivery']
    .filter((section) => hasPermission(req.user, `reports.view.${section}`)).join(',')).split(',').filter(Boolean)
  const result = {}
  if (sections.includes('sales')) {
    if (!hasPermission(req.user, 'reports.view.sales')) throw new AppError(403, 'FORBIDDEN', 'You cannot access sales reports.')
    const [leads, quotations] = await Promise.all([
      summarizeResource('leads', req.user),
      summarizeResource('quotations', req.user),
    ])
    result.sales = {
      leads: { total: leads.total, byStatus: leads.byStatus },
      conversionPercent: leads.total ? Math.round((leads.byStatus.Won || 0) / leads.total * 100) : 0,
      quotations: {
        byStatus: quotations.byStatus,
        pipeline: ['Draft', 'Sent', 'Viewed'].reduce((sum, status) => sum + (quotations.totalByStatus[status] || 0), 0),
      },
    }
  }
  if (sections.includes('financial')) {
    if (!hasPermission(req.user, 'reports.view.financial')) throw new AppError(403, 'FORBIDDEN', 'You cannot access financial reports.')
    const [invoices, payments] = await Promise.all([
      summarizeResource('invoices', req.user),
      summarizeResource('payments', req.user),
    ])
    result.financial = {
      invoiceTotal: invoices.totalAmount,
      paymentsReceived: payments.amountByStatus.Recorded || 0,
      outstanding: Object.entries(invoices.balanceByStatus)
        .filter(([status]) => !['Draft', 'Paid', 'Cancelled'].includes(status))
        .reduce((sum, [, balance]) => sum + balance, 0),
      openInvoices: Object.entries(invoices.byStatus)
        .filter(([status]) => !['Paid', 'Cancelled', 'Draft'].includes(status))
        .reduce((sum, [, count]) => sum + count, 0),
    }
  }
  if (sections.includes('delivery')) {
    if (!hasPermission(req.user, 'projects.view') && !hasPermission(req.user, 'projects.view.assigned')) {
      throw new AppError(403, 'FORBIDDEN', 'You cannot access delivery reports.')
    }
    const [projects, tasks] = await Promise.all([
      summarizeResource('projects', req.user),
      summarizeResource('tasks', req.user),
    ])
    result.delivery = {
      projects: { total: projects.total, byStatus: projects.byStatus },
      completionPercent: projects.total ? Math.round(projects.progress / projects.total) : 0,
      tasks: { total: tasks.total, completed: tasks.byStatus.Completed || 0 },
    }
  }
  success(res, result)
})
