import Big from 'big.js'
import {
  type Receipt,
  type ReputationMetrics,
  type ReputationSnapshot,
  computeTrust,
  newReputationId,
  stripForSigning,
} from '../../domain/index'
import { signDetached } from '../../shared/crypto/index'
import { ValidationError } from '../../shared/errors'
import type { Clock, ReputationPort } from '../../shared/ports/index'
import {
  type AccumulatorRepo,
  type MetricsAccumulator,
  type SnapshotCacheRepo,
  metricsFromAccumulator,
} from './repo'

// Core signing identity injected by the container. The reputation engine signs every
// ReputationSnapshot with this key so any counterparty can verify the snapshot came from
// did:praxis:core:reputation and recompute `trust` from the embedded raw metrics (§9.2).
export interface CoreSigner {
  readonly did: string
  readonly kid: string
  readonly privateKey: Uint8Array
  readonly publicKey: Uint8Array
}

export interface ReputationDeps {
  readonly clock: Clock
  readonly coreSigner: CoreSigner
  readonly accumulators: AccumulatorRepo
  readonly snapshots: SnapshotCacheRepo
}

const WINDOW = '30d'
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000 // snapshots expire 24h after issue (§9.2)

// Implements ReputationPort and exposes the externally-driven stake setter. Reputation is
// measured from SETTLED receipts and observed cross-surface signals only — never reviewed,
// never self-reported, no stars, no free text (§9, §9.2).
export class ReputationService implements ReputationPort {
  constructor(private readonly deps: ReputationDeps) {}

  // Fold one settled Receipt into the payee's accumulator. Idempotent on receipt_id so a
  // retried/duplicate delivery never double-counts. Only SETTLED receipts are accepted —
  // a Receipt object IS the settled record (§11), so its existence is the settlement proof.
  async ingestReceipt(receipt: Receipt): Promise<void> {
    const subject = receipt.payee
    if (subject.length === 0) throw new ValidationError('receipt.payee is required')
    if (receipt.payer.length === 0) throw new ValidationError('receipt.payer is required')

    const acc = await this.deps.accumulators.getOrCreate(subject)
    if (acc.ingestedReceipts.has(receipt.receipt_id)) return // already folded — no-op

    acc.ingestedReceipts.add(receipt.receipt_id)
    acc.jobs += 1
    acc.counterparties.add(receipt.payer)

    if (Number.isFinite(receipt.latency_ms) && receipt.latency_ms >= 0) {
      acc.latencySamples.push(receipt.latency_ms)
    }

    // Outcome → metric mapping (§9.1). Every outcome counts toward `jobs` (the denominator
    // for success/dispute/refund rate); only the credit differs.
    switch (receipt.outcome) {
      case 'delivered':
        acc.successCredit += 1
        break
      case 'partial':
        // Half-credit success — partial delivery is neither a clean success nor a failure.
        acc.successCredit += 0.5
        break
      case 'refunded':
        acc.refunds += 1
        break
      case 'disputed':
        acc.disputes += 1
        break
    }

    // settled_value accumulates only on outcomes where value actually moved to the payee.
    // A full refund returns the funds, so it contributes nothing to settled value.
    if (receipt.outcome !== 'refunded') {
      acc.settledValue = this.addValue(acc, receipt.amount.amount, receipt.amount.currency)
    }

    acc.firstSeen = earliest(acc.firstSeen, receipt.settled_at)
    acc.lastSettled = latest(acc.lastSettled, receipt.settled_at)

    await this.deps.accumulators.put(subject, acc)
    // Recompute + re-issue the signed snapshot so the cached trust reflects this receipt.
    await this.issueSnapshot(subject, acc)
  }

  // Fold a cross-surface signal (§9.3): board/messaging abuse degrades the SAME DID's
  // standing, so a spammer's service ranking drops. weight lets callers escalate repeat abuse.
  async ingestSignal(did: string, kind: string, weight: number): Promise<void> {
    if (did.length === 0) throw new ValidationError('did is required')
    if (!Number.isFinite(weight) || weight < 0) throw new ValidationError('signal weight must be a non-negative number')

    const acc = await this.deps.accumulators.getOrCreate(did)
    switch (kind) {
      case 'message_spam':
        acc.spamFlags += weight
        break
      case 'post_flag':
        acc.postFlags += weight
        break
      case 'frivolous_dispute':
        // §9.5 both-direction slashing: a requester who disputes an objectively-good delivery in
        // bad faith is penalized cross-surface. There is no dedicated frivolous-dispute metric in
        // the (frozen) domain ReputationMetrics, so we fold it into post_flags — the existing
        // abuse-penalty channel that degrades `trust` via computeTrust's flagFactor. This keeps the
        // griefer's standing falling on the same DID, exactly like board/message abuse (§9.3).
        acc.postFlags += weight
        break
      default:
        throw new ValidationError(`unknown reputation signal kind: ${kind}`)
    }

    await this.deps.accumulators.put(did, acc)
    await this.issueSnapshot(did, acc)
  }

