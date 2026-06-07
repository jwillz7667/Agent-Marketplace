import Big from 'big.js'
import type {
  AcceptanceSpec,
  EscrowContract,
  EscrowState,
  Milestone,
  Money,
  Receipt,
} from '../../../domain/index'
import {
  milestonesSumToTotal,
  newReceiptId,
  stripForSigning,
} from '../../../domain/index'
import { signDetached, verifyDetached } from '../../../shared/crypto/index'
import type {
  ApprovalPort,
  Clock,
  IdentityResolver,
  Ledger,
  NonceStore,
  PolicyAction,
  ReputationPort,
  WalletSigner,
} from '../../../shared/ports/index'
import { verifySignedObject } from '../../../shared/http/index'
import {
  AuthError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../shared/errors'
import type { CoreSigner } from '../core-signer'
import type { WalletService } from '../wallet/index'
import type {
  EscrowRecord,
  EscrowRepo,
  MilestoneRuntime,
  StakeRepo,
} from './repo'
import type { AcceptInput, DeliverInput, DisputeInput, OpenEscrowInput, ResolveEscalationInput } from './schema'

export interface EscrowServiceDeps {
  readonly clock: Clock
  readonly nonces: NonceStore
  readonly identity: IdentityResolver
  readonly signer: WalletSigner
  readonly ledger: Ledger
  readonly reputation: ReputationPort
  readonly approvals: ApprovalPort
  readonly wallet: WalletService
  readonly coreSigner: CoreSigner
  readonly escrows: EscrowRepo
  readonly stakes: StakeRepo
  readonly skewMs: number
}

export type EscrowMutation =
  | { kind: 'state'; record: PublicEscrowState }
  | { kind: 'needs_approval'; approvalId: string; threshold: Money; reasons: string[] }

export interface PublicEscrowState {
  readonly escrow_id: string
  readonly state: string
  readonly milestones: { id: string; state: string; result_hash: string | null }[]
}

// The contract sign-omit list: both parties sign the contract minus both sigs + the open-call
// envelope fields. Symmetric verification recomputes the same input. approval_id is omitted too: it
// is attached only on a re-submission after the principal clears an over-threshold commit, long
// after both parties co-signed, so it must not be part of the signed contract payload.
const CONTRACT_OMIT = ['sig_payer', 'sig_payee', 'nonce', 'iat', 'exp', 'approval_id'] as const
const RECEIPT_SIG_OMIT = ['facilitator_sig', 'payee_sig'] as const

// Escrow (§6.2, §14.4) + machine-to-machine dispute resolution (§9.5). Funds are locked before work
// starts; objective acceptance auto-releases with no human; disputes are deterministic-first with
// both-direction slashing; subjective/contested cases escalate to human governance (approvals).
export class EscrowService {
  private readonly envDeps: { identity: IdentityResolver; nonces: NonceStore; clock: Clock; skewMs: number }

  constructor(private readonly deps: EscrowServiceDeps) {
    this.envDeps = {
      identity: deps.identity,
      nonces: deps.nonces,
      clock: deps.clock,
      skewMs: deps.skewMs,
    }
  }

  // POST /escrow — open: verify both party signatures, validate milestone sums, enforce policy
  // (signer hard-stop, kind 'escrow'), then lock the payer funds (per-milestone holds) and the
  // provider stake. State → 'open' (funded, awaiting delivery).
  async open(input: OpenEscrowInput): Promise<EscrowMutation> {
    const contract = this.toContract(input)

    if (!milestonesSumToTotal(contract)) {
      throw new ValidationError('milestone amounts must sum exactly to the escrow total')
    }
    if (new Big(contract.amount.amount).lte(0)) {
      throw new ValidationError('escrow total must be positive')
    }

    const existing = await this.deps.escrows.get(contract.escrow_id)
    if (existing) throw new ConflictError(`escrow already exists: ${contract.escrow_id}`)

    // Verify the open-call envelope + payer signature over the contract, then the payee signature
    // over the same canonical input. Both parties co-sign to form the contract (§6.2).
    await verifySignedObject(this.envDeps, input as unknown as Record<string, unknown>, {
      signerDid: contract.payer,
      sigField: 'sig_payer',
      omitFields: CONTRACT_OMIT,
    })
    await this.verifyContractSig(contract, input, 'sig_payee', contract.payee)

    // §4.3 HARD STOP before any funds lock: the signer independently enforces the payer's commit
    // cap (kind 'escrow', amount = total). needs_approval → park; deny → forbidden. No funds move
    // until { ok: true }.
    const signed = await this.deps.signer.signWithinPolicy({
      did: contract.payer,
      payload: contract,
      action: { kind: 'escrow', agent: contract.payer, amount: contract.amount, counterparty: contract.payee },
      approvalId: input.approval_id,
    })
    if (!signed.ok) {
      return this.parkOrDeny(signed.decision, contract.payer, contract, {
        kind: 'escrow',
        agent: contract.payer,
        amount: contract.amount,
        counterparty: contract.payee,
      })
    }

    // Lock the payer's funds: one hold per milestone so each can be captured/refunded precisely.
    const milestoneHoldIds: Record<string, string> = {}
    const milestones: Record<string, MilestoneRuntime> = {}
    for (const m of contract.milestones) {
      const holdId = await this.deps.wallet.hold(
        contract.payer,
        { amount: m.amount, currency: contract.amount.currency },
        `escrow:${contract.escrow_id}:${m.id}`,
      )
      milestoneHoldIds[m.id] = holdId
      milestones[m.id] = { state: 'pending', resultHash: null, deliveredAt: null, resultSchemaRef: null }
    }

    // Lock the provider stake (slashable) so a proven misdelivery can forfeit it to the payer.
    let stakeHoldId: string | null = null
    if (contract.provider_stake.slashable && new Big(contract.provider_stake.amount).gt(0)) {
      stakeHoldId = await this.deps.wallet.hold(
        contract.payee,
        { amount: contract.provider_stake.amount, currency: contract.provider_stake.currency },
        `escrow-stake:${contract.escrow_id}`,
      )
    }

    const record: EscrowRecord = {
      contract,
      state: 'open',
      milestones,
      fundsHoldId: null,
      stakeHoldId,
      milestoneHoldIds,
      disputeBondHoldId: null,
      disputer: null,
      escalation: null,
      createdAt: this.deps.clock.now(),
    }
    await this.deps.escrows.put(record)
    await this.deps.ledger.append({ kind: 'escrow_open', subject: contract.escrow_id, payload: contract })

    return { kind: 'state', record: this.toPublic(record) }
  }

  // POST /escrow/:id/deliver — provider submits a milestone result_hash. Deterministic acceptance
  // (§9.5): a PURE-objective milestone (acceptance.type === 'checksum') is decided with no human —
  // a matching hash AUTO-ACCEPTS (capture to provider, release stake when fully done, delivered
  // receipt), a mismatch AUTO-REFUNDS to the payer (auto-refund-on-fail). A milestone with a
  // subjective component ('schema+checksum', 'schema', 'oracle') is marked 'delivered' awaiting the
  // payer's accept or a dispute — at dispute time the objective checksum (if declared) still
  // settles the case deterministically, while a purely subjective spec escalates to governance.
  async deliver(escrowId: string, input: DeliverInput): Promise<EscrowMutation> {
    const record = await this.requireOpenish(escrowId)
    const { contract } = record
    if (input.provider !== contract.payee) throw new ForbiddenError('only the provider may deliver')

    await verifySignedObject(this.envDeps, input as unknown as Record<string, unknown>, {
      signerDid: contract.payee,
    })

    const milestone = this.requireMilestone(contract, input.milestone_id)
    const runtime = record.milestones[input.milestone_id]!
    if (runtime.state === 'accepted' || runtime.state === 'released') {
      // Idempotent re-delivery does not create a second obligation (§6.2).
      return { kind: 'state', record: this.toPublic(record) }
    }

    runtime.resultHash = input.result_hash
    runtime.resultSchemaRef = input.result_schema_ref ?? null
    runtime.deliveredAt = this.deps.clock.now()
    runtime.state = 'delivered'

    // Only a PURE-objective milestone auto-settles on delivery; anything with a subjective
    // component waits for accept/dispute (leaving the deterministic dispute window open).
    if (milestone.acceptance.type === 'checksum') {
      const objective = this.objectivePass(milestone.acceptance, input.result_hash)
      if (objective === 'pass') {
        await this.captureMilestone(record, milestone, 'delivered')
      } else if (objective === 'fail') {
        // Auto-refund-on-fail: the milestone settles against the payer immediately.
        await this.refundMilestone(record, milestone, 'refunded')
      }
    }

    this.recomputeEscrowState(record)
    await this.deps.escrows.put(record)
    return { kind: 'state', record: this.toPublic(record) }
  }

  // POST /escrow/:id/accept — payer accepts a delivered milestone → capture to provider.
  async accept(escrowId: string, input: AcceptInput): Promise<EscrowMutation> {
    const record = await this.requireOpenish(escrowId)
    const { contract } = record
    if (input.payer !== contract.payer) throw new ForbiddenError('only the payer may accept')

    await verifySignedObject(this.envDeps, input as unknown as Record<string, unknown>, {
      signerDid: contract.payer,
    })

    const milestone = this.requireMilestone(contract, input.milestone_id)
    const runtime = record.milestones[input.milestone_id]!
    if (runtime.state === 'accepted' || runtime.state === 'released') {
      return { kind: 'state', record: this.toPublic(record) }
    }
    if (runtime.state !== 'delivered') {
      throw new ConflictError(`milestone ${input.milestone_id} is not awaiting acceptance (state=${runtime.state})`)
    }

    await this.captureMilestone(record, milestone, 'delivered')
    this.recomputeEscrowState(record)
    await this.deps.escrows.put(record)
    return { kind: 'state', record: this.toPublic(record) }
  }

  // POST /escrow/:id/dispute — deterministic-first, escalation-second, both-direction slashing
  // (§9.5). Within the dispute window:
  //  - objective acceptance + delivered hash MATCHES → the dispute is griefing → resolve FOR the
  //    provider (capture the milestone) and slash the disputer's bond → reputation penalty to the
  //    disputer.
  //  - objective acceptance + hash FAILS → resolve FOR the requester (refund the milestone) and
  //    forfeit the provider's stake to the payer → disputed/refunded receipt to reputation.
  //  - subjective / contested → escalate to human governance (approvals); park, do not auto-resolve.
  async dispute(escrowId: string, input: DisputeInput): Promise<EscrowMutation> {
    const record = await this.requireOpenish(escrowId)
    const { contract } = record
    if (input.disputer !== contract.payer && input.disputer !== contract.payee) {
      throw new ForbiddenError('only a party to the escrow may dispute')
    }

    await verifySignedObject(this.envDeps, input as unknown as Record<string, unknown>, {
      signerDid: input.disputer,
    })

    const milestone = this.requireMilestone(contract, input.milestone_id)
    const runtime = record.milestones[input.milestone_id]!
    if (runtime.state === 'accepted' || runtime.state === 'released' || runtime.state === 'refunded') {
      throw new ConflictError(`milestone ${input.milestone_id} is already settled (state=${runtime.state})`)
    }

    // Dispute window enforcement: a dispute must arrive within dispute_window_ms of delivery (or of
    // open if nothing was delivered yet — a no-delivery dispute is allowed until the window from
    // deliver_by elapses).
    this.assertWithinDisputeWindow(record, runtime)

    // The disputer may post a bond; lock it so griefing can slash it.
    if (input.bond) {
      record.disputeBondHoldId = await this.deps.wallet.hold(
        input.disputer,
        input.bond,
        `dispute-bond:${contract.escrow_id}:${milestone.id}`,
      )
    }
    record.state = 'disputed'
    record.disputer = input.disputer
    runtime.state = 'disputed'

    const objective = runtime.resultHash !== null ? this.objectivePass(milestone.acceptance, runtime.resultHash) : 'subjective'

    if (objective === 'subjective') {
      // Contested / subjective → escalate to human governance. Funds stay locked; no auto-resolve.
      // The escrow stays in 'disputed' (set above) so requireOpenish blocks any further party action
      // until resolveEscalation redeems the arbiter ruling. The action is captured verbatim so the
      // single-use consume() at resolve time binds to exactly this escalation.
      const action: PolicyAction = {
        kind: 'escrow',
        agent: input.disputer,
        amount: { amount: milestone.amount, currency: contract.amount.currency },
        counterparty: this.otherParty(contract, input.disputer),
      }
      const pending = await this.deps.approvals.enqueue({
        agent: input.disputer,
        action,
        payload: { escrow_id: contract.escrow_id, milestone_id: milestone.id, reason_code: input.reason_code, result_hash: runtime.resultHash },
      })
      record.escalation = {
        approvalId: pending.approvalId,
        kind: 'dispute',
        agent: input.disputer,
        action,
        milestoneIds: [milestone.id],
        disputer: input.disputer,
      }
      await this.deps.escrows.put(record)
      await this.deps.ledger.append({
        kind: 'escrow_dispute_escalated',
        subject: contract.escrow_id,
        payload: { milestone_id: milestone.id, disputer: input.disputer, approval_id: pending.approvalId },
      })
      return { kind: 'needs_approval', approvalId: pending.approvalId, threshold: { amount: milestone.amount, currency: contract.amount.currency }, reasons: ['subjective acceptance requires arbiter ruling'] }
    }

    if (objective === 'pass') {
      // Griefing: the delivery objectively passes, so the dispute is frivolous. Pay the provider,
      // slash the disputer's bond (forfeit to the provider as compensation), penalize the disputer.
      await this.captureMilestone(record, milestone, 'delivered')
      if (record.disputeBondHoldId) {
        await this.deps.wallet.forfeit(record.disputeBondHoldId, { toRecipient: contract.payee, burnFraction: 0 })
        record.disputeBondHoldId = null
      }
      await this.deps.reputation.ingestSignal(input.disputer, 'frivolous_dispute', 1)
      await this.deps.ledger.append({
        kind: 'escrow_dispute_resolved',
        subject: contract.escrow_id,
        payload: { milestone_id: milestone.id, ruling: 'for_provider', slashed: 'disputer_bond' },
      })
    } else {
      // objective === 'fail' → misdelivery. Slash the provider's stake to the payer proportional to
      // this milestone's share BEFORE refunding: the slash nulls stakeHoldId, so the refund's
      // stake-settlement check correctly treats the stake as forfeited (not returned). Reversing the
      // order would let a final-milestone refund release the stake to the provider before the slash.
      await this.slashProviderStake(record, milestone)
      await this.refundMilestone(record, milestone, 'disputed')
      if (record.disputeBondHoldId) {
        // The disputer was right; return their bond.
        await this.deps.wallet.release(record.disputeBondHoldId)
        record.disputeBondHoldId = null
      }
      await this.deps.ledger.append({
        kind: 'escrow_dispute_resolved',
        subject: contract.escrow_id,
        payload: { milestone_id: milestone.id, ruling: 'for_requester', slashed: 'provider_stake' },
      })
    }

    record.state = 'resolved'
    record.disputer = null
    this.recomputeEscrowState(record)
    await this.deps.escrows.put(record)
    return { kind: 'state', record: this.toPublic(record) }
  }

  // Apply the on_timeout policy after deliver_by has elapsed for any still-pending milestones
  // (§6.2). refund → return funds to payer + release stake; release → capture to provider;
  // arbitrate → escalate to human governance. Exposed for a scheduler/route to drive.
  async onTimeout(escrowId: string): Promise<EscrowMutation> {
    const record = await this.requireOpenish(escrowId)
    const { contract } = record
    const nowMs = this.deps.clock.nowMs()
    if (nowMs < new Date(contract.deliver_by).getTime()) {
      throw new ConflictError('deliver_by has not yet elapsed')
    }

    const pending = contract.milestones.filter((m) => {
      const s = record.milestones[m.id]!.state
      return s === 'pending' || s === 'delivered'
    })

    if (contract.on_timeout === 'arbitrate') {
      const action: PolicyAction = {
        kind: 'escrow',
        agent: contract.payer,
        amount: contract.amount,
        counterparty: contract.payee,
      }
      const apr = await this.deps.approvals.enqueue({
        agent: contract.payer,
        action,
        payload: { escrow_id: contract.escrow_id, reason: 'timeout_arbitrate', pending: pending.map((m) => m.id) },
      })
      // Move to 'disputed' (= "escalated, awaiting ruling") so requireOpenish blocks a second
      // onTimeout/deliver/accept from re-acting on the still-held milestones until resolveEscalation
      // redeems the ruling. Without this the escrow stayed 'open' and the holds could be double-acted.
      record.state = 'disputed'
      record.escalation = {
        approvalId: apr.approvalId,
        kind: 'timeout',
        agent: contract.payer,
        action,
        milestoneIds: pending.map((m) => m.id),
        disputer: null,
      }
      await this.deps.escrows.put(record)
      await this.deps.ledger.append({
        kind: 'escrow_timeout_escalated',
        subject: contract.escrow_id,
        payload: { approval_id: apr.approvalId, pending: pending.map((m) => m.id) },
      })
      return { kind: 'needs_approval', approvalId: apr.approvalId, threshold: contract.amount, reasons: ['timeout → arbitration'] }
    }

    for (const m of pending) {
      if (contract.on_timeout === 'refund') {
        await this.refundMilestone(record, m, 'refunded')
      } else {
        await this.captureMilestone(record, m, 'delivered')
      }
    }
    // No explicit stake release here: refundMilestone/captureMilestone each call maybeReleaseStake,
    // which returns the (un-slashed) stake exactly once the final milestone settles — covering BOTH
    // the refund and release timeout outcomes. A clean timeout never slashes, so the stake is owed
    // back to the provider.
    record.state = 'timed_out'
    this.recomputeEscrowState(record)
    await this.deps.escrows.put(record)
    return { kind: 'state', record: this.toPublic(record) }
  }

  // POST /escrow/:id/resolve — settle an escalated escrow (subjective dispute or arbitrate timeout)
  // once human/arbiter governance has ruled (§9.5). Either party triggers this; the OUTCOME is fixed
  // by the governance ruling held in the ApprovalPort, NOT by the caller. The ruling is redeemed
  // single-use and bound to the exact action enqueued at escalation time, so it cannot be replayed
  // to settle a second escrow or re-settle this one. Without this path an escalated escrow would lock
  // its funds forever (the previous behavior).
  async resolveEscalation(escrowId: string, input: ResolveEscalationInput): Promise<EscrowMutation> {
    // Direct fetch: an escalated escrow sits in 'disputed', which requireOpenish deliberately blocks.
    const record = await this.deps.escrows.get(escrowId)
    if (!record) throw new NotFoundError(`escrow not found: ${escrowId}`)
    const escalation = record.escalation
    if (!escalation || record.state !== 'disputed') {
      throw new ConflictError(`escrow ${escrowId} has no open escalation to resolve (state=${record.state})`)
    }
    const { contract } = record

    if (input.caller !== contract.payer && input.caller !== contract.payee) {
      throw new ForbiddenError('only a party to the escrow may trigger resolution')
    }
    // The caller's signature authenticates the trigger (replay-protected); it does NOT decide the
    // outcome — the governance ruling does.
    await verifySignedObject(this.envDeps, input as unknown as Record<string, unknown>, {
      signerDid: input.caller,
    })

    // Redeem the ruling. consume() throws if the approval is still pending (governance has not ruled
    // yet → 409), already consumed (a second resolve → 409), or does not match the escalation's
    // agent+action — making the clearance single-use and non-transferable.
    const redeemed = await this.deps.approvals.consume(escalation.approvalId, {
      agent: escalation.agent,
      action: escalation.action,
    })
    const upheld = redeemed.decision === 'approved'

    if (escalation.kind === 'dispute') {
      await this.settleDisputeEscalation(record, escalation, upheld)
      record.state = 'resolved'
    } else {
      await this.settleTimeoutEscalation(record, escalation, upheld)
      record.state = 'timed_out'
    }

    record.disputer = null
    record.escalation = null
    await this.deps.escrows.put(record)
    await this.deps.ledger.append({
      kind: 'escrow_escalation_resolved',
      subject: contract.escrow_id,
      payload: { kind: escalation.kind, ruling: upheld ? 'upheld' : 'rejected', approval_id: escalation.approvalId },
    })
    return { kind: 'state', record: this.toPublic(record) }
  }

  // ---- internals --------------------------------------------------------

  // Capture a milestone's locked funds to the provider and ingest a receipt with the given outcome.
  private async captureMilestone(record: EscrowRecord, milestone: Milestone, outcome: Receipt['outcome']): Promise<void> {
    const holdId = record.milestoneHoldIds[milestone.id]
    if (!holdId) throw new ConflictError(`no funds hold for milestone ${milestone.id}`)
    const runtime = record.milestones[milestone.id]!
    if (runtime.state === 'released' || runtime.state === 'accepted') return

    await this.deps.wallet.capture(holdId, record.contract.payee)
    runtime.state = 'released'
    await this.deps.wallet.recordSpend(record.contract.payer, { amount: milestone.amount, currency: record.contract.amount.currency })
    await this.issueReceipt(record, milestone, outcome)
    await this.maybeReleaseStake(record)
  }

  // Refund a milestone's locked funds back to the payer (release the hold) and ingest a receipt.
  private async refundMilestone(record: EscrowRecord, milestone: Milestone, outcome: Receipt['outcome']): Promise<void> {
    const holdId = record.milestoneHoldIds[milestone.id]
    if (!holdId) throw new ConflictError(`no funds hold for milestone ${milestone.id}`)
    const runtime = record.milestones[milestone.id]!
    if (runtime.state === 'refunded') return

    await this.deps.wallet.release(holdId)
    runtime.state = 'refunded'
    await this.issueReceipt(record, milestone, outcome)
    // A refund can complete the milestone set just as a capture can; settle the stake here too so an
    // all-refunded escrow returns the (un-slashed) stake instead of stranding it. In the dispute path
    // the stake is slashed BEFORE the refund, so stakeHoldId is already null and this is a no-op.
    await this.maybeReleaseStake(record)
  }

  // Slash the provider's stake to the payer, proportional to the defected milestone's share of the
  // total. The remaining stake (for unaffected milestones) stays held until the escrow resolves.
  private async slashProviderStake(record: EscrowRecord, milestone: Milestone): Promise<void> {
    if (!record.stakeHoldId) return
    const total = new Big(record.contract.amount.amount)
    const share = total.eq(0) ? new Big(0) : new Big(milestone.amount).div(total)
    // burnFraction is the portion NOT sent to the payer; we send the proportional slash to the
    // payer and keep the rest of the stake by burning none — but the hold is single-shot, so we
    // forfeit the WHOLE stake hold, sending the milestone-proportional amount to the payer and
    // burning the remainder. For a single-milestone escrow this sends the full stake to the payer.
    const burnFraction = Math.max(0, Math.min(1, 1 - Number(share.toFixed(6))))
    await this.deps.wallet.forfeit(record.stakeHoldId, { toRecipient: record.contract.payer, burnFraction })
    record.stakeHoldId = null
  }

  // Release the provider stake once every milestone has settled — UNLESS it was slashed.
  // slashProviderStake forfeits the hold and nulls stakeHoldId, so reaching full settlement with a
  // still-held stake (stakeHoldId !== null) proves no slash occurred and the stake must be returned
  // to the provider. A benign refund (timeout/refund-on-fail with no proven misdelivery) must NOT
  // strand the stake: it is the provider's collateral and is owed back when no defect was proven.
  private async maybeReleaseStake(record: EscrowRecord): Promise<void> {
    if (!record.stakeHoldId) return
    const allSettled = record.contract.milestones.every((m) => {
      const s = record.milestones[m.id]!.state
      return s === 'released' || s === 'refunded'
    })
    if (allSettled) {
      await this.deps.wallet.release(record.stakeHoldId)
      record.stakeHoldId = null
    }
  }

  // Settle a subjective-dispute escalation per the arbiter ruling. `upheld` = ruled FOR the disputer;
  // `!upheld` = ruled AGAINST (for the other party). The winner of the disputed milestone:
  //   - provider wins → capture the milestone to the provider; the stake returns (no proven defect).
  //   - payer wins     → slash the provider stake (proven misdelivery) THEN refund the milestone.
  // The disputer's bond is returned if their claim was upheld, else forfeited to the other party
  // (griefing) with a reputation penalty. Any OTHER still-pending milestones refund to the payer so
  // their holds are not stranded when the escrow finalizes.
  private async settleDisputeEscalation(
    record: EscrowRecord,
    escalation: { milestoneIds: string[]; disputer: string | null },
    upheld: boolean,
  ): Promise<void> {
    const { contract } = record
    const disputer = escalation.disputer
    if (disputer === null) throw new ConflictError('dispute escalation missing disputer')
    const milestoneId = escalation.milestoneIds[0]
    if (milestoneId === undefined) throw new ConflictError('dispute escalation missing milestone')
    const milestone = this.requireMilestone(contract, milestoneId)

    const winner = upheld ? disputer : this.otherParty(contract, disputer)
    const winnerIsProvider = winner === contract.payee

    if (winnerIsProvider) {
      await this.captureMilestone(record, milestone, 'delivered')
    } else {
      // Slash BEFORE refund so the refund's stake-settlement check treats the stake as forfeited
      // (the slash nulls stakeHoldId), exactly as the synchronous dispute path does.
      await this.slashProviderStake(record, milestone)
      await this.refundMilestone(record, milestone, 'disputed')
    }

    if (record.disputeBondHoldId) {
      if (upheld) {
        await this.deps.wallet.release(record.disputeBondHoldId)
      } else {
        await this.deps.wallet.forfeit(record.disputeBondHoldId, {
          toRecipient: this.otherParty(contract, disputer),
          burnFraction: 0,
        })
        await this.deps.reputation.ingestSignal(disputer, 'frivolous_dispute', 1)
      }
      record.disputeBondHoldId = null
    }

    await this.refundRemainingPending(record, milestoneId)
  }

  // Settle an arbitrate-timeout escalation per the arbiter ruling. `upheld` (approved) → release the
  // pending work to the provider; `!upheld` (denied) → refund the pending work to the payer. A
  // timeout is not a proven misdelivery, so the stake is never slashed — maybeReleaseStake returns it
  // once the final milestone settles. A defensive sweep refunds anything still pending afterward.
  private async settleTimeoutEscalation(
    record: EscrowRecord,
    escalation: { milestoneIds: string[] },
    upheld: boolean,
  ): Promise<void> {
    const { contract } = record
    for (const mid of escalation.milestoneIds) {
      const runtime = record.milestones[mid]
      if (!runtime) continue
      if (runtime.state !== 'pending' && runtime.state !== 'delivered') continue
      const milestone = this.requireMilestone(contract, mid)
      if (upheld) {
        await this.captureMilestone(record, milestone, 'delivered')
      } else {
        await this.refundMilestone(record, milestone, 'refunded')
      }
    }
    await this.refundRemainingPending(record)
  }

  // Refund (release the payer hold of) every still-pending/delivered milestone except `exceptId`, so
  // an escrow that finalizes via escalation does not strand the holds of milestones the ruling did
  // not directly settle.
  private async refundRemainingPending(record: EscrowRecord, exceptId?: string): Promise<void> {
    for (const m of record.contract.milestones) {
      if (m.id === exceptId) continue
      const runtime = record.milestones[m.id]!
      if (runtime.state === 'pending' || runtime.state === 'delivered') {
        await this.refundMilestone(record, m, 'refunded')
      }
    }
  }

  // Build + sign a §11 Receipt for a milestone settlement, append it to the ledger, and ingest it
  // into reputation. result_hash binds the receipt to the delivered milestone result (or, on a
  // refund where nothing valid was delivered, the milestone's expected/declared checksum).
  private async issueReceipt(record: EscrowRecord, milestone: Milestone, outcome: Receipt['outcome']): Promise<void> {
    const runtime = record.milestones[milestone.id]!
    const resultHash =
      runtime.resultHash ?? milestone.acceptance.expected ?? `sha256:${milestone.id}`
    const unsigned: Omit<Receipt, 'facilitator_sig' | 'payee_sig'> = {
      receipt_id: newReceiptId(),
      quote_id: null,
      listing_id: null,
      listing_version: null,
      job_ref: record.contract.job_ref,
      payer: record.contract.payer,
      payee: record.contract.payee,
      amount: { amount: milestone.amount, currency: record.contract.amount.currency },
      rail: 'escrow',
      result_hash: resultHash,
      latency_ms: 0,
      outcome,
      settled_at: this.deps.clock.now(),
    }
    const facilitatorSig = await signDetached(unsigned, this.deps.coreSigner.privateKey, this.deps.coreSigner.kid)
    const receipt: Receipt = { ...unsigned, facilitator_sig: facilitatorSig, payee_sig: '' }
    await this.deps.ledger.append({ kind: 'receipt', subject: record.contract.payee, payload: receipt })
    await this.deps.reputation.ingestReceipt(receipt)
  }

  // Deterministic objective-acceptance check (§9.5). Returns 'pass'/'fail' for objective specs
  // (checksum / schema+checksum with a declared expected), 'subjective' otherwise (schema-only or
  // oracle, which require human/arbiter judgement). A delivered hash equal to the declared expected
  // checksum is an objective pass; any other value is an objective fail.
  private objectivePass(acceptance: AcceptanceSpec, deliveredHash: string): 'pass' | 'fail' | 'subjective' {
    const hasExpected = typeof acceptance.expected === 'string' && acceptance.expected.length > 0
    if ((acceptance.type === 'checksum' || acceptance.type === 'schema+checksum') && hasExpected) {
      return deliveredHash === acceptance.expected ? 'pass' : 'fail'
    }
    // schema-only validation and oracle are not decidable from a hash alone here.
    return 'subjective'
  }

  private assertWithinDisputeWindow(record: EscrowRecord, runtime: MilestoneRuntime): void {
    const nowMs = this.deps.clock.nowMs()
    const window = record.contract.dispute_window_ms
    const anchorIso = runtime.deliveredAt ?? record.createdAt
    const anchorMs = new Date(anchorIso).getTime()
    if (nowMs > anchorMs + window) {
      throw new ConflictError('dispute window has closed for this milestone')
    }
  }

  private recomputeEscrowState(record: EscrowRecord): void {
    const states = record.contract.milestones.map((m) => record.milestones[m.id]!.state)
    if (states.every((s) => s === 'released')) {
      record.state = 'released'
    } else if (states.every((s) => s === 'released' || s === 'refunded')) {
      record.state = states.some((s) => s === 'refunded') ? 'resolved' : 'released'
    }
  }

  // States in which no further party action (deliver / accept / dispute / timeout) is admissible:
  // the four terminal outcomes, plus 'disputed' — an escalation awaiting an arbiter ruling, which
  // is settled ONLY via resolveEscalation (it fetches the record directly, bypassing this guard).
  // Admitting any of these would let a settled escrow be re-delivered, re-disputed, or re-timed-out,
  // double-acting on already-captured/refunded holds (§6.2).
  private static readonly NON_ACTIONABLE: ReadonlySet<EscrowState> = new Set<EscrowState>([
    'released',
    'refunded',
    'resolved',
    'timed_out',
    'disputed',
  ])

  private async requireOpenish(escrowId: string): Promise<EscrowRecord> {
    const record = await this.deps.escrows.get(escrowId)
    if (!record) throw new NotFoundError(`escrow not found: ${escrowId}`)
    if (EscrowService.NON_ACTIONABLE.has(record.state)) {
      throw new ConflictError(`escrow ${escrowId} is not open for this action (state=${record.state})`)
    }
    return record
  }

  private requireMilestone(contract: EscrowContract, milestoneId: string): Milestone {
    const m = contract.milestones.find((x) => x.id === milestoneId)
    if (!m) throw new NotFoundError(`milestone not found: ${milestoneId}`)
    return m
  }

  private otherParty(contract: EscrowContract, did: string): string {
    return did === contract.payer ? contract.payee : contract.payer
  }

  private async verifyContractSig(
    contract: EscrowContract,
    input: OpenEscrowInput,
    sigField: 'sig_payer' | 'sig_payee',
    signerDid: string,
  ): Promise<void> {
    const key = await this.deps.identity.publicKeyFor(signerDid)
    if (!key) throw new AuthError(`no public key for ${signerDid}`)
    const payload = stripForSigning(input as unknown as Record<string, unknown>, CONTRACT_OMIT)
    const sig = input[sigField]
    const valid = await verifyDetached(payload, sig, key)
    if (!valid) throw new AuthError(`escrow ${sigField} signature verification failed`)
  }

  private parkOrDeny(
    decision: { result: 'deny'; reasons: string[] } | { result: 'needs_approval'; threshold: Money; reasons: string[] } | { result: 'allow' },
    agent: string,
    payload: unknown,
    action: { kind: 'escrow'; agent: string; amount: Money; counterparty: string },
  ): EscrowMutation | Promise<EscrowMutation> {
    if (decision.result === 'needs_approval') {
      return this.deps.approvals
        .enqueue({ agent, action, payload })
        .then((pending) => ({
          kind: 'needs_approval' as const,
          approvalId: pending.approvalId,
          threshold: decision.threshold,
          reasons: decision.reasons,
        }))
    }
    throw new ForbiddenError('escrow refused by signer policy', {
      details: { reasons: decision.result === 'deny' ? decision.reasons : [] },
    })
  }

  private toContract(input: OpenEscrowInput): EscrowContract {
    return {
      escrow_id: input.escrow_id,
      job_ref: input.job_ref,
      payer: input.payer,
      payee: input.payee,
      amount: input.amount,
      milestones: input.milestones.map((m) => ({ id: m.id, amount: m.amount, acceptance: m.acceptance })),
      deliver_by: input.deliver_by,
      on_timeout: input.on_timeout,
      dispute_window_ms: input.dispute_window_ms,
      provider_stake: input.provider_stake,
      sig_payer: input.sig_payer,
      sig_payee: input.sig_payee,
    }
  }

  private toPublic(record: EscrowRecord): PublicEscrowState {
    return {
      escrow_id: record.contract.escrow_id,
      state: record.state,
      milestones: record.contract.milestones.map((m) => ({
        id: m.id,
        state: record.milestones[m.id]!.state,
        result_hash: record.milestones[m.id]!.resultHash,
      })),
    }
  }
}

export { CONTRACT_OMIT, RECEIPT_SIG_OMIT }
