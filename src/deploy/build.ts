// `bun run build`, the deploy's build step: the page, its service worker and icons, and push-client's tarball with the PUSH_URL
// it is deployed for built in, all in dist/assets, which the Worker serves before it runs.

import { cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunRuntime } from "@effect/platform-bun"
import { Effect, Redacted } from "effect"
import * as Credentials from "effect-lib/credentials"
import { PushUrl } from "../credentials.ts"

const projectRoot = join(import.meta.dir, "../..")
const assetsDir = join(projectRoot, "dist/assets")
const uiDir = join(projectRoot, "src/ui")

const urlModule = (url: string) => `import { Option } from "effect"

// The Worker this copy of the client was built for, by \`bun run build\`.
export const builtInUrl: Option.Option<string> = Option.some(${JSON.stringify(url)})
`

const bundleUi = Effect.promise(async () => {
  const result = await Bun.build({ entrypoints: [join(uiDir, "page.ts"), join(uiDir, "sw.ts")], outdir: assetsDir, naming: "[name].js", target: "browser", minify: true })
  if (!result.success) {
    throw new AggregateError(result.logs, "the page did not build")
  }
  await cp(join(uiDir, "index.html"), join(assetsDir, "index.html"))
  await cp(join(uiDir, "public"), assetsDir, { recursive: true })
})

// The client's files in a fresh directory, url.ts naming `url`, packed into `destination`.
export const packClient = (url: string, destination: string) =>
  Effect.promise(async () => {
    const staging = await mkdtemp(join(tmpdir(), "push-client-"))
    try {
      await cp(join(projectRoot, "client"), staging, { recursive: true })
      await writeFile(join(staging, "url.ts"), urlModule(url))
      await Bun.$`bun pm pack --quiet --destination ${destination}`.cwd(staging).quiet()
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  })

// PUSH_URL is a secret to the deploy, kept out of the build's environment, so it is read here from the vault or the keyring.
const main = Effect.gen(function* () {
  const url = Redacted.value(yield* PushUrl.resolve)
  yield* Effect.promise(() => rm(assetsDir, { recursive: true, force: true }))
  yield* bundleUi
  yield* packClient(url, join(assetsDir, "client"))
  yield* Effect.log(`page and push-client built into ${assetsDir}, for ${url}`)
}).pipe(Effect.provide(Credentials.layer(Credentials.defaultKeyring())))

if (import.meta.main) {
  BunRuntime.runMain(main)
}
