// The Worker's HttpApi in Bun, over SQLite in memory with the tables from ./migrations, behind a real port. A fake push
// service stands in for Apple's and decrypts each push as the phone would (./user-agent.ts); a fake Pushover beside it.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api"
import { SqlClient } from "effect/sql"
import { Admin, PushApi, Sender } from "../client/api.ts"
import { make as makePushClient } from "../client/index.ts"
import { toBase64Url } from "../src/webpush/base64url.ts"
import { routes } from "../src/worker/http.ts"
import { layer as storeLayer } from "../src/worker/store.ts"
import { readVapidHeader, userAgent, type UserAgent } from "./user-agent.ts"

const projectRoot = join(import.meta.dir, "..")
const API_KEY = "test-push-api-key"
const ADMIN_KEY = "test-push-admin-key"
const PUSH_URL = "https://push.example.com"
const VERSION = "test-version"

const migrationStatements = readdirSync(join(projectRoot, "migrations"))
  .toSorted()
  .flatMap((name) => readFileSync(join(projectRoot, "migrations", name), "utf8").split(/;\n/u))
  .map((statement) => statement.trim())
  .filter((statement) => statement !== "")

const migratedSqlite = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of migrationStatements) {
      yield* sql.unsafe(statement)
    }
  })
).pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))

const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
const VAPID_PRIVATE_KEY = JSON.stringify(await crypto.subtle.exportKey("jwk", vapidPair.privateKey))
const VAPID_PUBLIC_KEY = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", vapidPair.publicKey)))

interface ReceivedPush {
  readonly path: string
  readonly headers: Headers
  readonly body: Uint8Array
}

// Answers like Apple's push service: 201, or `answer` when set; keeps what it gets.
const fakePushService = { received: [] as Array<ReceivedPush>, answer: 201 }
const pushService = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    fakePushService.received.push({ path: new URL(request.url).pathname, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) })
    if (fakePushService.answer === 201) {
      return new Response(null, { status: 201 })
    }
    return new Response("nope", { status: fakePushService.answer })
  },
})

// Answers like Pushover, and keeps what it gets; `rejecting` makes it refuse.
const fakePushover = { received: [] as Array<Record<string, string>>, rejecting: false }
const pushover = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  routes: {
    "/1/messages.json": {
      POST: async (request) => {
        fakePushover.received.push(await request.json())
        if (fakePushover.rejecting) {
          return Response.json({ status: 0, errors: ["application token is invalid"] }, { status: 400 })
        }
        return Response.json({ status: 1, request: "r" })
      },
    },
  },
})

// The Worker's env, as the deploy sets it.
const workerEnv = {
  VAPID_PRIVATE_KEY,
  PUSH_API_KEY: API_KEY,
  PUSH_ADMIN_KEY: ADMIN_KEY,
  PUSH_APP_TOKEN: "test-pushover-token",
  PUSH_USER_KEY: "test-pushover-user",
  PUSHOVER_ORIGIN: pushover.url.origin,
  PUSH_SERVICE_ORIGIN: pushService.url.origin,
  PUSH_URL,
  DEPLOY_VERSION: VERSION,
}

let workerUrl = ""
let stopWorker = async () => {}

// A fresh database for each test.
beforeEach(() => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    routes.pipe(Layer.provide(storeLayer), Layer.provide([migratedSqlite, HttpServer.layerServices]), Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(workerEnv)))),
    { disableLogger: true }
  )
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => handler(request) })
  workerUrl = server.url.origin
  stopWorker = async () => {
    await server.stop(true)
    await dispose()
  }
  fakePushService.received = []
  fakePushService.answer = 201
  fakePushover.received = []
  fakePushover.rejecting = false
})

afterEach(() => stopWorker())

afterAll(async () => {
  await pushService.stop(true)
  await pushover.stop(true)
})

const bearer = (token: Option.Option<string>) => (request: HttpClientRequest.HttpClientRequest) =>
  Option.match(token, { onNone: () => request, onSome: (key) => HttpClientRequest.bearerToken(request, Redacted.make(key)) })

// The typed client, sending `sender` to the send routes and `admin` to the device routes.
const clientWith = (keys: { readonly sender?: string; readonly admin?: string } = {}) =>
  HttpApiClient.make(PushApi, { baseUrl: workerUrl }).pipe(
    Effect.provide([
      HttpApiMiddleware.layerClient(Sender, ({ next, request }) => next(bearer(Option.fromUndefinedOr(keys.sender))(request))),
      HttpApiMiddleware.layerClient(Admin, ({ next, request }) => next(bearer(Option.fromUndefinedOr(keys.admin))(request))),
      FetchHttpClient.layer,
    ])
  )

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

