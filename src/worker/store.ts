// The slot in D1: at most one subscription, the device notifications go to.

import { Array, Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { Subscription } from "../../client/api.ts"

const Row = Schema.Struct({ endpoint: Schema.String, p256dh: Schema.String, auth: Schema.String, created_at: Schema.Finite })
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row))

export type StoredSubscription = typeof Row.Type

export type ClaimOutcome = "claimed" | "taken"

// The slot is ours when it holds our endpoint, whether we just took it or held it already.
export const claimOutcome = (stored: Option.Option<StoredSubscription>, endpoint: string): ClaimOutcome => {
  if (Option.exists(stored, (row) => row.endpoint === endpoint)) {
    return "claimed"
  }
  return "taken"
}

export class Store extends Context.Service<
  Store,
  {
    // Takes the empty slot, or refreshes the keys of the subscription already in it; leaves another device's alone.
    readonly claim: (subscription: Subscription, now: number) => Effect.Effect<ClaimOutcome>
    readonly current: Effect.Effect<Option.Option<StoredSubscription>>
    // Empties the slot; true when it held a device.
    readonly reset: Effect.Effect<boolean>
    // Empties the slot only if it still holds `endpoint`, so a device that took it since is kept.
    readonly forget: (endpoint: string) => Effect.Effect<void>
  }
>()("push/Store") {}

export const layer = Layer.effect(
  Store,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const current = sql`SELECT endpoint, p256dh, auth, created_at FROM subscription WHERE slot = 1`.pipe(Effect.flatMap(decodeRows), Effect.map(Array.head), Effect.orDie)

    const claim = Effect.fnUntraced(function* (subscription: Subscription, now: number) {
      const { endpoint, keys } = subscription
      yield* sql`INSERT INTO subscription (slot, endpoint, p256dh, auth, created_at) VALUES (1, ${endpoint}, ${keys.p256dh}, ${keys.auth}, ${now})
        ON CONFLICT (slot) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth WHERE subscription.endpoint = excluded.endpoint`
      return claimOutcome(yield* current, endpoint)
    }, Effect.orDie)

    const reset = Effect.gen(function* () {
      const held = Option.isSome(yield* current)
      yield* sql`DELETE FROM subscription`
      return held
    }).pipe(Effect.orDie)

    const forget = (endpoint: string) => sql`DELETE FROM subscription WHERE endpoint = ${endpoint}`.pipe(Effect.asVoid, Effect.orDie)

    return Store.of({ claim, current, reset, forget })
  })
)
