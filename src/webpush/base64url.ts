// Web Push writes every key, salt and token in unpadded base64url.

export const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.fromBase64(text, { alphabet: "base64url" })

export const toBase64Url = (bytes: Uint8Array): string => bytes.toBase64({ alphabet: "base64url", omitPadding: true })

export const concatBytes = (...parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}
