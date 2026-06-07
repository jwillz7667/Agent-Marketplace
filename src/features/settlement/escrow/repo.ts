import type { EscrowContract, EscrowState, MilestoneState, Quote } from '../../../domain/index'
import type { PolicyAction } from '../../../shared/ports/index'

// Persistence ports owned by the escrow sub-feature. The factory builds the in-memory adapters by
// default; the container can swap Prisma-backed pairs without touching the service.

// Per-milestone runtime state layered over the immutable contract milestones. result_hash is the
// provider-delivered checksum; the deterministic acceptance check compares it to the milestone's
// declared acceptance.expected (§9.5).
export interface MilestoneRuntime {
  state: MilestoneState
  resultHash: string | null
  deliveredAt: string | null
  resultSchemaRef: string | null
}

// A pending escalation to human/arbiter governance (§9.5): a subjective dispute or an arbitrate
// timeout whose ruling is held in the ApprovalPort. The exact (agent, action) tuple is the one that
// was enqueued, replayed verbatim to ApprovalPort.consume so the ruling is redeemed single-use and
// bound to precisely this escalation. The escrow sits in state 'disputed' until resolveEscalation
// consumes the ruling and settles directionally.
export interface EscrowEscalation {
  readonly approvalId: string
  readonly kind: 'dispute' | 'timeout'
  readonly agent: string
  readonly action: PolicyAction
  // Milestones whose holds this ruling settles (one for a dispute; all-pending for a timeout).
  readonly milestoneIds: string[]
  // The disputing DID (set for 'dispute'; null for 'timeout').
  readonly disputer: string | null
}

// A persisted escrow: the signed contract, runtime state, the holds that lock the payer funds and
// (optionally) the provider stake, and the bond a disputing party posts. The funds hold and stake
// hold are addressable so capture/release/forfeit can act on them precisely (§6.2, §9.5).
export interface EscrowRecord {
  readonly contract: EscrowContract
  state: EscrowState
  readonly milestones: Record<string, MilestoneRuntime>
  fundsHoldId: string | null // payer total locked here
  stakeHoldId: string | null // provider stake locked here (null if no stake)
  // Per-milestone hold ids carved from the funds: each milestone gets its own hold so it can be
  // captured/refunded independently. Keyed by milestone id.
  readonly milestoneHoldIds: Record<string, string>
  disputeBondHoldId: string | null // disputer's bond locked here while a dispute is open
  disputer: string | null // which DID opened the open dispute
  // The open escalation awaiting an arbiter/governance ruling (null when none). Set when a
  // subjective dispute or an arbitrate timeout parks; cleared by resolveEscalation.
  escalation: EscrowEscalation | null
  readonly createdAt: string
}

export interface EscrowRepo {
  get(escrowId: string): Promise<EscrowRecord | null>
  put(record: EscrowRecord): Promise<void>
  // Guard against re-opening an escrow under the same job_ref + the same contract id.
  getByJobRef(jobRef: string): Promise<EscrowRecord[]>
}

// Bound quotes referenced by an escrow handoff (§14.4 step 6). Stored so a settle can resolve the
// exact signed quote the negotiation agreed on.
export interface QuoteBindRepo {
  get(quoteId: string): Promise<Quote | null>
  put(quote: Quote): Promise<void>
}

// A bonded stake row tracking a DID's currently-locked stake hold and its amount. Used by /stake
// to back a listing/claim; the container reflects the running total to reputation via
// onStakeChanged.
export interface StakeRow {
  readonly stakeId: string
  readonly did: string
  readonly holdId: string
  readonly amount: string
  readonly currency: string
  state: 'bonded' | 'released' | 'slashed'
  readonly createdAt: string
}

export interface StakeRepo {
  get(stakeId: string): Promise<StakeRow | null>
  put(row: StakeRow): Promise<void>
  listByDid(did: string): Promise<StakeRow[]>
}
