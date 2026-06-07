import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { concatBytes } from '@noble/hashes/utils'

// @noble/ed25519 v2 needs a SHA-512 implementation injected before use.
// Wiring the sync hook also satisfies the async API.
ed.etc.sha512Sync = (...m: Uint8Array[]): Uint8Array => sha512(concatBytes(...m))

export interface KeyPair {
  readonly privateKey: Uint8Array
  readonly publicKey: Uint8Array
}

export const generateKeyPair = async (): Promise<KeyPair> => {
  const privateKey = ed.utils.randomPrivateKey()
  const publicKey = await ed.getPublicKeyAsync(privateKey)
  return { privateKey, publicKey }
}

export const publicKeyFromPrivate = async (privateKey: Uint8Array): Promise<Uint8Array> =>
  ed.getPublicKeyAsync(privateKey)

export const sign = (message: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array> =>
  ed.signAsync(message, privateKey)

export const verify = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean> =>
  ed.verifyAsync(signature, message, publicKey)

// base64url codecs (no padding) for keys and signatures on the wire.
export const bytesToB64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
export const b64uToBytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64url'))

export const pubToB64u = bytesToB64u
export const b64uToPub = b64uToBytes
export const privToB64u = bytesToB64u
export const b64uToPriv = b64uToBytes
