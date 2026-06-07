import type { Money } from './money'

// DelegationCredential (§4.2) — the signed spending policy (AP2-style mandate generalized).
// This object *is* the authorization; the signer enforces it below the agent (§4.3).

export interface SpendPolicy {
  readonly per_tx_max: Money
  readonly daily_max: Money
  readonly total_max: Money
}

export interface MessagingPolicy {
  readonly send: boolean
  readonly max_postage_per_day: string // decimal amount in policy currency
}

export interface PostingPolicy {
  readonly offers: boolean
  readonly rfps: boolean
  readonly max_post_spend_per_day: string
}

export interface EscrowPolicy {
  readonly may_commit: boolean
  readonly max_escrow: Money
}

export interface DelegationPolicy {
  readonly spend: SpendPolicy
  readonly categories_allow: readonly string[]
  readonly categories_deny: readonly string[]
  readonly counterparties_allow: readonly string[]
  readonly counterparties_deny: readonly string[]
  readonly require_human_approval_over: Money
  readonly messaging: MessagingPolicy
  readonly posting: PostingPolicy
  readonly escrow: EscrowPolicy
  readonly may_stake: boolean
}

export interface DelegationCredential {
  readonly type: readonly ['VerifiableCredential', 'PraxisDelegation']
  readonly issuer: string // principal DID
  readonly subject: string // agent DID
  readonly policy: DelegationPolicy
  readonly issued: string
  readonly expires: string
  readonly revocation: string // kill-switch endpoint
  readonly sig: string
}

export const delegationIsExpired = (d: DelegationCredential, nowIso: string): boolean =>
  new Date(d.expires).getTime() <= new Date(nowIso).getTime()
