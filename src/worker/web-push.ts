// One push to the device in the slot: the message encrypted for it, signed with the VAPID key, sent to its push service.

import { Clock, Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { MessageTooLarge, PushServiceError } from "../../client/api.ts"
import type { PushMessage } from "../shared/message.ts"
import { fromBase64Url } from "../webpush/base64url.ts"
import { encrypt, newSender } from "../webpush/encryption.ts"
import { type VapidKeys, vapidAuthorization } from "../webpush/vapid.ts"
import type { StoredSubscription } from "./store.ts"

// How long the push service keeps a push for a device that is offline: a day.
const TIME_TO_LIVE_SECONDS = 24 * 60 * 60

export interface Vapid {
  readonly keys: VapidKeys
  // Who the push service may contact about our pushes: the Worker's URL.
  readonly subject: string
}

export type PushOutcome = "delivered" | "gone"

type Verdict = PushOutcome | "tooLarge" | "refused"

// RFC 8030: 201 accepted; 404 and 410, the subscription is gone for good; 413, the body is too large.
export const verdictOf = (status: number): Verdict => {
  if (status >= 200 && status < 300) {
    return "delivered"
  }
  if (status === 404 || status === 410) {
    return "gone"
  }
  if (status === 413) {
    return "tooLarge"
  }
  return "refused"
}

const encodeMessage = (message: PushMessage) => new TextEncoder().encode(JSON.stringify(message))

const encryptFor = Effect.fnUntraced(function* (subscription: StoredSubscription, message: PushMessage) {
  const recipient = { p256dh: fromBase64Url(subscription.p256dh), auth: fromBase64Url(subscription.auth) }
  return yield* encrypt(recipient, encodeMessage(message), yield* newSender).pipe(Effect.mapError((error) => new MessageTooLarge({ message: error.message })))
})

const pushRequest = (endpoint: string, body: Uint8Array, authorization: string) =>
  HttpClientRequest.post(endpoint).pipe(
    HttpClientRequest.setHeaders({ authorization, "content-encoding": "aes128gcm", ttl: String(TIME_TO_LIVE_SECONDS), urgency: "high" }),
    HttpClientRequest.bodyUint8Array(body, "application/octet-stream")
  )

const unreachable = (error: { readonly message: string }) => new PushServiceError({ message: `could not reach the push service: ${error.message}` })

const refused = (status: number, text: string) => new PushServiceError({ message: `the push service answered ${status}: ${text.slice(0, 300)}` })

const tooLarge = new MessageTooLarge({ message: "the push service refused the notification as too large" })

export const sendPush = Effect.fnUntraced(function* (subscription: StoredSubscription, message: PushMessage, vapid: Vapid) {
  const body = yield* encryptFor(subscription, message)
  const authorization = yield* vapidAuthorization(vapid.keys, subscription.endpoint, vapid.subject, yield* Clock.currentTimeMillis)
  const response = yield* HttpClient.execute(pushRequest(subscription.endpoint, body, authorization)).pipe(Effect.mapError(unreachable))
  const verdict = verdictOf(response.status)
  if (verdict === "tooLarge") {
    return yield* tooLarge
  }
  if (verdict === "refused") {
    return yield* refused(response.status, yield* response.text.pipe(Effect.orElseSucceed(() => "")))
  }
  return verdict satisfies PushOutcome
})
