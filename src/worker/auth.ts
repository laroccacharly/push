// The Sender and Admin middlewares: each checks the bearer token against its own key from the Worker's env.

import { Config, Effect, Layer, Redacted } from "effect"
import { Digest, Mac } from "effect/crypto"
import { Admin, Sender, Unauthorized } from "../../client/api.ts"

const sha256 = (text: string) => Digest.Digest.use((digest) => digest.digest(Digest.sha256, new TextEncoder().encode(text)))

// Compares SHA-256 digests in constant time, so neither the key's content nor its length shows in the timing.
const keyCheck = Effect.fnUntraced(function* (name: string) {
  const expected = yield* sha256(Redacted.value(yield* Config.Redacted(name)))
  const digest = yield* Digest.Digest
  return (credential: Redacted.Redacted<string>) =>
    sha256(Redacted.value(credential)).pipe(
      Effect.map((actual) => Mac.timingSafeEqual(actual, expected)),
      Effect.provideService(Digest.Digest, digest)
    )
})

const bearerFor = Effect.fnUntraced(function* (name: string) {
  const matches = yield* keyCheck(name)
  return <A, E, R>(httpEffect: Effect.Effect<A, E, R>, { credential }: { readonly credential: Redacted.Redacted<string> }): Effect.Effect<A, E | Unauthorized, R> =>
    Effect.flatMap(matches(credential), (ok): Effect.Effect<A, E | Unauthorized, R> => {
      if (ok) {
        return httpEffect
      }
      return Effect.fail(new Unauthorized())
    })
})

const senderLayer = Layer.effect(Sender, Effect.map(bearerFor("PUSH_API_KEY"), (bearer) => Sender.of({ bearer })))

const adminLayer = Layer.effect(Admin, Effect.map(bearerFor("PUSH_ADMIN_KEY"), (bearer) => Admin.of({ bearer })))

// Needs PUSH_API_KEY and PUSH_ADMIN_KEY in the Config.
export const authLayer = Layer.mergeAll(senderLayer, adminLayer).pipe(Layer.provide(Digest.layerWebCrypto))
