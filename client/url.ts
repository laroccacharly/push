import { Option } from "effect"

// The Worker this copy of the client calls when neither the options nor PUSH_URL name one. None here; in the tarball
// the Worker serves, the PUSH_URL it was deployed for, written by `bun run build`.
export const builtInUrl: Option.Option<string> = Option.none()
