// RFC 8291's example, intermediate values included, then the encryption and the VAPID token checked against the
// phone's side written with node:crypto (./user-agent.ts).

import { describe, expect, test } from "bun:test"
import { createECDH, createPublicKey, verify } from "node:crypto"
import { Effect, Exit } from "effect"
import vector from "./fixtures/rfc8291.json" with { type: "json" }
import { concatBytes, fromBase64Url, toBase64Url } from "../src/webpush/base64url.ts"
import { cekInfo, deriveContentKeys, encodeHeader, encrypt, importRecipientKey, keyInfo, MAX_PLAINTEXT_SIZE, newSender, nonceInfo, type Sender } from "../src/webpush/encryption.ts"
import { importVapidKeys, vapidAuthorization } from "../src/webpush/vapid.ts"
import { readVapidHeader, userAgent } from "./user-agent.ts"

const bytes = fromBase64Url
const run = Effect.runPromise
const encoder = new TextEncoder()

// The application server's key pair from the example, which WebCrypto only imports as a JWK.
const rfcSender = async (): Promise<Sender> => {
  const asPublic = bytes(vector.asPublic)
  const jwk = { kty: "EC", crv: "P-256", d: vector.asPrivate, x: toBase64Url(asPublic.subarray(1, 33)), y: toBase64Url(asPublic.subarray(33)) }
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  const publicKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, true, [])
  return { keyPair: { privateKey, publicKey }, salt: bytes(vector.salt) }
}

const rfcRecipient = { p256dh: bytes(vector.uaPublic), auth: bytes(vector.authSecret) }

const recipientOf = (agent: ReturnType<typeof userAgent>) => ({ p256dh: new Uint8Array(agent.p256dh), auth: new Uint8Array(agent.auth) })

const encryptFor = async (agent: ReturnType<typeof userAgent>, plaintext: Uint8Array<ArrayBuffer>) => run(encrypt(recipientOf(agent), plaintext, await run(newSender)))

describe("RFC 8291 appendix A", () => {
  test("the info strings", () => {
    expect(toBase64Url(keyInfo(bytes(vector.uaPublic), bytes(vector.asPublic)))).toBe(vector.keyInfo)
    expect(toBase64Url(cekInfo)).toBe(vector.cekInfo)
    expect(toBase64Url(nonceInfo)).toBe(vector.nonceInfo)
  })

  test("the shared ECDH secret, from either side", async () => {
    const sender = await rfcSender()
    const uaKey = await run(importRecipientKey(bytes(vector.uaPublic)))
    const fromServer = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, sender.keyPair.privateKey, 256))
    expect(toBase64Url(fromServer)).toBe(vector.ecdhSecret)
    const ua = createECDH("prime256v1")
    ua.setPrivateKey(bytes(vector.uaPrivate))
    expect(ua.computeSecret(bytes(vector.asPublic)).toString("base64url")).toBe(vector.ecdhSecret)
  })

  test("the IKM, the content encryption key and the nonce", async () => {
    const keys = await run(
      deriveContentKeys({ ecdhSecret: bytes(vector.ecdhSecret), auth: bytes(vector.authSecret), uaPublic: bytes(vector.uaPublic), asPublic: bytes(vector.asPublic), salt: bytes(vector.salt) })
    )
    expect(toBase64Url(keys.ikm)).toBe(vector.ikm)
    expect(toBase64Url(keys.cek)).toBe(vector.cek)
    expect(toBase64Url(keys.nonce)).toBe(vector.nonce)
  })

  test("the 86-byte header", () => {
    const header = encodeHeader(bytes(vector.salt), bytes(vector.asPublic))
    expect(header.length).toBe(86)
    expect(toBase64Url(header)).toBe(vector.header)
  })

  test("the encrypted body, byte for byte", async () => {
    const body = await run(encrypt(rfcRecipient, encoder.encode(vector.plaintext), await rfcSender()))
    expect(toBase64Url(body)).toBe(vector.body)
    expect(toBase64Url(body)).toBe(toBase64Url(concatBytes(bytes(vector.header), bytes(vector.ciphertext))))
  })

  test("the phone's side decrypts the example with its private key", () => {
    const decrypted = userAgent({ privateKey: bytes(vector.uaPrivate), auth: bytes(vector.authSecret) }).decrypt(bytes(vector.body))
    expect(decrypted.plaintext.toString("utf8")).toBe(vector.plaintext)
    expect(toBase64Url(concatBytes(decrypted.plaintext, new Uint8Array([2])))).toBe(vector.paddedPlaintext)
  })
})

