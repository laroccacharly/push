import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as State from "alchemy/State"
import * as Effect from "effect/Effect"
import Worker from "./src/worker/index.ts"

export default Alchemy.Stack(
  "push",
  {
    providers: Cloudflare.providers(),
    state: State.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker
    return { url: worker.url }
  })
)
