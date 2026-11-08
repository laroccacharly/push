// RFC 8292: the application server proves which key it holds with a short-lived ES256 JWT, sent beside its public key.

import { Effect, Schema } from "effect"
import { concatBytes, fromBase64Url, toBase64Url } from "./base64url.ts"

const encoder = new TextEncoder()

// RFC 8292 caps a token's lifetime at 24 hours; half leaves room for a skewed clock.
const TOKEN_LIFETIME_SECONDS = 12 * 60 * 60

const Base64Url = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/u, { expected: "base64url" }))

// VAPID_PRIVATE_KEY: an ECDSA P-256 private key as a JWK, as `passkey-auth vault generate --vapid` stores it. Its x and y
// are the public key, so there is no second secret to keep in step.
const VapidJwk = Schema.Struct({ kty: Schema.Literal("EC"), crv: Schema.Literal("P-256"), d: Base64Url, x: Base64Url, y: Base64Url })
const decodeVapidJwk = Schema.decodeUnknownEffect(Schema.fromJsonString(VapidJwk))

export class InvalidVapidKey extends Schema.TaggedError<InvalidVapidKey, { readonly brand: unique symbol }>()("InvalidVapidKey", { message: Schema.String }) {}

export interface VapidKeys {
  readonly signingKey: CryptoKey
  // The uncompressed point the browser subscribes with, as applicationServerKey.
  readonly publicKey: Uint8Array<ArrayBuffer>
}

const importSigningKey = (jwk: typeof VapidJwk.Type) =>
  Effect.tryPromise({
    try: () => crypto.subtle.importKey("jwk", { ...jwk, ext: false }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    catch: (error) => new InvalidVapidKey({ message: `VAPID_PRIVATE_KEY is not a P-256 private key: ${String(error)}` }),
  })

export const importVapidKeys = Effect.fnUntraced(function* (jwkText: string) {
  const jwk = yield* decodeVapidJwk(jwkText).pipe(Effect.mapError(() => new InvalidVapidKey({ message: "VAPID_PRIVATE_KEY is not an EC P-256 private JWK" })))
  const signingKey = yield* importSigningKey(jwk)
  return { signingKey, publicKey: concatBytes(new Uint8Array([4]), fromBase64Url(jwk.x), fromBase64Url(jwk.y)) } satisfies VapidKeys
})

const encodeJson = (value: object) => toBase64Url(encoder.encode(JSON.stringify(value)))

// The push service's origin, never the endpoint's path: RFC 8292 section 2.
export const audienceOf = (endpoint: string) => new URL(endpoint).origin

export interface TokenClaims {
  readonly aud: string
  readonly exp: number
  readonly sub: string
}

export const tokenClaims = (endpoint: string, subject: string, nowMillis: number): TokenClaims => ({
  aud: audienceOf(endpoint),
  exp: Math.floor(nowMillis / 1000) + TOKEN_LIFETIME_SECONDS,
  sub: subject,
})

// WebCrypto signs ECDSA as r || s, 64 bytes, which is what JWS's ES256 wants.
export const signToken = (signingKey: CryptoKey, claims: TokenClaims) =>
  Effect.promise(async () => {
    const signingInput = `${encodeJson({ typ: "JWT", alg: "ES256" })}.${encodeJson(claims)}`
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, encoder.encode(signingInput))
    return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`
  })

// The Authorization header of a push request to `endpoint`; `subject` is who the push service may contact, a URL or mailto:.
export const vapidAuthorization = Effect.fnUntraced(function* (keys: VapidKeys, endpoint: string, subject: string, nowMillis: number) {
  const token = yield* signToken(keys.signingKey, tokenClaims(endpoint, subject, nowMillis))
  return `vapid t=${token}, k=${toBase64Url(keys.publicKey)}`
})
