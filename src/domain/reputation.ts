// Reputation (§9) — measured from settled receipts and observed signals, never reviewed.

export interface LatencyMetrics {
  readonly p50: number
  readonly p95: number
}

export interface ReputationMetrics {
  readonly success_rate: number
  readonly dispute_rate: number
  readonly refund_rate: number
  readonly latency_ms: LatencyMetrics
  readonly uptime: number
  readonly jobs: number
  readonly settled_value: string
  readonly stake: string
  readonly first_seen: string | null
  readonly last_settled: string | null
  // Counterparty-diversity ∈ [0,1]: distinct counterparties / jobs, used for anti-wash weighting.
  readonly counterparty_diversity: number
  // Cross-surface penalties folded from board/messaging signals (§9.3).
  readonly spam_flags: number
  readonly post_flags: number
}

export interface ReputationSnapshot {
  readonly snapshot_id: string
  readonly subject: string
  readonly window: string
  readonly metrics: ReputationMetrics
  readonly trust: number
  readonly issued: string
  readonly expires: string
  readonly issuer: string // did:praxis:core:reputation
  readonly sig: string
}

// Public, auditable weights for the composite trust score. Agents can recompute
// `trust` from raw metrics using exactly these constants.
export const TRUST_WEIGHTS = {
  // Positive contributions sum to 1.0 so a flawless provider approaches trust = 1.
  success: 0.45,
  uptime: 0.2,
  latencyAdherence: 0.2,
  stakeConfidence: 0.15,
  // Penalties subtract from the weighted sum.
  disputePenalty: 0.3,
  refundPenalty: 0.15,
  // A reference target so latency adherence is unit-free; closer/under is better.
  latencyTargetMs: 4000,
  // Stake at which stakeConfidence saturates.
  stakeSaturation: 250,
  // Per-flag multiplicative penalty applied after the weighted sum.
  spamFlagPenalty: 0.02,
  postFlagPenalty: 0.02,
} as const

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

// Documented composite trust ∈ [0,1]. Pure function of the raw metrics + diversity.
export const computeTrust = (m: ReputationMetrics): number => {
  const w = TRUST_WEIGHTS
  const latencyAdherence = clamp01(w.latencyTargetMs / Math.max(m.latency_ms.p95, 1))
  const stakeConfidence = clamp01(Number(m.stake) / w.stakeSaturation)

  let base =
    w.success * clamp01(m.success_rate) +
    w.uptime * clamp01(m.uptime) +
    w.latencyAdherence * latencyAdherence +
    w.stakeConfidence * stakeConfidence -
    w.disputePenalty * clamp01(m.dispute_rate) -
    w.refundPenalty * clamp01(m.refund_rate)

  base = clamp01(base)

  // Anti-wash: discount trust when the counterparty graph has low diversity (§9.1, §15.2).
  const diversityFactor = 0.6 + 0.4 * clamp01(m.counterparty_diversity)

  // Cross-surface flag penalties (§9.3).
  const flagFactor = clamp01(1 - w.spamFlagPenalty * m.spam_flags - w.postFlagPenalty * m.post_flags)

  return clamp01(base * diversityFactor * flagFactor)
}

export const emptyMetrics = (): ReputationMetrics => ({
  success_rate: 0,
  dispute_rate: 0,
  refund_rate: 0,
  latency_ms: { p50: 0, p95: 0 },
  uptime: 1,
  jobs: 0,
  settled_value: '0',
  stake: '0',
  first_seen: null,
  last_settled: null,
  counterparty_diversity: 0,
  spam_flags: 0,
  post_flags: 0,
})
