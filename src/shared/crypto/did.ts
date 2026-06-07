import { sha256Hex } from './hash'

// Praxis DID method: did:praxis:<role>:<id> where id is the first 32 hex chars
// of SHA-256(publicKey). Deterministic, so a DID is verifiable from its key.

export type DidRole = 'agent' | 'org' | 'core'

const ROLES: readonly DidRole[] = ['agent', 'org', 'core']

export const didFromPublicKey = (publicKey: Uint8Array, role: DidRole): string =>
  `did:praxis:${role}:${sha256Hex(publicKey).slice(0, 32)}`

export interface ParsedDid {
  readonly method: 'praxis'
  readonly role: DidRole
  readonly id: string
}

export const parseDid = (did: string): ParsedDid => {
  const parts = did.split(':')
  if (parts.length !== 4 || parts[0] !== 'did' || parts[1] !== 'praxis') {
    throw new Error(`parseDid: not a praxis DID: ${did}`)
  }
  const role = parts[2] as DidRole
  if (!ROLES.includes(role)) throw new Error(`parseDid: invalid role: ${parts[2]}`)
  return { method: 'praxis', role, id: parts[3]! }
}

export const isPraxisDid = (s: string): boolean => {
  try {
    parseDid(s)
    return true
  } catch {
    return false
  }
}
