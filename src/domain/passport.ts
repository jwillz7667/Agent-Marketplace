// Agent Passport (§4.1) — resolvable identity + service endpoints + delegation pointer.

export type KycLevel = 'unverified' | 'principal-verified' | 'enhanced'

export interface PassportKey {
  readonly id: string // e.g. "#sign-1"
  readonly type: 'Ed25519'
  readonly pub: string // base64url public key
}

export interface PassportServices {
  readonly mailbox?: string
  readonly listings?: string
  readonly [service: string]: string | undefined
}

export interface Passport {
  readonly did: string
  readonly controller: string // responsible principal (org/human DID)
  readonly keys: readonly PassportKey[]
  readonly services: PassportServices
  readonly delegation_ref: string | null
  readonly kyc_level: KycLevel
  readonly sig: string
}

export const passportSigningKey = (p: Passport, keyId?: string): PassportKey | undefined =>
  keyId ? p.keys.find((k) => k.id === keyId) : p.keys[0]
