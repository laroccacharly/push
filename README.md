# push

Push notifications to your iPhone without Pushover: a Cloudflare Worker that keeps one Web Push subscription in D1 and sends it notifications encrypted and signed with a VAPID key, plus a page to add to the Home Screen that subscribes the phone. Pushover stays available beside it.

## Requirements

- [Bun](https://bun.sh)
- A [Cloudflare](https://cloudflare.com) account
- An iPhone on iOS 16.4 or later
- [passkey-auth](https://github.com/laroccacharly/passkey-auth), to generate the keys into its vault

## Installation

```sh
git clone https://github.com/laroccacharly/push
cd push
bun install
bun link
```
