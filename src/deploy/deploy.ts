// `bun run deploy`, for whoever deploys the Worker, never part of the `push` CLI. `bun run deploy login` stores what is not in
// the vault yet: PUSH_URL, the two keys, the VAPID key and Pushover's credentials, under the names every app shares. It
// deploys this checkout's commit as DEPLOY_VERSION, then waits for PUSH_URL/health to answer it.

import * as Deploy from "effect-lib/deploy"
import * as Pushover from "effect-lib/push"
import { PushAdminKey, PushApiKey, VapidPrivateKey } from "../credentials.ts"
import { version } from "../version.ts"

Deploy.run({ app: "push", url: "PUSH_URL", secrets: [VapidPrivateKey, PushApiKey, PushAdminKey, Pushover.AppToken, Pushover.UserKey], build: ["bun", "run", "build"] }, { version })
