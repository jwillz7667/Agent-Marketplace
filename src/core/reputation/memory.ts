import type { ReputationSnapshot } from '../../domain/index'
import { type AccumulatorRepo, type MetricsAccumulator, type SnapshotCacheRepo, emptyAccumulator } from './repo'

// In-memory adapters for the reputation persistence ports. State lives in Maps; no I/O.
// Single-process only — the container swaps these for a Prisma-backed set in production.
//
// The accumulator is mutable by design (it is an aggregate the service folds receipts
// into); the in-memory store hands back a deep-enough copy so a caller cannot mutate
// stored state except through put(), keeping the read-modify-write boundary explicit.

const cloneAccumulator = (acc: MetricsAccumulator): MetricsAccumulator => ({
  jobs: acc.jobs,
  successCredit: acc.successCredit,
  disputes: acc.disputes,
  refunds: acc.refunds,
  latencySamples: [...acc.latencySamples],
  settledValue: acc.settledValue,
  settledCurrency: acc.settledCurrency,
  firstSeen: acc.firstSeen,
  lastSettled: acc.lastSettled,
  counterparties: new Set(acc.counterparties),
  stake: acc.stake,
  spamFlags: acc.spamFlags,
  postFlags: acc.postFlags,
  ingestedReceipts: new Set(acc.ingestedReceipts),
})

export class MemoryAccumulatorRepo implements AccumulatorRepo {
  private readonly byDid = new Map<string, MetricsAccumulator>()

  async get(did: string): Promise<MetricsAccumulator | null> {
    const acc = this.byDid.get(did)
    return acc ? cloneAccumulator(acc) : null
  }

  async getOrCreate(did: string): Promise<MetricsAccumulator> {
    const existing = this.byDid.get(did)
    if (existing) return cloneAccumulator(existing)
    const fresh = emptyAccumulator()
    this.byDid.set(did, fresh)
    return cloneAccumulator(fresh)
  }

  async put(did: string, acc: MetricsAccumulator): Promise<void> {
    this.byDid.set(did, cloneAccumulator(acc))
  }
}

export class MemorySnapshotCacheRepo implements SnapshotCacheRepo {
  private readonly byDid = new Map<string, ReputationSnapshot>()

  async get(did: string): Promise<ReputationSnapshot | null> {
    return this.byDid.get(did) ?? null
  }

  async put(snapshot: ReputationSnapshot): Promise<void> {
    this.byDid.set(snapshot.subject, snapshot)
  }
}
