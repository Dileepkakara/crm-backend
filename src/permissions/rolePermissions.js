export const ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  DIRECTOR: 'director',
  SALES_MANAGER: 'sales_manager',
  SALES_EXECUTIVE: 'sales_executive',
  ACCOUNTS: 'accounts',
  PROJECT_MANAGER: 'project_manager',
  DEVELOPER: 'developer',
  CLIENT: 'client',
})

export const PERMISSION_CATALOG = Object.freeze([
  { key: 'dashboard.view', label: 'View dashboard', group: 'Dashboard' },
  { key: 'leads.view.all', label: 'View all leads', group: 'Leads' },
  { key: 'leads.view.assigned', label: 'View assigned leads', group: 'Leads' },
  { key: 'leads.create', label: 'Create leads', group: 'Leads' },
  { key: 'leads.update', label: 'Edit leads', group: 'Leads' },
  { key: 'leads.delete', label: 'Delete leads', group: 'Leads' },
  { key: 'leads.assign', label: 'Assign leads', group: 'Leads' },
  { key: 'followups.view', label: 'View follow-ups', group: 'Follow-ups' },
  { key: 'followups.create', label: 'Create follow-ups', group: 'Follow-ups' },
  { key: 'followups.update', label: 'Edit follow-ups', group: 'Follow-ups' },
  { key: 'followups.delete', label: 'Delete follow-ups', group: 'Follow-ups' },
  { key: 'clients.view', label: 'View clients', group: 'Clients' },
  { key: 'clients.manage', label: 'Create and edit clients', group: 'Clients' },
  { key: 'quotations.view', label: 'View all quotations', group: 'Quotations' },
  { key: 'quotations.view.own', label: 'View own quotations', group: 'Quotations' },
  { key: 'quotations.create', label: 'Create quotations', group: 'Quotations' },
  { key: 'quotations.approve', label: 'Approve quotations', group: 'Quotations' },
  { key: 'agreements.view', label: 'View all work orders', group: 'Work orders' },
  { key: 'agreements.view.own', label: 'View own work orders', group: 'Work orders' },
  { key: 'agreements.approve', label: 'Approve work orders', group: 'Work orders' },
  { key: 'invoices.view', label: 'View all invoices', group: 'Invoices' },
  { key: 'invoices.view.own', label: 'View own invoices', group: 'Invoices' },
  { key: 'invoices.manage', label: 'Create and manage invoices', group: 'Invoices' },
  { key: 'payments.view', label: 'View all payments', group: 'Payments' },
  { key: 'payments.view.own', label: 'View own payments', group: 'Payments' },
  { key: 'payments.manage', label: 'Record and manage payments', group: 'Payments' },
  { key: 'projects.view', label: 'View all projects', group: 'Projects' },
  { key: 'projects.view.assigned', label: 'View assigned projects', group: 'Projects' },
  { key: 'projects.manage', label: 'Create and manage projects', group: 'Projects' },
  { key: 'tasks.view', label: 'View all tasks', group: 'Tasks' },
  { key: 'tasks.view.assigned', label: 'View assigned tasks', group: 'Tasks' },
  { key: 'tasks.create', label: 'Create tasks', group: 'Tasks' },
  { key: 'tasks.update', label: 'Edit all tasks', group: 'Tasks' },
  { key: 'tasks.update.assigned', label: 'Update assigned tasks', group: 'Tasks' },
  { key: 'tasks.delete', label: 'Delete tasks', group: 'Tasks' },
  { key: 'tasks.comment.internal', label: 'Add internal task comments', group: 'Tasks' },
  { key: 'reports.view', label: 'View reports', group: 'Reports' },
  { key: 'reports.view.sales', label: 'View sales reports', group: 'Reports' },
  { key: 'reports.view.financial', label: 'View financial reports', group: 'Reports' },
  { key: 'users.view', label: 'View users', group: 'User access' },
  { key: 'users.manage', label: 'Manage users', group: 'User access' },
  { key: 'clients.signup.manage', label: 'Review client signup requests', group: 'User access' },
  { key: 'roles.manage', label: 'Manage roles', group: 'User access' },
  { key: 'settings.manage', label: 'Manage system settings', group: 'System' },
  { key: 'notifications.view', label: 'View notifications', group: 'Notifications' },
  { key: 'clientPortal.view.own', label: 'View own client portal', group: 'Client portal' },
])

