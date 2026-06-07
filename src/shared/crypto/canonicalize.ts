import canonicalizeLib from 'canonicalize'
import { utf8ToBytes } from '@noble/hashes/utils'

// RFC 8785 JSON Canonicalization Scheme. Signatures are computed over the canonical
// byte form so that key ordering / insignificant whitespace cannot change a signature.

export const canonicalize = (value: unknown): string => {
  const out = canonicalizeLib(value as object)
  if (out === undefined) {
    throw new Error('canonicalize: value is not JSON-serializable')
  }
  return out
}

export const canonicalBytes = (value: unknown): Uint8Array => utf8ToBytes(canonicalize(value))
