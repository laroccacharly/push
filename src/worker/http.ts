import { Clock, Config, Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpServerError, type HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as Credentials from "effect-lib/credentials"
import * as Pushover from "effect-lib/push"
import { DeviceGone, InvalidSubscription, NoDevice, PushApi, PushoverError, SlotTaken, type Subscription } from "../../client/api.ts"
import { pushMessageOf } from "../shared/message.ts"
import { fromBase64Url, toBase64Url } from "../webpush/base64url.ts"
import { importRecipientKey } from "../webpush/encryption.ts"
import { importVapidKeys } from "../webpush/vapid.ts"
import { authLayer } from "./auth.ts"
import { isPushService } from "./push-services.ts"
import { Store, type StoredSubscription } from "./store.ts"
import { sendPush, type Vapid } from "./web-push.ts"

// VAPID_PRIVATE_KEY was checked at deploy, so a bad one here is a defect.
const vapid: Effect.Effect<Vapid, Config.ConfigError> = Effect.gen(function* () {
  const keys = yield* importVapidKeys(yield* Config.String("VAPID_PRIVATE_KEY")).pipe(Effect.orDie)
  return { keys, subject: yield* Config.String("PUSH_URL") }
})

// A fake push service, in the tests.
const extraPushServiceOrigins = Config.String("PUSH_SERVICE_ORIGIN").pipe(Config.option, Config.map(Option.toArray))

const healthHandlers = HttpApiBuilder.group(PushApi, "health", (handlers) =>
  Effect.map(Config.String("DEPLOY_VERSION"), (version) => handlers.handle("check", () => Effect.succeed({ status: "ok" as const, version })))
)

const invalid = (message: string) => new InvalidSubscription({ message })

const checkSubscription = Effect.fnUntraced(function* (subscription: Subscription, extraOrigins: ReadonlyArray<string>) {
  if (!isPushService(subscription.endpoint, extraOrigins)) {
    return yield* invalid("the endpoint is not a known push service")
  }
  yield* importRecipientKey(fromBase64Url(subscription.keys.p256dh)).pipe(Effect.mapError(invalid))
})

const slotTaken = new SlotTaken({ message: "another device holds the slot; run `push device reset`, then subscribe again" })

const pageHandlers = HttpApiBuilder.group(PushApi, "page", (handlers) =>
  Effect.gen(function* () {
    const store = yield* Store
    const extraOrigins = yield* extraPushServiceOrigins
    const subscribe = Effect.fnUntraced(function* (subscription: Subscription) {
      yield* checkSubscription(subscription, extraOrigins)
      if ((yield* store.claim(subscription, yield* Clock.currentTimeMillis)) === "taken") {
        return yield* slotTaken
      }
      yield* Effect.logInfo(`a device on ${new URL(subscription.endpoint).host} subscribed`)
      return { status: "subscribed" as const }
    })
    return handlers
      .handle("vapidPublicKey", () => Effect.map(vapid, ({ keys }) => ({ publicKey: toBase64Url(keys.publicKey) })).pipe(Effect.orDie))
      .handle("subscribe", ({ payload }) => subscribe(payload))
  })
)

const deviceOf = (stored: StoredSubscription) => ({ service: new URL(stored.endpoint).host, subscribedAt: stored.created_at })

const deviceHandlers = HttpApiBuilder.group(PushApi, "device", (handlers) =>
  Effect.gen(function* () {
    const store = yield* Store
    return handlers
      .handle("status", () => Effect.map(store.current, (stored) => ({ device: Option.getOrNull(Option.map(stored, deviceOf)) })))
      .handle("reset", () => Effect.map(store.reset, (removed) => ({ removed })))
  })
)

const noDevice = new NoDevice({ message: "no device is subscribed: open PUSH_URL on the phone, add it to the Home Screen, and enable notifications there" })

const deviceGone = new DeviceGone({ message: "the push service no longer knows the device, so the slot is empty again: enable notifications on the phone again" })

const toPushoverError = (error: { readonly message: string }) => new PushoverError({ message: error.message })

const sendHandlers = HttpApiBuilder.group(PushApi, "send", (handlers) =>
  Effect.gen(function* () {
    const store = yield* Store
    const pushover = yield* Pushover.Push
    const http = yield* HttpClient.HttpClient
    const notify = Effect.fnUntraced(function* (notification: Parameters<typeof pushMessageOf>[0]) {
      yield* Effect.logInfo("POST /notify")
      const subscription = yield* Effect.flatMap(store.current, Option.match({ onNone: () => Effect.fail(noDevice), onSome: Effect.succeed }))
      const outcome = yield* sendPush(subscription, pushMessageOf(notification), yield* Effect.orDie(vapid)).pipe(Effect.provideService(HttpClient.HttpClient, http))
      if (outcome === "gone") {
        yield* store.forget(subscription.endpoint)
        return yield* deviceGone
      }
    })
    return handlers
      .handle("notify", ({ payload }) => notify(payload))
      .handle("pushover", ({ payload }) =>
        Effect.logInfo("POST /pushover").pipe(Effect.andThen(pushover.notify(payload.message, { title: payload.title })), Effect.mapError(toPushoverError))
      )
  })
)

// Pushover with the Worker's credentials, from its env only; PUSHOVER_ORIGIN points it at a fake, in the tests.
const pushoverLayer = Layer.unwrap(
  Effect.map(Config.String("PUSHOVER_ORIGIN").pipe(Config.withDefault(Pushover.ORIGIN)), (origin) => Pushover.layer({ origin }))
).pipe(Layer.provide(Credentials.envOnlyLayer))

// PushApi's routes; need the Store, and in the Config: PUSH_URL, DEPLOY_VERSION, VAPID_PRIVATE_KEY, PUSH_API_KEY, PUSH_ADMIN_KEY,
// PUSH_APP_TOKEN and PUSH_USER_KEY.
export const routes = HttpApiBuilder.layer(PushApi).pipe(
  Layer.provide([healthHandlers, pageHandlers, deviceHandlers, sendHandlers]),
  Layer.provide([authLayer, pushoverLayer]),
  Layer.provide(FetchHttpClient.layer)
)

// Failures the API doesn't encode itself, such as an unknown route, as responses.
export const respondToFailures = <E, R>(handle: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.catchCause(handle, (cause) => Effect.map(HttpServerError.causeResponse(cause), ([response]) => response))
