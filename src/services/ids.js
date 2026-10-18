import { Counter } from '../models/index.js'

const prefixes = {
  leads: 'LD',
  followups: 'FU',
  clients: 'CL',
  quotations: 'QT',
  agreements: 'WO',
  invoices: 'INV',
  payments: 'PAY',
  projects: 'PR',
  tasks: 'TS',
  notifications: 'NT',
}

export async function nextId(resource, session) {
  const prefix = prefixes[resource]
  if (!prefix) throw new Error(`No ID prefix configured for resource ${resource}.`)
  const counter = await Counter.findOneAndUpdate(
    { key: resource },
    { $inc: { value: 1 } },
    { new: true, upsert: true, session },
  )
  const year = new Date().getFullYear()
  return `${prefix}${['quotations', 'agreements', 'invoices', 'payments'].includes(resource) ? `-${year}` : ''}-${String(counter.value).padStart(6, '0')}`
}