  // Raw metrics so an agent can independently recompute `trust` with the public formula.
  // Null when the subject is unknown (no receipts, no signals, no stake).
  async getRaw(did: string): Promise<ReputationMetrics | null> {
    const acc = await this.deps.accumulators.get(did)
    if (!acc) return null
    return metricsFromAccumulator(acc)
  }

  // Latest signed snapshot. Re-issues if the cached one is missing or expired so the
  // returned trust is never stale. Null when the subject is unknown.
  async getSnapshot(did: string): Promise<ReputationSnapshot | null> {
    const acc = await this.deps.accumulators.get(did)
    if (!acc) return null

    const cached = await this.deps.snapshots.get(did)
    if (cached && !this.isExpired(cached)) return cached

    return this.issueSnapshot(did, acc)
  }

  // Externally-driven stake (§4.3, §9.1): settlement calls this when stake is bonded or
  // slashed. Stake feeds computeTrust via stakeConfidence, so the snapshot is re-issued.
  async setStake(did: string, amount: string): Promise<void> {
    if (did.length === 0) throw new ValidationError('did is required')
    if (!isValidAmount(amount)) throw new ValidationError(`invalid stake amount: ${amount}`)

    const acc = await this.deps.accumulators.getOrCreate(did)
    acc.stake = new Big(amount).toString()
    await this.deps.accumulators.put(did, acc)
    await this.issueSnapshot(did, acc)
  }

  // Build, sign, cache, and return a fresh snapshot. Signed over the snapshot minus `['sig']`
  // (the §13 detached-JWS convention); `trust` is computed by the public formula so it is
  // recomputable from `metrics` by any verifier.
  private async issueSnapshot(subject: string, acc: MetricsAccumulator): Promise<ReputationSnapshot> {
    const metrics = metricsFromAccumulator(acc)
    const issued = this.deps.clock.now()
    const expires = new Date(this.deps.clock.nowMs() + SNAPSHOT_TTL_MS).toISOString()

    const unsigned = {
      snapshot_id: newReputationId(),
      subject,
      window: WINDOW,
      metrics,
      trust: computeTrust(metrics),
      issued,
      expires,
      issuer: this.deps.coreSigner.did,
    }

    const sig = await signDetached(
      stripForSigning(unsigned, ['sig']),
      this.deps.coreSigner.privateKey,
      this.deps.coreSigner.kid,
    )
    const snapshot: ReputationSnapshot = { ...unsigned, sig }
    await this.deps.snapshots.put(snapshot)
    return snapshot
  }

  private isExpired(snapshot: ReputationSnapshot): boolean {
    const expMs = new Date(snapshot.expires).getTime()
    return Number.isNaN(expMs) || expMs <= this.deps.clock.nowMs()
  }

  // Value accumulation through big.js so there is no float drift, with a currency guard.
  private addValue(acc: MetricsAccumulator, amount: string, currency: string): string {
    if (acc.settledCurrency === null) {
      acc.settledCurrency = currency
    } else if (acc.settledCurrency !== currency) {
      // Mixed-currency settled value cannot be summed coherently; reject loudly rather
      // than silently producing a meaningless total.
      throw new ValidationError(
        `settled-value currency mismatch for subject: ${acc.settledCurrency} vs ${currency}`,
      )
    }
    return new Big(acc.settledValue).plus(amount).toString()
  }
}

const earliest = (a: string | null, b: string): string => {
  if (a === null) return b
  return new Date(b).getTime() < new Date(a).getTime() ? b : a
}

const latest = (a: string | null, b: string): string => {
  if (a === null) return b
  return new Date(b).getTime() > new Date(a).getTime() ? b : a
}

const isValidAmount = (amount: string): boolean => {
  try {
    return new Big(amount).gte(0)
  } catch {
    return false
  }
}
