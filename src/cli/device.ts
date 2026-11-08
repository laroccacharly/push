// `push device status | reset`: the one slot, with PUSH_ADMIN_KEY.

import { Console, Effect, Redacted } from "effect"
import { Command } from "effect/cli"
import { FetchHttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api"
import { Admin, PushApi } from "../../client/api.ts"
import { PushAdminKey, PushUrl } from "../credentials.ts"

const adminClient = Effect.gen(function* () {
  const baseUrl = Redacted.value(yield* PushUrl.resolve)
  const adminKey = yield* PushAdminKey.resolve
  const bearer = HttpApiMiddleware.layerClient(Admin, ({ next, request }) => next(HttpClientRequest.bearerToken(request, adminKey)))
  return yield* HttpApiClient.make(PushApi, { baseUrl }).pipe(Effect.provide([bearer, FetchHttpClient.layer]))
})

const describeDevice = (device: { readonly service: string; readonly subscribedAt: number } | null) => {
  if (device === null) {
    return "No device is subscribed: the next one to enable notifications on the page takes the slot"
  }
  return `A device on ${device.service} is subscribed, since ${new Date(device.subscribedAt).toLocaleString()}`
}

const status = adminClient.pipe(
  Effect.flatMap((client) => client.device.status()),
  Effect.flatMap(({ device }) => Console.log(describeDevice(device)))
)

const describeReset = (removed: boolean) => {
  if (removed) {
    return "Removed the device; the next one to enable notifications takes the slot"
  }
  return "No device was subscribed"
}

const reset = adminClient.pipe(
  Effect.flatMap((client) => client.device.reset()),
  Effect.flatMap(({ removed }) => Console.log(describeReset(removed)))
)

export const deviceCommand = Command.make("device").pipe(
  Command.withDescription("The one device notifications go to, with PUSH_ADMIN_KEY"),
  Command.withSubcommands([
    Command.make("status", {}, () => status).pipe(Command.withDescription("Show whether a device holds the slot")),
    Command.make("reset", {}, () => reset).pipe(Command.withDescription("Empty the slot, so the next device to enable notifications takes it")),
  ])
)
