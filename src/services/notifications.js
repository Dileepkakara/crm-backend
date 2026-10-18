import { Notification } from '../models/index.js'

export async function createNotification({ recipientId, title, body, category, href, eventType }, session) {
  if (!recipientId) return null
  const notification = {
    id: `NT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    recipientId,
    title,
    body,
    category,
    href,
    eventType,
  }
  return session
    ? Notification.create([notification], { session }).then(([created]) => created)
    : Notification.create(notification)
}
