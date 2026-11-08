import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity } from "effect/http-api"

// A missing or wrong key; says nothing more, so a caller learns nothing about the other key.
export class Unauthorized extends Schema.TaggedError<Unauthorized, { readonly brand: unique symbol }>()("Unauthorized", {}, { httpApiStatus: 401 }) {}

// Another device holds the one slot; `push device reset` empties it.
export class SlotTaken extends Schema.TaggedError<SlotTaken, { readonly brand: unique symbol }>()("SlotTaken", { message: Schema.String }, { httpApiStatus: 409 }) {}

// The page sent something that is not a subscription from a known push service.
export class InvalidSubscription extends Schema.TaggedError<InvalidSubscription, { readonly brand: unique symbol }>()("InvalidSubscription", { message: Schema.String }, { httpApiStatus: 400 }) {}

// No device has subscribed yet, or the last one was reset.
export class NoDevice extends Schema.TaggedError<NoDevice, { readonly brand: unique symbol }>()("NoDevice", { message: Schema.String }, { httpApiStatus: 409 }) {}

// The push service says the subscription no longer exists; the Worker emptied the slot, so the device must subscribe again.
export class DeviceGone extends Schema.TaggedError<DeviceGone, { readonly brand: unique symbol }>()("DeviceGone", { message: Schema.String }, { httpApiStatus: 410 }) {}

// The notification does not fit in one push once encrypted.
export class MessageTooLarge extends Schema.TaggedError<MessageTooLarge, { readonly brand: unique symbol }>()("MessageTooLarge", { message: Schema.String }, { httpApiStatus: 413 }) {}

// The push service refused the push, or could not be reached.
export class PushServiceError extends Schema.TaggedError<PushServiceError, { readonly brand: unique symbol }>()("PushServiceError", { message: Schema.String }, { httpApiStatus: 502 }) {}

// Pushover refused the notification, or could not be reached.
export class PushoverError extends Schema.TaggedError<PushoverError, { readonly brand: unique symbol }>()("PushoverError", { message: Schema.String }, { httpApiStatus: 502 }) {}

// PUSH_API_KEY: sends notifications, nothing else.
export class Sender extends HttpApiMiddleware.Service<Sender>()("push/Sender", { security: { bearer: HttpApiSecurity.bearer }, error: Unauthorized }) {}

// PUSH_ADMIN_KEY: sees and empties the device slot.
export class Admin extends HttpApiMiddleware.Service<Admin>()("push/Admin", { security: { bearer: HttpApiSecurity.bearer }, error: Unauthorized }) {}

const base64UrlOfLength = (length: number, what: string) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^[A-Za-z0-9_-]{${length}}$`, "u"), { expected: `${what}, ${length} base64url characters` }))

// What PushSubscription.toJSON() gives the page; expirationTime is ignored, Safari never sets it.
export const Subscription = Schema.Struct({
  // Must be https on a known push service; the Worker checks.
  endpoint: Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/u, { expected: "an http(s) URL" })),
  keys: Schema.Struct({
    // An uncompressed P-256 point: 65 bytes.
    p256dh: base64UrlOfLength(87, "an uncompressed P-256 public key"),
    // 16 bytes.
    auth: base64UrlOfLength(22, "a 16-byte authentication secret"),
  }),
})

export type Subscription = typeof Subscription.Type

// Opened when the notification is tapped.
const TapUrl = Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/u, { expected: "an http(s) URL" }))

export const Notification = Schema.Struct({
  message: Schema.NonEmptyString,
  title: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(TapUrl),
})

export type Notification = typeof Notification.Type

export const PushoverNotification = Schema.Struct({ message: Schema.NonEmptyString, title: Schema.optionalKey(Schema.String) })

// The device in the slot, without its keys: which push service it is on, and since when (epoch milliseconds).
export const Device = Schema.Struct({ service: Schema.String, subscribedAt: Schema.Finite })

const HealthGroup = HttpApiGroup.make("health").add(
  // `version`: the commit the Worker was deployed from.
  HttpApiEndpoint.get("check", "/health", { success: Schema.Struct({ status: Schema.Literal("ok"), version: Schema.String }) })
)

// What the page calls, without a key: the first device to subscribe takes the slot.
const PageGroup = HttpApiGroup.make("page").add(
  HttpApiEndpoint.get("vapidPublicKey", "/vapid-public-key", { success: Schema.Struct({ publicKey: Schema.String }) }),
  HttpApiEndpoint.post("subscribe", "/subscription", { payload: Subscription, success: Schema.Struct({ status: Schema.Literal("subscribed") }), error: [SlotTaken, InvalidSubscription] })
)

const DeviceGroup = HttpApiGroup.make("device")
  .add(
    HttpApiEndpoint.get("status", "/subscription", { success: Schema.Struct({ device: Schema.NullOr(Device) }) }),
    HttpApiEndpoint.delete("reset", "/subscription", { success: Schema.Struct({ removed: Schema.Boolean }) })
  )
  .middleware(Admin)

const SendGroup = HttpApiGroup.make("send")
  .add(
    // Web Push to the device in the slot: what consumers call.
    HttpApiEndpoint.post("notify", "/notify", { payload: Notification, error: [NoDevice, DeviceGone, MessageTooLarge, PushServiceError] }),
    // Pushover, kept while consumers move to /notify.
    HttpApiEndpoint.post("pushover", "/pushover", { payload: PushoverNotification, error: PushoverError })
  )
  .middleware(Sender)

export class PushApi extends HttpApi.make("push").add(HealthGroup).add(PageGroup).add(DeviceGroup).add(SendGroup) {}
