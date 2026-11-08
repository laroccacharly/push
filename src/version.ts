import packageJson from "../package.json" with { type: "json" }

// The `version` of package.json, shared by the CLI and the deploy.
export const version: string = packageJson.version
