import * as Cloudflare from "@alchemy.run/cloudflare"
import { D1Client } from "@effect/sql-d1"
import { ALCHEMY_DEV } from "alchemy"
import { Config, Effect, Layer, Option, Redacted } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import * as Deploy from "effect-lib/deploy"
import { importVapidKeys } from "../webpush/vapid.ts"
import { respondToFailures, routes } from "./http.ts"
import { layer as storeLayer } from "./store.ts"

// Where the Worker is reached: PUSH_URL, required on deploy; under `alchemy dev`, the dev server.
const pushUrlOf = (devPort: number) =>
  Effect.gen(function* () {
    if (yield* ALCHEMY_DEV) {
      return `http://localhost:${devPort}`
    }
    return yield* Config.String("PUSH_URL")
  })

// A host other than workers.dev, which Cloudflare serves without one, is attached as a custom domain.
const domainOf = (pushUrl: string): { readonly domain?: string } => {
  const { hostname } = new URL(pushUrl)
  if (hostname === "localhost" || hostname.endsWith(".workers.dev")) {
    return {}
  }
  return { domain: hostname }
}

// `{ [name]: value }` when the variable is set, else nothing: a fake push service and a fake Pushover, for a local check.
const optionalEnv = (name: string) =>
  Config.option(Config.String(name)).pipe(Config.map(Option.match({ onNone: () => ({}), onSome: (value) => ({ [name]: value }) })))

// Imported once here, so a bad key fails the deploy rather than every push.
const vapidPrivateKey = Effect.gen(function* () {
  const key = yield* Config.Redacted("VAPID_PRIVATE_KEY")
  yield* importVapidKeys(Redacted.value(key)).pipe(Effect.orDie)
  return key
})

export default class Worker extends Cloudflare.Worker<Worker>()(
  "Worker",
  Effect.gen(function* () {
    const devPort = yield* Config.Int("DEV_PORT").pipe(Config.withDefault(1350))
    const pushUrl = yield* pushUrlOf(devPort)
    return {
      name: "push",
      main: import.meta.url,
      compatibility: {
        // Must not be newer than what Alchemy's bundled workerd supports.
        date: "2026-09-01",
      },
      dev: {
        port: devPort,
        strictPort: true,
      },
      ...domainOf(pushUrl),
      // `bun run build`: the page, its service worker and push-client's tarball, served before the Worker runs.
      assets: "./dist/assets",
      env: {
        VAPID_PRIVATE_KEY: yield* vapidPrivateKey,
        PUSH_API_KEY: yield* Config.Redacted("PUSH_API_KEY"),
        PUSH_ADMIN_KEY: yield* Config.Redacted("PUSH_ADMIN_KEY"),
        PUSH_APP_TOKEN: yield* Config.Redacted("PUSH_APP_TOKEN"),
        PUSH_USER_KEY: yield* Config.Redacted("PUSH_USER_KEY"),
        // The Worker reads its props again when it runs, so it needs the URL it was deployed for; also the VAPID subject.
        PUSH_URL: pushUrl,
        // The commit deployed, read again when the Worker runs; this checkout's under `alchemy dev`.
        DEPLOY_VERSION: yield* Deploy.workerVersion(import.meta.dir),
        ...(yield* optionalEnv("PUSH_SERVICE_ORIGIN")),
        ...(yield* optionalEnv("PUSHOVER_ORIGIN")),
      },
    }
  }),
  Effect.gen(function* () {
    const database = yield* Cloudflare.D1.Database("Push", { name: "push", migrations: "./migrations" })
    const db = yield* Cloudflare.D1.QueryDatabase(database)
    // Built for each request: the bindings are only reachable inside one.
    const handleFetch = Effect.gen(function* () {
      const sql = D1Client.layer({ db: yield* db.raw })
      const handle = yield* HttpRouter.toHttpEffect(routes.pipe(Layer.provide(storeLayer), Layer.provide([sql, HttpServer.layerServices])))
      return yield* respondToFailures(handle)
    })
    return { fetch: handleFetch.pipe(Effect.orDie) }
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding))
) {}
