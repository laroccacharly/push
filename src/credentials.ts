import { Schema } from "effect"
import * as Credentials from "effect-lib/credentials"

// An https origin without a path, e.g. `https://push.example.com`, or a local Worker, e.g. `http://localhost:1350`.
const Origin = Schema.String.check(
  Schema.isPattern(/^(?:https:\/\/[^/\s]+|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)$/u, {
    expected: "an https origin without a path, e.g. https://push.example.com, or http://localhost:<port>",
  })
)

// Where the Worker is reached, and the VAPID subject: PUSH_URL, else the vault, then the OS keyring.
export const PushUrl = Credentials.secret("PUSH_URL", { label: "push Worker URL", schema: Origin, sensitive: false })

// Sends notifications, nothing else; what consumers hold.
export const PushApiKey = Credentials.secret("PUSH_API_KEY", { label: "push API key" })

// Sees and empties the device slot; stays on the machine that deploys.
export const PushAdminKey = Credentials.secret("PUSH_ADMIN_KEY", { label: "push admin key" })

// The ECDSA P-256 private JWK that signs every push, from `passkey-auth vault generate VAPID_PRIVATE_KEY --vapid`.
export const VapidPrivateKey = Credentials.secret("VAPID_PRIVATE_KEY", { label: "VAPID private key" })

// `push login` and `push auth login | logout | status`, on a machine that sends.
export const senderCredentials = Credentials.make([PushUrl, PushApiKey])
