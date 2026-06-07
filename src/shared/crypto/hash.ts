import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { canonicalize } from './canonicalize'

const toBytes = (input: Uint8Array | string): Uint8Array =>
  typeof input === 'string' ? utf8ToBytes(input) : input

export const sha256Hex = (input: Uint8Array | string): string => bytesToHex(sha256(toBytes(input)))

// Hash over the canonical form of an arbitrary JSON value (stable across key order).
export const sha256Canonical = (value: unknown): string => sha256Hex(canonicalize(value))

// One link of a hash chain: H(prevHash || canonical(payload)).
export const hashChain = (prevHash: string, payload: unknown): string =>
  sha256Hex(prevHash + canonicalize(payload))

// "sha256:<hex>" form used in receipts/result hashing.
export const sha256Tagged = (input: Uint8Array | string): string => `sha256:${sha256Hex(input)}`
