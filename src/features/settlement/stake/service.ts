import Big from 'big.js'
import type { Money } from '../../../domain/index'
import { newId, newStakeId } from '../../../domain/index'
import type {
  ApprovalPort,
  Clock,
  IdentityResolver,
  Ledger,
  NonceStore,
  PolicyAction,
  PolicyDecision,
  WalletSigner,
} from '../../../shared/ports/index'
import { verifySignedObject } from '../../../shared/http/index'
import { ForbiddenError } from '../../../shared/errors'
import type { WalletService } from '../wallet/index'
import type { StakeRepo, StakeRow } from '../escrow/repo'
import type { StakeInput, TipInput } from './schema'

export interface StakeServiceDeps {
  readonly clock: Clock
  readonly nonces: NonceStore
  readonly identity: IdentityResolver
  readonly signer: WalletSigner
  readonly ledger: Ledger
  readonly approvals: ApprovalPort
  readonly wallet: WalletService
  readonly stakes: StakeRepo
  readonly skewMs: number
  // Bound by the container to reputationService.setStake — setStake is not on ReputationPort, so
  // the running total of bonded stake is pushed through this injected callback (no-op if unbound).
  readonly onStakeChanged?: (did: string, total: string) => void
}

export interface NeedsApproval {
  readonly kind: 'needs_approval'
  readonly approvalId: string
  readonly threshold: Money
  readonly reasons: string[]
}

export type StakeOutcome = { kind: 'staked'; stake: StakeRow; totalBonded: Money } | NeedsApproval

export type TipOutcome =
  | { kind: 'tipped'; tipId: string; from: string; to: string; amount: Money; settledAt: string }
  | NeedsApproval

export class StakeService {
  private readonly envDeps: { identity: IdentityResolver; nonces: NonceStore; clock: Clock; skewMs: number }

  constructor(private readonly deps: StakeServiceDeps) {
    this.envDeps = {
      identity: deps.identity,
      nonces: deps.nonces,
      clock: deps.clock,
      skewMs: deps.skewMs,
    }
  }

  // POST /stake — bond slashable funds (§4.3). The signer gates with kind 'stake' (may_stake);
  // on approval the funds move available → held (the bond), tracked as a stake row in 'bonded'
  // state. The running bonded total is reflected to reputation via onStakeChanged.
  async stake(input: StakeInput): Promise<StakeOutcome> {
    await verifySignedObject(this.envDeps, input as unknown as Record<string, unknown>, { signerDid: input.agent })

    const action: PolicyAction = {
      kind: 'stake',
      agent: input.agent,
      amount: input.amount,
      counterparty: input.listing_ref,
    }
    const signed = await this.deps.signer.signWithinPolicy({
      did: input.agent,
      payload: input,
      action,
      approvalId: input.approval_id,
    })
    if (!signed.ok) return this.parkOrDeny(signed.decision, action, input)

    const holdId = await this.deps.wallet.hold(input.agent, input.amount, `stake:${input.agent}`)
    const row: StakeRow = {
      stakeId: newStakeId(),
      did: input.agent,
      holdId,
      amount: input.amount.amount,
      currency: input.amount.currency,
      state: 'bonded',
      createdAt: this.deps.clock.now(),
    }
    await this.deps.stakes.put(row)
    await this.deps.ledger.append({ kind: 'stake_bonded', subject: input.agent, payload: { stake_id: row.stakeId, amount: input.amount, listing_ref: input.listing_ref ?? null } })

    const totalBonded = await this.totalBonded(input.agent, input.amount.currency)
    this.deps.onStakeChanged?.(input.agent, totalBonded.amount)
    return { kind: 'staked', stake: row, totalBonded }
  }

  // POST /tip — voluntary extra value transfer agent→agent (§4.3), bounded by policy kind 'tip'.
  async tip(input: TipInput): Promise<TipOutcome> {
    await verifySignedObject(this.envDeps, input as unknown as Record<string, unknown>, { signerDid: input.from })

    const action: PolicyAction = {
      kind: 'tip',
      agent: input.from,
      amount: input.amount,
      counterparty: input.to,
    }
    const signed = await this.deps.signer.signWithinPolicy({
      did: input.from,
      payload: input,
      action,
      approvalId: input.approval_id,
    })
    if (!signed.ok) return this.parkOrDeny(signed.decision, action, input)

    const ref = `tip:${input.from}:${input.nonce}`
    // Direct internal transfer; debit throws PaymentRequiredError on insufficient funds.
    await this.deps.wallet.debit(input.from, input.amount, ref)
    await this.deps.wallet.credit(input.to, input.amount, ref)
    // A tip is a settled spend against the tipper's caps.
    await this.deps.wallet.recordSpend(input.from, input.amount)

    const tipId = newId('tip')
    const settledAt = this.deps.clock.now()
    await this.deps.ledger.append({ kind: 'tip', subject: input.to, payload: { tip_id: tipId, from: input.from, to: input.to, amount: input.amount } })
    return { kind: 'tipped', tipId, from: input.from, to: input.to, amount: input.amount, settledAt }
  }

  private async totalBonded(did: string, currency: string): Promise<Money> {
    const rows = await this.deps.stakes.listByDid(did)
    const total = rows
      .filter((r) => r.state === 'bonded' && r.currency === currency)
      .reduce((acc, r) => acc.plus(r.amount), new Big(0))
    return { amount: total.toString(), currency }
  }

  // Park (enqueue) or deny. The enqueued action is the EXACT PolicyAction the signer evaluated, so a
  // later re-submission with the resulting approval_id consumes a clearance that binds to precisely
  // this action (the consume matcher compares the full tuple, counterparty included).
  private async parkOrDeny(
    decision: PolicyDecision,
    action: PolicyAction,
    payload: unknown,
  ): Promise<NeedsApproval> {
    if (decision.result === 'needs_approval') {
      const pending = await this.deps.approvals.enqueue({ agent: action.agent, action, payload })
      return {
        kind: 'needs_approval',
        approvalId: pending.approvalId,
        threshold: decision.threshold,
        reasons: decision.reasons,
      }
    }
    throw new ForbiddenError(`${action.kind} refused by signer policy`, {
      details: { reasons: decision.result === 'deny' ? decision.reasons : [] },
    })
  }
}
