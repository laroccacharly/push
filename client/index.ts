import { Config, Context, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api"
import { DeviceGone, MessageTooLarge, NoDevice, PushApi, PushoverError, PushServiceError, Sender, Unauthorized } from "./api.ts"
import { builtInUrl } from "./url.ts"

export { DeviceGone, MessageTooLarge, NoDevice, PushoverError, PushServiceError, Unauthorized }

export interface NotifyOptions {
  // Shown above the message; "push" when omitted.
  readonly title?: string
  // Opened when the notification is tapped.
  readonly url?: string
}

export interface PushoverOptions {
  // Shown above the message; Pushover falls back to the application name.
  readonly title?: string
}

// The Worker could not be reached, or answered something this client does not understand.
export type NotifyError = NoDevice | DeviceGone | MessageTooLarge | PushServiceError | Unauthorized

export class PushClient extends Context.Service<
  PushClient,
  {
    // Sends a notification to the subscribed phone, with Web Push.
    readonly notify: (message: string, options?: NotifyOptions) => Effect.Effect<void, NotifyError>
    // Sends it through Pushover instead, while consumers move to notify.
    readonly pushover: (message: string, options?: PushoverOptions) => Effect.Effect<void, PushoverError | PushServiceError | Unauthorized>
  }
>()("push/PushClient") {
  // What the options leave out comes from the ConfigProvider (the environment in Bun, the env in a Worker): PUSH_API_KEY,
  // and PUSH_URL, else the URL built into the client.
  static readonly layer = (options?: PushClientOptions): Layer.Layer<PushClient, PushServiceError> =>
    Layer.effect(PushClient, make(options)).pipe(Layer.provide(FetchHttpClient.layer))
}

export interface PushClientOptions {
  // The Worker's origin, e.g. https://push.example.com. Only to override the one the client was built for.
  readonly url?: string
  readonly apiKey?: string | Redacted.Redacted<string>
}

const toServiceError = (error: { readonly message: string }) => new PushServiceError({ message: error.message })

const failWithServiceError = (error: { readonly message: string }) => Effect.fail(toServiceError(error))

const noUrl = new PushServiceError({ message: "No push URL: this client was built without one; pass `url` or set PUSH_URL" })

// `url`, else PUSH_URL, else the built-in URL.
const resolveUrl = (url: Option.Option<string>) =>
  Option.match(url, {
    onNone: () =>
      Config.option(Config.String("PUSH_URL")).pipe(
        Effect.mapError(toServiceError),
        Effect.map(Option.orElse(() => builtInUrl)),
        Effect.flatMap(Option.match({ onNone: () => Effect.fail(noUrl), onSome: Effect.succeed }))
      ),
    onSome: Effect.succeed,
  })

const asRedacted = (apiKey: string | Redacted.Redacted<string>) => {
  if (Redacted.isRedacted(apiKey)) {
    return apiKey
  }
  return Redacted.make(apiKey)
}

// `apiKey`, else PUSH_API_KEY.
const resolveApiKey = (apiKey: Option.Option<string | Redacted.Redacted<string>>) =>
  Option.match(apiKey, {
    onNone: () => Config.Redacted("PUSH_API_KEY").pipe(Effect.mapError(toServiceError)),
    onSome: (explicit) => Effect.succeed(asRedacted(explicit)),
  })

export const senderClient = (apiKey: Redacted.Redacted<string>) => HttpApiMiddleware.layerClient(Sender, ({ next, request }) => next(HttpClientRequest.bearerToken(request, apiKey)))

export const make = Effect.fnUntraced(function* make(options: PushClientOptions = {}) {
  const baseUrl = yield* resolveUrl(Option.fromUndefinedOr(options.url))
  const apiKey = yield* resolveApiKey(Option.fromUndefinedOr(options.apiKey))
  const client = yield* HttpApiClient.make(PushApi, { baseUrl }).pipe(Effect.provide(senderClient(apiKey)))

  const notify = (message: string, notifyOptions: NotifyOptions = {}) =>
    client.send.notify({ payload: { message, ...notifyOptions } }).pipe(
      Effect.catchTags({ HttpClientError: failWithServiceError, SchemaError: failWithServiceError }),
      Effect.withSpan("PushClient.notify")
    )

  const pushover = (message: string, pushoverOptions: PushoverOptions = {}) =>
    client.send.pushover({ payload: { message, ...pushoverOptions } }).pipe(
      Effect.catchTags({ HttpClientError: failWithServiceError, SchemaError: failWithServiceError }),
      Effect.withSpan("PushClient.pushover")
    )

  return PushClient.of({ notify, pushover })
})
