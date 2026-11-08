# push

Push notifications to a phone through a Cloudflare Worker (Web Push, with
Pushover beside it), a CLI to send them, and a client under `client/`.

- use bun
- use Effect TS
- use ts-lint (`bun lint`)

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

# General

- Run `bun lint` after every code change.
- Run unfamiliar CLI commands with `--help` first.

# CLI

push send <message> [-t|--title title] [-u|--url url] [--pushover]
push device status | reset
push login
push auth login | logout | status

# Deploy

bun run deploy [--adopt]
bun run deploy plan | check | destroy
bun run deploy login

# Credentials

Secrets come from effect-lib/credentials: the environment first, then the vault,
then the OS keyring (`Bun.secrets`, service `effect-lib/credentials`, entries
named after the environment variables, shared with other apps).

- `push login` stores `PUSH_URL` and `PUSH_API_KEY`, what a sending machine needs.
- `push device` also needs `PUSH_ADMIN_KEY`.
- `bun run deploy login` stores what deploying needs: the Cloudflare token and
  account, `PUSH_URL`, `VAPID_PRIVATE_KEY`, `PUSH_API_KEY`, `PUSH_ADMIN_KEY`,
  `PUSH_APP_TOKEN` and `PUSH_USER_KEY`. Secrets held by a locked vault count as
  stored; deploying needs it unlocked.

Do not commit secrets; `.env` is gitignored.
