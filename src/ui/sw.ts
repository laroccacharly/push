// The service worker: shows each push, and opens its URL when tapped. Safari revokes the subscription of a page
// whose pushes show nothing, so every push shows a notification.

import type { PushMessage } from "../shared/message.ts"

declare const self: ServiceWorkerGlobalScope

// Authenticated by AES-GCM, so only the Worker could have written it; JSON from anyone else never reaches here.
const messageOf = (event: PushEvent): PushMessage => {
  const fallback = { title: "push", body: "A notification arrived without a message" }
  if (event.data === null) {
    return fallback
  }
  return { ...fallback, ...(event.data.json() as Partial<PushMessage>) }
}

self.addEventListener("push", (event) => {
  const message = messageOf(event)
  event.waitUntil(self.registration.showNotification(message.title, { body: message.body, data: { url: message.url ?? "/" }, icon: "/icon-192.png" }))
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const { url } = event.notification.data as { readonly url: string }
  event.waitUntil(self.clients.openWindow(url))
})
