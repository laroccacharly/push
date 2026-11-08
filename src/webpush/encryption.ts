// RFC 8291: the message encrypted for one subscription, in RFC 8188's aes128gcm content coding, as a single record.

import { Effect, Schema } from "effect"
import { concatBytes } from "./base64url.ts"

const encoder = new TextEncoder()

const RECORD_SIZE = 4096
// The salt (16), the record size (4), the key id's length (1) and the key id, our uncompressed P-256 public key (65).
const HEADER_SIZE = 86
const TAG_SIZE = 16
// Marks the only record as the last one; padding would follow it.
const LAST_RECORD = 0x02

// Push services refuse a body over 4096 bytes, so the message must leave room for the header, the delimiter and the tag.
export const MAX_PLAINTEXT_SIZE = RECORD_SIZE - HEADER_SIZE - TAG_SIZE - 1

export const cekInfo = encoder.encode("Content-Encoding: aes128gcm\0")
export const nonceInfo = encoder.encode("Content-Encoding: nonce\0")
export const keyInfo = (uaPublic: Uint8Array, asPublic: Uint8Array) => concatBytes(encoder.encode("WebPush: info\0"), uaPublic, asPublic)

export class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge, { readonly brand: unique symbol }>()("PayloadTooLarge", { message: Schema.String }, { httpApiStatus: 413 }) {}

// The subscription's keys, as the browser gave them: its ECDH public key and the shared authentication secret.
export interface Recipient {
  readonly p256dh: Uint8Array<ArrayBuffer>
  readonly auth: Uint8Array<ArrayBuffer>
}

// A fresh ECDH key pair and salt for each message; the tests pass RFC 8291's.
export interface Sender {
  readonly keyPair: CryptoKeyPair
  readonly salt: Uint8Array<ArrayBuffer>
}

const hkdf = (salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number) =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"])
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8))
  })

const exportRaw = (key: CryptoKey) => Effect.promise(async () => new Uint8Array(await crypto.subtle.exportKey("raw", key)))

const sharedSecret = (privateKey: CryptoKey, publicKey: CryptoKey) =>
  Effect.promise(async () => new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256)))

const aesGcm = (cek: Uint8Array<ArrayBuffer>, nonce: Uint8Array<ArrayBuffer>, plaintext: Uint8Array<ArrayBuffer>) =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"])
    return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext))
  })

// Rejects a point that is not on P-256, as RFC 8291 requires: a bad one could leak our private key.
export const importRecipientKey = (p256dh: Uint8Array<ArrayBuffer>) =>
  Effect.tryPromise({
    try: () => crypto.subtle.importKey("raw", p256dh, { name: "ECDH", namedCurve: "P-256" }, true, []),
    catch: () => "not a P-256 public key",
  })

export interface ContentKeys {
  readonly ikm: Uint8Array<ArrayBuffer>
  readonly cek: Uint8Array<ArrayBuffer>
  readonly nonce: Uint8Array<ArrayBuffer>
}

// RFC 8291 section 3.4: the ECDH secret and the auth secret give the IKM, from which the salt gives the key and the nonce.
export const deriveContentKeys = Effect.fnUntraced(function* (input: {
  readonly ecdhSecret: Uint8Array<ArrayBuffer>
  readonly auth: Uint8Array<ArrayBuffer>
  readonly uaPublic: Uint8Array<ArrayBuffer>
  readonly asPublic: Uint8Array<ArrayBuffer>
  readonly salt: Uint8Array<ArrayBuffer>
}) {
  const ikm = yield* hkdf(input.auth, input.ecdhSecret, keyInfo(input.uaPublic, input.asPublic), 32)
  const cek = yield* hkdf(input.salt, ikm, cekInfo, 16)
  const nonce = yield* hkdf(input.salt, ikm, nonceInfo, 12)
  return { ikm, cek, nonce } satisfies ContentKeys
})

export const encodeHeader = (salt: Uint8Array, asPublic: Uint8Array) => {
  const recordSize = new Uint8Array(4)
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE)
  return concatBytes(salt, recordSize, new Uint8Array([asPublic.length]), asPublic)
}

export const newSender = Effect.promise(async (): Promise<Sender> => {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  return { keyPair, salt: crypto.getRandomValues(new Uint8Array(16)) }
})

const checkSize = (plaintext: Uint8Array) => {
  if (plaintext.length <= MAX_PLAINTEXT_SIZE) {
    return Effect.void
  }
  return Effect.fail(new PayloadTooLarge({ message: `the notification is ${plaintext.length} bytes once encoded; at most ${MAX_PLAINTEXT_SIZE} fit in a push` }))
}

// The request body for the push service: the header, then the one record. `recipient.p256dh` must have passed importRecipientKey.
export const encrypt = Effect.fnUntraced(function* (recipient: Recipient, plaintext: Uint8Array<ArrayBuffer>, sender: Sender) {
  yield* checkSize(plaintext)
  const uaKey = yield* importRecipientKey(recipient.p256dh).pipe(Effect.orDie)
  const asPublic = yield* exportRaw(sender.keyPair.publicKey)
  const ecdhSecret = yield* sharedSecret(sender.keyPair.privateKey, uaKey)
  const { cek, nonce } = yield* deriveContentKeys({ ecdhSecret, auth: recipient.auth, uaPublic: recipient.p256dh, asPublic, salt: sender.salt })
  const record = yield* aesGcm(cek, nonce, concatBytes(plaintext, new Uint8Array([LAST_RECORD])))
  return concatBytes(encodeHeader(sender.salt, asPublic), record)
})
