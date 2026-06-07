import type { Money } from './money'
import type { AcceptanceSpec } from './listing'
import Big from 'big.js'

// EscrowContract (§6.2) — locked funds + acceptance + stake, both-party signed.

export type EscrowState =
  | 'open' // funded, awaiting delivery
  | 'delivered' // at least one milestone delivered, awaiting acceptance
  | 'released' // all milestones released
  | 'disputed'
  | 'resolved'
  | 'refunded'
  | 'timed_out'

export type MilestoneState = 'pending' | 'delivered' | 'accepted' | 'rejected' | 'disputed' | 'released' | 'refunded'

export interface Milestone {
  readonly id: string
  readonly amount: string
  readonly acceptance: AcceptanceSpec
}

export interface DeliveredMilestone {
  readonly milestone_id: string
  readonly result_hash: string
  readonly result_schema_ref?: string
  readonly delivered_at: string
  readonly payload_sample?: unknown
}

export type OnTimeout = 'refund' | 'release' | 'arbitrate'

export interface ProviderStake {
  readonly amount: string
  readonly currency: string
  readonly slashable: boolean
}

export interface EscrowContract {
  readonly escrow_id: string
  readonly job_ref: string
  readonly payer: string
  readonly payee: string
  readonly amount: Money
  readonly milestones: readonly Milestone[]
  readonly deliver_by: string
  readonly on_timeout: OnTimeout
  readonly dispute_window_ms: number
  readonly provider_stake: ProviderStake
  readonly sig_payer: string
  readonly sig_payee: string
}

// Invariant: the milestone amounts must sum exactly to the escrow total.
export const milestonesSumToTotal = (e: EscrowContract): boolean => {
  const sum = e.milestones.reduce((acc, m) => acc.plus(m.amount), new Big(0))
  return sum.eq(e.amount.amount)
}
