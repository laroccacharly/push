// The page on the phone: once added to the Home Screen, it subscribes the phone and hands the subscription to the Worker,
// which keeps it in its one slot.

import type { Subscription } from "../../client/api.ts"

type Tone = "info" | "ok" | "warn"

const statusLine = document.querySelector<HTMLParagraphElement>("#status")
const enableButton = document.querySelector<HTMLButtonElement>("#enable")

const show = (text: string, tone: Tone = "info") => {
  if (statusLine === null) {
    return
  }
  statusLine.innerHTML = text
  statusLine.dataset.tone = tone
}

const showButton = (visible: boolean) => {
  if (enableButton !== null) {
    enableButton.hidden = !visible
    enableButton.disabled = false
  }
}

const isStandalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as { readonly standalone?: boolean }).standalone === true

const canPush = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window

// Through atob: Uint8Array.fromBase64 only arrived in Safari 18.2, and Web Push works from iOS 16.4.
const fromBase64Url = (text: string) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0))

const vapidPublicKey = async () => {
  const { publicKey } = (await (await fetch("/vapid-public-key")).json()) as { readonly publicKey: string }
  return fromBase64Url(publicKey)
}

const subscriptionOf = (subscription: PushSubscription) => subscription.toJSON() as Subscription

// Hands the subscription to the Worker; 409 means another device holds the slot.
const claimSlot = async (subscription: PushSubscription) => {
  const response = await fetch("/subscription", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(subscriptionOf(subscription)) })
  if (response.ok) {
    return show("Notifications are on for this device.", "ok")
  }
  if (response.status === 409) {
    return show("Another device holds the slot. Run <code>push device reset</code> on your computer, then tap Enable again.", "warn")
  }
  const { message } = (await response.json()) as { readonly message?: string }
  show(`The Worker refused this subscription: ${message ?? response.status}`, "warn")
}

const subscribe = async (registration: ServiceWorkerRegistration) => {
  const existing = await registration.pushManager.getSubscription()
  if (existing !== null) {
    return existing
  }
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: await vapidPublicKey() })
}

const enable = async () => {
  if (enableButton !== null) {
    enableButton.disabled = true
  }
  show("Asking for permission…")
  if ((await Notification.requestPermission()) !== "granted") {
    showButton(false)
    return show("Notifications are blocked. Allow them in Settings → Notifications → push.", "warn")
  }
  await claimSlot(await subscribe(await navigator.serviceWorker.ready))
  showButton(true)
}

// A device that already subscribed hands its subscription over again, which refreshes its keys in the slot.
const resume = async () => {
  const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
  if (subscription === null) {
    show("Tap below, then Allow, to get your notifications on this device.")
    return showButton(true)
  }
  await claimSlot(subscription)
  showButton(true)
}

const start = async () => {
  if (!isStandalone()) {
    return show("Add this page to your Home Screen: tap Share, then <b>Add to Home Screen</b>, and open push from there.")
  }
  if (!canPush()) {
    return show("This browser cannot receive Web Push. It needs iOS 16.4 or later.", "warn")
  }
  await navigator.serviceWorker.register("/sw.js", { scope: "/" })
  enableButton?.addEventListener("click", () => {
    enable().catch((error: Error) => {
      show(`Could not enable notifications: ${String(error)}`, "warn")
      showButton(true)
    })
  })
  if (Notification.permission === "granted") {
    return resume()
  }
  show("Tap below, then Allow, to get your notifications on this device.")
  showButton(true)
}

start().catch((error: Error) => show(`Something went wrong: ${String(error)}`, "warn"))
