import type { ReputationMetrics, ReputationSnapshot } from '../../domain/index'

// Persistence ports for the reputation module (§9). The factory constructs the
// in-memory adapters (memory.ts) by default; a Prisma adapter can be slotted in
// later without touching the service. All reads are point lookups keyed by subject DID.

// Mutable accumulator state behind a subject's ReputationMetrics. Metrics are a pure
// projection of this accumulator, so the raw signals stay separable from the published
// shape and an adapter only has to persist the accumulator, not recompute trust.
export interface MetricsAccumulator {
  jobs: number
  // Success credit is fractional: 'partial' outcomes count as half a success (§9.1).
  successCredit: number
  disputes: number
  refunds: number
  // Sorted-on-read latency samples (ms) used to recompute p50/p95.
  latencySamples: number[]
  settledValue: string
  settledCurrency: string | null
  firstSeen: string | null
  lastSettled: string | null
  // Distinct counterparties (payers) — the anti-wash diversity signal (§15.2).
  counterparties: Set<string>
  stake: string
  spamFlags: number
  postFlags: number
  // Idempotency: receipt_ids already folded in, so a re-ingested receipt is a no-op.
  ingestedReceipts: Set<string>
}

export interface AccumulatorRepo {
  get(did: string): Promise<MetricsAccumulator | null>
  // Read-modify-write: returns the current accumulator (creating an empty one if absent)
  // so the service mutates and persists in a single logical step.
  getOrCreate(did: string): Promise<MetricsAccumulator>
  put(did: string, acc: MetricsAccumulator): Promise<void>
}

// Cache of the last issued, signed snapshot per subject. The service re-issues when a
// cached snapshot has expired or when none exists; this is a cache, not the source of truth.
export interface SnapshotCacheRepo {
  get(did: string): Promise<ReputationSnapshot | null>
  put(snapshot: ReputationSnapshot): Promise<void>
}

// Pure projection: accumulator → published ReputationMetrics. Kept here (not in the
// service) so both adapters and tests can derive metrics identically.
export const metricsFromAccumulator = (acc: MetricsAccumulator): ReputationMetrics => {
  const jobs = acc.jobs
  const successRate = jobs === 0 ? 0 : clamp01(acc.successCredit / jobs)
  const disputeRate = jobs === 0 ? 0 : clamp01(acc.disputes / jobs)
  const refundRate = jobs === 0 ? 0 : clamp01(acc.refunds / jobs)
  const diversity = jobs === 0 ? 0 : clamp01(acc.counterparties.size / jobs)
  const latency = percentiles(acc.latencySamples)

  return {
    success_rate: successRate,
    dispute_rate: disputeRate,
    refund_rate: refundRate,
    latency_ms: latency,
    // Uptime is probe-derived (§9.1); no probe source is wired in this module, so a
    // perfect-by-default 1 is published until a prober feeds samples. Documented, not faked.
    uptime: 1,
    jobs,
    settled_value: acc.settledValue,
    stake: acc.stake,
    first_seen: acc.firstSeen,
    last_settled: acc.lastSettled,
    counterparty_diversity: diversity,
    spam_flags: acc.spamFlags,
    post_flags: acc.postFlags,
  }
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

// p50/p95 via nearest-rank on a copy of the samples. Empty → {0,0} so a no-history
// subject does not get a misleadingly perfect latency adherence in computeTrust.
const percentiles = (samples: readonly number[]): { p50: number; p95: number } => {
  if (samples.length === 0) return { p50: 0, p95: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  return { p50: nearestRank(sorted, 0.5), p95: nearestRank(sorted, 0.95) }
}

const nearestRank = (sorted: readonly number[], q: number): number => {
  const rank = Math.ceil(q * sorted.length)
  const idx = Math.min(Math.max(rank, 1), sorted.length) - 1
  return sorted[idx] ?? 0
}

export const emptyAccumulator = (): MetricsAccumulator => ({
  jobs: 0,
  successCredit: 0,
  disputes: 0,
  refunds: 0,
  latencySamples: [],
  settledValue: '0',
  settledCurrency: null,
  firstSeen: null,
  lastSettled: null,
  counterparties: new Set<string>(),
  stake: '0',
  spamFlags: 0,
  postFlags: 0,
  ingestedReceipts: new Set<string>(),
})
