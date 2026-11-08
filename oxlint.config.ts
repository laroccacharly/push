import tsLint, { defineConfig } from "ts-lint/config"

export default defineConfig({
  extends: [tsLint],
  ignorePatterns: ["dist/**"],
  options: {
    typeAware: true,
    typeCheck: true,
  },
  rules: {
    "ts-lint/no-unknown": "error",
    // WebCrypto is the platform's own promise API, not a library to wrap.
    "ts-lint/no-try-promise": "off",
  },
})