// The tag of the error `effect` fails with, or `ok`.
const outcome = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) => run(effect.pipe(Effect.as("ok"), Effect.catch((error) => Effect.succeed(error._tag))))

const subscriptionOf = (agent: UserAgent, path = "/push/device-1") => ({
  endpoint: `${pushService.url.origin}${path}`,
  keys: { p256dh: agent.p256dh.toString("base64url"), auth: agent.auth.toString("base64url") },
})

const subscribe = (subscription: ReturnType<typeof subscriptionOf>) => outcome(Effect.flatMap(clientWith(), (client) => client.page.subscribe({ payload: subscription })))

const notify = (payload: { readonly message: string; readonly title?: string; readonly url?: string }, sender = API_KEY) =>
  outcome(Effect.flatMap(clientWith({ sender }), (client) => client.send.notify({ payload })))

const deviceStatus = () => run(Effect.flatMap(clientWith({ admin: ADMIN_KEY }), (client) => client.device.status()))

const lastPushFor = (agent: UserAgent) => {
  const push = fakePushService.received.at(-1)
  if (push === undefined) {
    throw new Error("no push reached the push service")
  }
  return { ...push, message: JSON.parse(agent.decrypt(push.body).plaintext.toString("utf8")) }
}

test("/health answers the deployed version", async () => {
  expect(await run(Effect.flatMap(clientWith(), (client) => client.health.check()))).toEqual({ status: "ok", version: VERSION })
})

test("the page gets the VAPID public key from the private JWK", async () => {
  expect(await run(Effect.flatMap(clientWith(), (client) => client.page.vapidPublicKey()))).toEqual({ publicKey: VAPID_PUBLIC_KEY })
})

describe("the one slot", () => {
  test("the first device takes it, subscribing again keeps it, a second device is refused", async () => {
    const phone = userAgent()
    expect(await subscribe(subscriptionOf(phone))).toBe("ok")
    expect(await subscribe(subscriptionOf(phone))).toBe("ok")
    expect(await subscribe(subscriptionOf(userAgent(), "/push/stranger"))).toBe("SlotTaken")
    expect((await deviceStatus()).device).toMatchObject({ service: pushService.url.host })
  })

  test("the same endpoint with new keys refreshes them, so pushes follow the new keys", async () => {
    expect(await subscribe(subscriptionOf(userAgent()))).toBe("ok")
    const renewed = userAgent()
    expect(await subscribe(subscriptionOf(renewed))).toBe("ok")
    expect(await notify({ message: "after renewal" })).toBe("ok")
    expect(lastPushFor(renewed).message.body).toBe("after renewal")
  })

  test("reset empties it, and the next device takes it", async () => {
    expect(await subscribe(subscriptionOf(userAgent()))).toBe("ok")
    const reset = await run(Effect.flatMap(clientWith({ admin: ADMIN_KEY }), (client) => client.device.reset()))
    expect(reset).toEqual({ removed: true })
    expect(await deviceStatus()).toEqual({ device: null })
    expect(await subscribe(subscriptionOf(userAgent(), "/push/new-phone"))).toBe("ok")
  })

  test("refuses an endpoint off the known push services, and a key off the curve", async () => {
    const phone = subscriptionOf(userAgent())
    expect(await subscribe({ ...phone, endpoint: "https://evil.example.com/push/1" })).toBe("InvalidSubscription")
    expect(await subscribe({ ...phone, endpoint: "http://web.push.apple.com/push/1" })).toBe("InvalidSubscription")
    const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url")
    expect(await subscribe({ ...phone, keys: { ...phone.keys, p256dh: offCurve } })).toBe("InvalidSubscription")
    expect(await deviceStatus()).toEqual({ device: null })
  })

  test("only the admin key sees or empties it", async () => {
    const status = (keys: { readonly admin?: string }) => outcome(Effect.flatMap(clientWith(keys), (client) => client.device.status()))
    const reset = (admin: string) => outcome(Effect.flatMap(clientWith({ admin }), (client) => client.device.reset()))
    expect(await status({})).toBe("Unauthorized")
    expect(await status({ admin: API_KEY })).toBe("Unauthorized")
    expect(await reset(API_KEY)).toBe("Unauthorized")
    expect(await status({ admin: ADMIN_KEY })).toBe("ok")
  })
})

