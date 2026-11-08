#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option, Redacted } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import * as CloudflareDns from "effect-lib/cloudflare-dns"
import * as Credentials from "effect-lib/credentials"
import { make as makeClient } from "../../client/index.ts"
import { PushApiKey, PushUrl, senderCredentials } from "../credentials.ts"
import { version } from "../version.ts"
import { deviceCommand } from "./device.ts"

const message = Argument.String("message").pipe(Argument.withDescription("The notification's text; quote it when it has spaces"))
const title = Flag.String("title").pipe(Flag.withAlias("t"), Flag.withDescription("Shown above the message"), Flag.optional)
const url = Flag.String("url").pipe(Flag.withAlias("u"), Flag.withDescription("Opened when the notification is tapped"), Flag.optional)
const viaPushover = Flag.Boolean("pushover").pipe(Flag.withDescription("Send it through Pushover instead of Web Push"), Flag.withDefault(false))

const clientFromCredentials = Effect.gen(function* () {
  return yield* makeClient({ url: Redacted.value(yield* PushUrl.resolve), apiKey: yield* PushApiKey.resolve })
})

const send = Effect.fnUntraced(function* (input: { readonly message: string; readonly title: Option.Option<string>; readonly url: Option.Option<string>; readonly pushover: boolean }) {
  const client = yield* clientFromCredentials
  const titleOption = Option.match(input.title, { onNone: () => ({}), onSome: (text) => ({ title: text }) })
  if (input.pushover) {
    return yield* client.pushover(input.message, titleOption)
  }
  yield* client.notify(input.message, { ...titleOption, ...Option.match(input.url, { onNone: () => ({}), onSome: (link) => ({ url: link }) }) })
})

const sendCommand = Command.make("send", { message, title, url, pushover: viaPushover }, send).pipe(Command.withDescription("Send a notification to the subscribed phone"))

const push = Command.make("push").pipe(
  Command.withDescription("Push notifications to your phone through a Cloudflare Worker"),
  Command.withSubcommands([sendCommand, deviceCommand, ...senderCredentials.commands])
)

// The Worker resolves through Cloudflare DNS, so the CLI reaches a domain the deploy just created.
const MainLive = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, CloudflareDns.layer(), senderCredentials.layer(Credentials.defaultKeyring()))

BunRuntime.runMain(Command.run(push, { version }).pipe(Effect.provide(MainLive)))