const all = PERMISSION_CATALOG.map(({ key }) => key)
export const CUSTOM_ROLE_FORBIDDEN_PERMISSIONS = Object.freeze([
  'users.manage',
  'clients.signup.manage',
  'settings.manage',
  'roles.manage',
  'clientPortal.view.own',
])

export const ROLE_DETAILS = Object.freeze({
  [ROLES.SUPER_ADMIN]: { label: 'Super Admin', description: 'Full access to CRM modules, users, roles, and system settings.' },
  [ROLES.DIRECTOR]: { label: 'Director / Management', description: 'Business-wide dashboards, reports, approvals, and performance.' },
  [ROLES.SALES_MANAGER]: { label: 'Sales Manager', description: 'Sales team leads, assignments, follow-ups, quotations, and reports.' },
  [ROLES.SALES_EXECUTIVE]: { label: 'Sales Executive', description: 'Assigned leads, follow-ups, client records, and own quotations.' },
  [ROLES.ACCOUNTS]: { label: 'Accounts Team', description: 'Invoices, payments, billing clients, and accounting reports.' },
  [ROLES.PROJECT_MANAGER]: { label: 'Project Manager', description: 'Assigned projects, delivery tasks, milestones, and client coordination.' },
  [ROLES.DEVELOPER]: { label: 'Developer / Designer', description: 'Assigned projects and tasks, with task updates and internal comments.' },
  [ROLES.CLIENT]: { label: 'Client', description: 'Own client portal, projects, quotations, agreements, and invoices.' },
})

export function isBuiltInRole(role) {
  return Object.hasOwn(ROLE_PERMISSIONS, role)
}

export function isForbiddenCustomPermission(permission) {
  return CUSTOM_ROLE_FORBIDDEN_PERMISSIONS.includes(permission)
}

export const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.SUPER_ADMIN]: all,
  [ROLES.DIRECTOR]: [
    'dashboard.view', 'leads.view.all', 'followups.view', 'clients.view', 'quotations.view', 'quotations.approve',
    'agreements.view', 'agreements.approve', 'invoices.view', 'payments.view', 'projects.view', 'tasks.view',
    'reports.view', 'reports.view.sales', 'reports.view.financial', 'users.view', 'notifications.view',
  ],
  [ROLES.SALES_MANAGER]: [
    'dashboard.view', 'leads.view.all', 'leads.create', 'leads.update', 'leads.assign', 'followups.view', 'followups.create',
    'followups.update', 'clients.view', 'quotations.view', 'quotations.create', 'quotations.approve',
    'reports.view', 'reports.view.sales', 'notifications.view',
  ],
  [ROLES.SALES_EXECUTIVE]: [
    'dashboard.view', 'leads.view.assigned', 'leads.create', 'leads.update', 'followups.view', 'followups.create',
    'followups.update', 'clients.view', 'quotations.view.own', 'quotations.create', 'notifications.view',
  ],
  [ROLES.ACCOUNTS]: [
    'dashboard.view', 'clients.view', 'invoices.view', 'invoices.manage', 'payments.view', 'payments.manage',
    'reports.view', 'reports.view.financial', 'notifications.view',
  ],
  [ROLES.PROJECT_MANAGER]: [
    'dashboard.view', 'clients.view', 'projects.view.assigned', 'projects.manage', 'tasks.view.assigned', 'tasks.create',
    'tasks.update', 'tasks.delete', 'reports.view', 'notifications.view',
  ],
  [ROLES.DEVELOPER]: [
    'dashboard.view', 'projects.view.assigned', 'tasks.view.assigned', 'tasks.update.assigned',
    'tasks.comment.internal', 'notifications.view',
  ],
  [ROLES.CLIENT]: [
    'clientPortal.view.own', 'quotations.view.own', 'agreements.view.own', 'invoices.view.own',
    'payments.view.own', 'projects.view.assigned', 'notifications.view',
  ],
})