describe("POST /notify", () => {
  test("encrypts the notification for the phone and signs it with the VAPID key", async () => {
    const phone = userAgent()
    await subscribe(subscriptionOf(phone))
    expect(await notify({ message: "Build done", title: "CI", url: "https://example.com/build/1" })).toBe("ok")
    const push = lastPushFor(phone)
    expect(push.path).toBe("/push/device-1")
    expect(push.message).toEqual({ title: "CI", body: "Build done", url: "https://example.com/build/1" })
    expect(push.headers.get("content-encoding")).toBe("aes128gcm")
    expect(push.headers.get("content-type")).toBe("application/octet-stream")
    expect(push.headers.get("ttl")).toBe("86400")
    const vapid = readVapidHeader(push.headers.get("authorization") ?? "")
    expect(vapid).toMatchObject({ verifies: true, publicKey: VAPID_PUBLIC_KEY, claims: { aud: pushService.url.origin, sub: PUSH_URL } })
  })

  test("a title defaults to push, and the url is left out when not given", async () => {
    const phone = userAgent()
    await subscribe(subscriptionOf(phone))
    await notify({ message: "hello" })
    expect(lastPushFor(phone).message).toEqual({ title: "push", body: "hello" })
  })

  test("only the API key sends", async () => {
    await subscribe(subscriptionOf(userAgent()))
    expect(await notify({ message: "x" }, ADMIN_KEY)).toBe("Unauthorized")
    expect(await notify({ message: "x" }, "wrong")).toBe("Unauthorized")
    expect(fakePushService.received).toEqual([])
  })

  test("without a device: NoDevice", async () => {
    expect(await notify({ message: "nobody" })).toBe("NoDevice")
  })

  test("a subscription the push service no longer knows empties the slot: DeviceGone", async () => {
    await subscribe(subscriptionOf(userAgent()))
    fakePushService.answer = 410
    expect(await notify({ message: "gone" })).toBe("DeviceGone")
    expect(await deviceStatus()).toEqual({ device: null })
  })

  test("a push service failure keeps the device: PushServiceError", async () => {
    await subscribe(subscriptionOf(userAgent()))
    fakePushService.answer = 500
    expect(await notify({ message: "later" })).toBe("PushServiceError")
    expect((await deviceStatus()).device).not.toBeNull()
  })

  test("a message too long for one push: MessageTooLarge, before reaching the push service", async () => {
    await subscribe(subscriptionOf(userAgent()))
    expect(await notify({ message: "a".repeat(4000) })).toBe("MessageTooLarge")
    expect(fakePushService.received).toEqual([])
  })

  test("push-client sends through the same route", async () => {
    const phone = userAgent()
    await subscribe(subscriptionOf(phone))
    await run(Effect.flatMap(makePushClient({ url: workerUrl, apiKey: API_KEY }), (client) => client.notify("from the client", { title: "lib" })).pipe(Effect.provide(FetchHttpClient.layer)))
    expect(lastPushFor(phone).message).toEqual({ title: "lib", body: "from the client" })
  })
})

describe("POST /pushover", () => {
  test("sends with the Worker's Pushover credentials", async () => {
    expect(await outcome(Effect.flatMap(clientWith({ sender: API_KEY }), (client) => client.send.pushover({ payload: { message: "legacy", title: "old" } })))).toBe("ok")
    expect(fakePushover.received).toEqual([{ token: "test-pushover-token", user: "test-pushover-user", message: "legacy", title: "old" }])
  })

  test("Pushover refusing it: PushoverError; the admin key: Unauthorized", async () => {
    fakePushover.rejecting = true
    expect(await outcome(Effect.flatMap(clientWith({ sender: API_KEY }), (client) => client.send.pushover({ payload: { message: "x" } })))).toBe("PushoverError")
    expect(await outcome(Effect.flatMap(clientWith({ sender: ADMIN_KEY }), (client) => client.send.pushover({ payload: { message: "x" } })))).toBe("Unauthorized")
  })
})

test("an unknown route answers 404", async () => {
  expect((await fetch(`${workerUrl}/nowhere`)).status).toBe(404)
})

// `push …` as a user runs it, against this Worker, with the keys in the environment.
const runCli = async (args: ReadonlyArray<string>) => {
  const child = Bun.spawn(["bun", join(projectRoot, "src/cli/index.ts"), ...args], {
    env: { ...process.env, PUSH_URL: workerUrl, PUSH_API_KEY: API_KEY, PUSH_ADMIN_KEY: ADMIN_KEY },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout: stdout.trim(), stderr, exitCode }
}

test("the CLI sends, shows the device and resets the slot", async () => {
  const phone = userAgent()
  await subscribe(subscriptionOf(phone))
  expect((await runCli(["send", "from the cli", "-t", "cli", "-u", "https://example.com"])).exitCode).toBe(0)
  expect(lastPushFor(phone).message).toEqual({ title: "cli", body: "from the cli", url: "https://example.com" })
  expect((await runCli(["device", "status"])).stdout).toContain(`A device on ${pushService.url.host} is subscribed`)
  expect((await runCli(["device", "reset"])).stdout).toContain("Removed the device")
  const failed = await runCli(["send", "nobody"])
  expect(failed.exitCode).not.toBe(0)
  expect(failed.stdout + failed.stderr).toContain("NoDevice")
})
