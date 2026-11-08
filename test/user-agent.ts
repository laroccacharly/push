// The phone's side of Web Push, written with node:crypto rather than WebCrypto so it checks the Worker's code
// instead of repeating it: a subscription's keys, and the decryption of what the push service hands over.

import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from "node:crypto"

const concat = (...parts: ReadonlyArray<Uint8Array>) => Buffer.concat(parts)
const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) => Buffer.from(hkdfSync("sha256", ikm, salt, info, length))

export interface UserAgent {
  readonly p256dh: Buffer
  readonly auth: Buffer
  readonly decrypt: (body: Uint8Array) => DecryptedPush
}

export interface DecryptedPush {
  readonly recordSize: number
  readonly keyId: Buffer
  readonly salt: Buffer
  readonly plaintext: Buffer
}

// RFC 8188 section 2: salt (16), record size (4), key id length (1), key id, then the records.
const parseBody = (body: Uint8Array) => {
  const bytes = Buffer.from(body)
  const keyIdLength = bytes.readUInt8(20)
  return {
    salt: bytes.subarray(0, 16),
    recordSize: bytes.readUInt32BE(16),
    keyId: bytes.subarray(21, 21 + keyIdLength),
    record: bytes.subarray(21 + keyIdLength),
  }
}

// The last record ends with 0x02, then zero padding.
const unpad = (padded: Buffer) => {
  let end = padded.length - 1
  while (end >= 0 && padded[end] === 0) {
    end--
  }
  if (padded[end] !== 2) {
    throw new Error("the record does not end with the last-record delimiter")
  }
  return padded.subarray(0, end)
}

// Fresh keys, unless the test gives them.
export const userAgent = (keys: { readonly privateKey?: Uint8Array; readonly auth?: Uint8Array } = {}): UserAgent => {
  const ecdh = createECDH("prime256v1")
  ecdh.generateKeys()
  if (keys.privateKey) {
    ecdh.setPrivateKey(keys.privateKey)
  }
  const p256dh = ecdh.getPublicKey()
  const auth = Buffer.from(keys.auth ?? crypto.getRandomValues(new Uint8Array(16)))
  const decrypt = (body: Uint8Array): DecryptedPush => {
    const { salt, recordSize, keyId, record } = parseBody(body)
    const ecdhSecret = ecdh.computeSecret(keyId)
    const ikm = hkdf(ecdhSecret, auth, concat(Buffer.from("WebPush: info\0"), p256dh, keyId), 32)
    const cek = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16)
    const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12)
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce)
    decipher.setAuthTag(record.subarray(-16))
    const padded = concat(decipher.update(record.subarray(0, -16)), decipher.final())
    return { recordSize, keyId, salt, plaintext: unpad(padded) }
  }
  return { p256dh, auth, decrypt }
}

type Json = Record<string, string | number>

export interface VapidHeader {
  readonly header: Json
  readonly claims: Json
  readonly publicKey: string
  // Whether the token's ES256 signature verifies with the key sent beside it.
  readonly verifies: boolean
}

const decodeJson = (part: string): Json => JSON.parse(Buffer.from(part, "base64url").toString("utf8"))

// `vapid t=<jwt>, k=<public key>`, read the way a push service reads it.
export const readVapidHeader = (authorization: string): VapidHeader => {
  const match = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/u.exec(authorization)
  if (match === null) {
    throw new Error(`not a vapid Authorization header: ${authorization}`)
  }
  const [, token = "", publicKey = ""] = match
  const [header = "", claims = "", signature = ""] = token.split(".")
  const point = Buffer.from(publicKey, "base64url")
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") }, format: "jwk" })
  const verifies = verify("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))
  return { header: decodeJson(header), claims: decodeJson(claims), publicKey, verifies }
}