describe("encryption for a fresh subscription", () => {
  const payloads = {
    ascii: "Build done",
    unicode: "Déploiement terminé ✅ 🚀 — 日本語",
    json: JSON.stringify({ title: "t", body: "b", url: "https://example.com/?a=1&b=2" }),
    oneByte: "x",
    largest: "a".repeat(MAX_PLAINTEXT_SIZE),
  }

  for (const [name, text] of Object.entries(payloads)) {
    test(`the phone decrypts it: ${name}`, async () => {
      const agent = userAgent()
      const decrypted = agent.decrypt(await encryptFor(agent, encoder.encode(text)))
      expect(decrypted.plaintext.toString("utf8")).toBe(text)
      expect(decrypted.recordSize).toBe(4096)
      expect(decrypted.keyId.length).toBe(65)
      expect(decrypted.keyId[0]).toBe(4)
    })
  }

  test("the largest message makes a body of exactly 4096 bytes, one more byte is refused", async () => {
    const agent = userAgent()
    expect((await encryptFor(agent, new Uint8Array(MAX_PLAINTEXT_SIZE))).length).toBe(4096)
    const exit = await Effect.runPromiseExit(encrypt(recipientOf(agent), new Uint8Array(MAX_PLAINTEXT_SIZE + 1), await run(newSender)))
    expect(exit).toMatchObject({ _tag: "Failure" })
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("PayloadTooLarge")
  })

  test("each message gets its own key pair and salt", async () => {
    const agent = userAgent()
    const first = agent.decrypt(await encryptFor(agent, encoder.encode("same")))
    const second = agent.decrypt(await encryptFor(agent, encoder.encode("same")))
    expect(first.salt.equals(second.salt)).toBe(false)
    expect(first.keyId.equals(second.keyId)).toBe(false)
  })

  test("only the subscription it was made for can read it", async () => {
    const agent = userAgent()
    const body = await encryptFor(agent, encoder.encode("secret"))
    expect(() => userAgent().decrypt(body)).toThrow()
    const sameKeyOtherAuth = userAgent({ auth: agent.auth })
    expect(() => sameKeyOtherAuth.decrypt(body)).toThrow()
  })

  test("a flipped bit anywhere in the record fails the decryption", async () => {
    const agent = userAgent()
    const body = await encryptFor(agent, encoder.encode("tamper with me"))
    for (const index of [86, 90, body.length - 1]) {
      const tampered = new Uint8Array(body)
      tampered[index] = (tampered[index] ?? 0) ^ 1
      expect(() => agent.decrypt(tampered)).toThrow()
    }
  })

  test("a recipient key off the P-256 curve, or of the wrong length, is refused", async () => {
    const offCurve = concatBytes(new Uint8Array([4]), new Uint8Array(64).fill(1))
    expect(await Effect.runPromiseExit(importRecipientKey(offCurve))).toMatchObject({ _tag: "Failure" })
    expect(await Effect.runPromiseExit(importRecipientKey(bytes(vector.uaPublic).subarray(0, 64)))).toMatchObject({ _tag: "Failure" })
    expect(await Effect.runPromiseExit(importRecipientKey(bytes(vector.uaPublic)))).toMatchObject({ _tag: "Success" })
  })
})

// What `passkey-auth vault generate --vapid` stores.
const generateVapidJwk = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  return { jwk: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)), publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) }
}

const ENDPOINT = "https://web.push.apple.com/QGuQyavXutnMH6ga8jHHcTN5lFXs3qtOR5rKjHgcCFjeqeeS"
const SUBJECT = "https://push.laroccadev.com"
const NOW = Date.UTC(2026, 10, 8, 12)

describe("VAPID", () => {
  test("the public key is the JWK's own, as the browser's applicationServerKey", async () => {
    const { jwk, publicKey } = await generateVapidJwk()
    const keys = await run(importVapidKeys(jwk))
    expect(keys.publicKey).toEqual(publicKey)
    expect(keys.publicKey.length).toBe(65)
  })

  test("the Authorization header: an ES256 token for the push service's origin, signed by the key sent beside it", async () => {
    const { jwk, publicKey } = await generateVapidJwk()
    const header = readVapidHeader(await run(vapidAuthorization(await run(importVapidKeys(jwk)), ENDPOINT, SUBJECT, NOW)))
    expect(header.verifies).toBe(true)
    expect(header.publicKey).toBe(toBase64Url(publicKey))
    expect(header.header).toEqual({ typ: "JWT", alg: "ES256" })
    expect(header.claims).toEqual({ aud: "https://web.push.apple.com", exp: NOW / 1000 + 12 * 60 * 60, sub: SUBJECT })
  })

  test("a token with changed claims, or checked against another key, does not verify", async () => {
    const keys = await run(importVapidKeys((await generateVapidJwk()).jwk))
    const authorization = await run(vapidAuthorization(keys, ENDPOINT, SUBJECT, NOW))
    const [, token = ""] = /t=([^,]+)/u.exec(authorization) ?? []
    const [header = "", , signature = ""] = token.split(".")
    const forgedClaims = Buffer.from(JSON.stringify({ aud: "https://web.push.apple.com", exp: NOW / 1000 + 9_999_999, sub: SUBJECT })).toString("base64url")
    const key = createPublicKey({ key: JSON.parse(JSON.stringify({ kty: "EC", crv: "P-256", x: toBase64Url(keys.publicKey.subarray(1, 33)), y: toBase64Url(keys.publicKey.subarray(33)) })), format: "jwk" })
    expect(verify("sha256", Buffer.from(`${header}.${forgedClaims}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))).toBe(false)
    const other = readVapidHeader(authorization.replace(/k=.*$/u, `k=${toBase64Url((await generateVapidJwk()).publicKey)}`))
    expect(other.verifies).toBe(false)
  })

  test("a key that is not a P-256 private JWK is refused", async () => {
    const p384 = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign"])
    const { d: _d, ...publicOnly } = JSON.parse((await generateVapidJwk()).jwk)
    const refused = ["not json", "{}", JSON.stringify(await crypto.subtle.exportKey("jwk", p384.privateKey)), JSON.stringify(publicOnly), JSON.stringify({ ...publicOnly, d: "AAAA" })]
    for (const text of refused) {
      expect((await run(Effect.flip(importVapidKeys(text))))._tag).toBe("InvalidVapidKey")
    }
  })
})
