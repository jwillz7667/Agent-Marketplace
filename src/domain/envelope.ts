// Every signed protocol object carries replay-protection + freshness fields and a
// detached-JWS signature. Signed<T> is the type-level shape; verification lives in
// src/shared/http (verifySignedObject) and src/shared/crypto.

export interface SignatureEnvelope {
  readonly nonce: string
  readonly iat: string // RFC 3339
  readonly exp: string // RFC 3339
  readonly sig: string // detached JWS
}

export type Signed<T> = T & SignatureEnvelope

// The fields stripped before recomputing the signing input. A signature is computed
// over the object MINUS its own `sig` (and, for board posts, the chain fields filled
// server-side). Callers pass the exact omit list per object type.
export const stripForSigning = <T extends object>(obj: T, omit: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!omit.includes(k)) out[k] = v
  }
  return out
}
