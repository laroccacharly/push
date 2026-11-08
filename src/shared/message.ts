// What each push carries, encrypted: the Worker writes it, the service worker shows it.

import type { Notification } from "../../client/api.ts"

export interface PushMessage {
  readonly title: string
  readonly body: string
  // Opened when the notification is tapped; the page otherwise.
  readonly url?: string
}

const DEFAULT_TITLE = "push"

export const pushMessageOf = (notification: Notification): PushMessage => {
  const message = { title: notification.title ?? DEFAULT_TITLE, body: notification.message }
  if (notification.url === undefined) {
    return message
  }
  return { ...message, url: notification.url }
}
