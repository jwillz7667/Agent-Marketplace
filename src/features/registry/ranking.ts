import Big from 'big.js'
import type { CapabilityQuery, Listing, MatchExplanation } from '../../domain/index'
import { listingIsActive } from '../../domain/index'

// Two-stage discovery (§2.2): a HARD FILTER pass that REMOVES candidates (never
// down-ranks), then a SOFT RANK pass over the survivors using only load-bearing signals.
// There is NO engagement signal, NO recency-of-marketing, and NO paid placement (§2.3) —
// a paid post can buy reach on the Board but never ranking weight here.

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

export interface RankWeights {
  readonly price: number
  readonly latency: number
  readonly trust: number
  readonly schema: number
  readonly stake: number
}

// Default ranking weights (§2.1 example + §2.3). Price/latency/trust mirror the spec;
// schema-match and stake are load-bearing signals the spec lists but the example omits, so
// they default to modest weights. Provided ranking_prefs override these per-signal.
export const DEFAULT_WEIGHTS: RankWeights = {
  price: 0.4,
  latency: 0.2,
  trust: 0.4,
  schema: 0.15,
  stake: 0.15,
}

// Stake (USDC) at which the stake signal saturates to 1. Mirrors the reputation engine's
// stakeSaturation so a provider's stake reads consistently across surfaces.
const STAKE_SATURATION = 250

// Lexical cosine threshold above which a taxonomy-mismatched listing is ADDED to the
// candidate set when query.capability.semantic is true (§2.2 semantic recall).
export const SEMANTIC_SIMILARITY_THRESHOLD = 0.5

// Reputation inputs the ranker needs, resolved once per candidate provider by the service.
export interface ProviderReputation {
  readonly trust: number
  readonly jobs: number
  // Counterparty history with THIS requester, in [0,1]; 0 when no prior history is known.
  readonly counterpartyHistory: number
  // Epoch ms of the provider's most recent SETTLED receipt, or null when it has never settled.
  // Freshness is measured from this (a load-bearing, non-gameable signal) rather than from the
  // provider-signed listing.provenance.updated, which a provider could bump at will (§2.3 forbids
  // recency-of-marketing as a ranking signal).
  readonly lastSettledMs: number | null
}

export interface FilterContext {
  readonly nowIso: string
  readonly reputationFor: (provider: string) => ProviderReputation
}

export interface FilterResult {
  readonly survivors: Listing[]
  // Listings removed by a hard constraint, with the reason (audit/debug only; not returned).
  readonly removed: { readonly listing_id: string; readonly reason: string }[]
}

// ---------------------------------------------------------------------------
// Lexical TF-cosine similarity over capability descriptions.
//
// This is a deliberately simple, dependency-free stand-in for the spec's vector index
// (§2.2). It is SWAPPABLE: replace `descriptionSimilarity` with an embedding-backed cosine
// without touching the filter/rank flow. It only ever WIDENS the candidate set; it can
// never override a hard price/trust/schema filter.
// ---------------------------------------------------------------------------

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)

const termFrequencies = (tokens: readonly string[]): Map<string, number> => {
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  return tf
}

export const descriptionSimilarity = (a: string, b: string): number => {
  const tfA = termFrequencies(tokenize(a))
  const tfB = termFrequencies(tokenize(b))
  if (tfA.size === 0 || tfB.size === 0) return 0

  let dot = 0
  for (const [term, freqA] of tfA) {
    const freqB = tfB.get(term)
    if (freqB !== undefined) dot += freqA * freqB
  }
  if (dot === 0) return 0

  let normA = 0
  for (const f of tfA.values()) normA += f * f
  let normB = 0
  for (const f of tfB.values()) normB += f * f

  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// ---------------------------------------------------------------------------
// Stage 1 — hard filter
// ---------------------------------------------------------------------------

// A listing passes the capability gate when its taxonomy exactly equals the query's, OR —
// when semantic recall is on — its description is lexically close enough to widen recall.
const capabilityMatches = (query: CapabilityQuery, listing: Listing): boolean => {
  if (listing.capability.taxonomy === query.capability.taxonomy) return true
  if (query.capability.semantic && query.capability.description) {
    return descriptionSimilarity(query.capability.description, listing.capability.description) >= SEMANTIC_SIMILARITY_THRESHOLD
  }
  return false
}

export const hardFilter = (query: CapabilityQuery, listings: readonly Listing[], ctx: FilterContext): FilterResult => {
  const survivors: Listing[] = []
  const removed: { listing_id: string; reason: string }[] = []
  const c = query.constraints
  const io = query.io_requirements

  for (const listing of listings) {
    const drop = (reason: string): void => {
      removed.push({ listing_id: listing.listing_id, reason })
    }

    // Active + unexpired. status !== 'active' or a past provenance.expires removes it.
    if (!listingIsActive(listing, ctx.nowIso)) {
      drop('not active or expired')
      continue
    }

    // Capability taxonomy (exact) or semantic-widen match.
    if (!capabilityMatches(query, listing)) {
      drop('capability taxonomy mismatch')
      continue
    }

    // I/O schema refs — only a hard constraint when must_validate is set (§2.1).
    if (io?.must_validate) {
      if (io.input_schema_ref !== undefined && listing.io.input_schema.$ref !== io.input_schema_ref) {
        drop('input schema ref mismatch')
        continue
      }
      if (io.output_schema_ref !== undefined && listing.io.output_schema.$ref !== io.output_schema_ref) {
        drop('output schema ref mismatch')
        continue
      }
    }

    // Price ceiling. Compare like-for-like currency; a currency mismatch is a hard miss.
    if (c?.price_ceiling) {
      if (listing.pricing.currency !== c.price_ceiling.currency) {
        drop('price currency mismatch')
        continue
      }
      if (new Big(listing.pricing.amount).gt(c.price_ceiling.amount)) {
        drop('price over ceiling')
        continue
      }
    }

    // SLA latency floor: declared p95 must be at or under the requester's target.
    if (c?.latency_target_ms && listing.sla.latency_ms.p95 > c.latency_target_ms.p95) {
      drop('p95 latency over target')
      continue
    }

    // Compliance: 'no-pii-retention' maps to terms.result_retention === 'none' (§2.1↔§3).
    // Region filtering is intentionally skipped: §3 listings carry no region field, so a
    // region constraint cannot be evaluated against a listing and must not silently drop it.
    if (c?.compliance_tags?.includes('no-pii-retention') && listing.terms.result_retention !== 'none') {
      drop('no-pii-retention required but listing retains results')
      continue
    }

    // Reputation floors — resolved per provider from the reputation engine.
    const rep = ctx.reputationFor(listing.provider)
    if (c?.min_trust !== undefined && rep.trust < c.min_trust) {
      drop('trust below min_trust')
      continue
    }
    if (c?.min_completed_jobs !== undefined && rep.jobs < c.min_completed_jobs) {
      drop('jobs below min_completed_jobs')
      continue
    }

    survivors.push(listing)
  }

  return { survivors, removed }
}

// ---------------------------------------------------------------------------
// Stage 2 — soft rank
// ---------------------------------------------------------------------------

export interface ScoredListing {
  readonly listing: Listing
  readonly explanation: MatchExplanation
}

const resolveWeights = (query: CapabilityQuery): RankWeights => {
  const p = query.ranking_prefs
  if (!p) return DEFAULT_WEIGHTS
  return {
    price: p.weight_price ?? DEFAULT_WEIGHTS.price,
    latency: p.weight_latency ?? DEFAULT_WEIGHTS.latency,
    trust: p.weight_trust ?? DEFAULT_WEIGHTS.trust,
    schema: p.weight_schema ?? DEFAULT_WEIGHTS.schema,
    stake: p.weight_stake ?? DEFAULT_WEIGHTS.stake,
  }
}

// Schema-match score: 1.0 when both declared refs match exactly, 0.5 when one matches (or
// only one is requested), 0 when neither aligns. A surviving listing always has SOME signal.
const schemaMatchScore = (query: CapabilityQuery, listing: Listing): number => {
  const io = query.io_requirements
  if (!io) return 1
  const wants = [io.input_schema_ref, io.output_schema_ref].filter((r): r is string => r !== undefined)
  if (wants.length === 0) return 1
  let hits = 0
  if (io.input_schema_ref !== undefined && listing.io.input_schema.$ref === io.input_schema_ref) hits++
  if (io.output_schema_ref !== undefined && listing.io.output_schema.$ref === io.output_schema_ref) hits++
  return hits / wants.length
}

// Price headroom: (ceiling - price) / ceiling. Cheaper-within-ceiling scores higher; at the
// ceiling it scores 0; with no ceiling there is nothing to discriminate on → neutral 0.5.
const priceHeadroomScore = (query: CapabilityQuery, listing: Listing): number => {
  const ceiling = query.constraints?.price_ceiling
  if (!ceiling) return 0.5
  const ceil = new Big(ceiling.amount)
  if (ceil.lte(0)) return 0
  const price = new Big(listing.pricing.amount)
  return clamp01(ceil.minus(price).div(ceil).toNumber())
}

// Latency: target / listing_p95, clamped to [0,1]. Faster-than-target saturates at 1; with
// no target we cannot discriminate → neutral 0.5.
const latencyScore = (query: CapabilityQuery, listing: Listing): number => {
  const target = query.constraints?.latency_target_ms?.p95
  if (target === undefined) return 0.5
  const p95 = Math.max(listing.sla.latency_ms.p95, 1)
  return clamp01(target / p95)
}

// Bonded stake (§2.3): more slashable stake = more skin in the game. Saturates at
// STAKE_SATURATION; non-slashable stake contributes nothing.
const stakeScore = (listing: Listing): number => {
  const stake = listing.attestations.stake
  if (!stake.slashable) return 0
  return clamp01(new Big(stake.amount).div(STAKE_SATURATION).toNumber())
}

// Freshness (§2.3): decays linearly from 1 (settled now) to 0 (>= 30 days since the last settle, or
// never settled). Measured from the provider's most recent SETTLED receipt — genuine recent
// activity — NOT from the provider-controlled provenance.updated, which would let a provider stay
// "fresh" by re-publishing without doing any work.
const FRESHNESS_HORIZON_MS = 30 * 24 * 60 * 60 * 1000
const freshnessScore = (lastSettledMs: number | null, nowMs: number): number => {
  if (lastSettledMs === null || Number.isNaN(lastSettledMs)) return 0
  const ageMs = Math.max(0, nowMs - lastSettledMs)
  return clamp01(1 - ageMs / FRESHNESS_HORIZON_MS)
}

export const rankSurvivors = (
  query: CapabilityQuery,
  survivors: readonly Listing[],
  ctx: FilterContext,
): ScoredListing[] => {
  const w = resolveWeights(query)
  const weightSum = w.price + w.latency + w.trust + w.schema + w.stake
  // Guard a degenerate all-zero weight set so we still produce a stable, explainable order.
  const denom = weightSum > 0 ? weightSum : 1
  const nowMs = new Date(ctx.nowIso).getTime()

  const scored = survivors.map((listing): ScoredListing => {
    const rep = ctx.reputationFor(listing.provider)

    const signals = {
      schema_match: schemaMatchScore(query, listing),
      price_headroom: priceHeadroomScore(query, listing),
      latency: latencyScore(query, listing),
      trust: clamp01(rep.trust),
      stake: stakeScore(listing),
      counterparty_history: clamp01(rep.counterpartyHistory),
      freshness: freshnessScore(rep.lastSettledMs, nowMs),
    }

    // Weighted sum normalized to [0,1]. counterparty_history and freshness are folded in as
    // small additive boosts on top of the normalized core so a prior good outcome and a
    // recently-active provider edge out an otherwise-tied competitor (§2.3).
    const weighted =
      w.price * signals.price_headroom +
      w.latency * signals.latency +
      w.trust * signals.trust +
      w.schema * signals.schema_match +
      w.stake * signals.stake
    const core = weighted / denom
    const boost = 0.05 * signals.counterparty_history + 0.05 * signals.freshness
    const score = clamp01(core + boost)

    const notes = buildNotes(query, listing, signals)

    return {
      listing,
      explanation: { listing_id: listing.listing_id, score, signals, notes },
    }
  })

  // Sort by score desc; break ties deterministically by listing_id so results are stable.
  scored.sort((a, b) => {
    if (b.explanation.score !== a.explanation.score) return b.explanation.score - a.explanation.score
    return a.listing.listing_id < b.listing.listing_id ? -1 : a.listing.listing_id > b.listing.listing_id ? 1 : 0
  })

  return scored
}

const buildNotes = (
  query: CapabilityQuery,
  listing: Listing,
  signals: MatchExplanation['signals'],
): string[] => {
  const notes: string[] = []
  if (listing.capability.taxonomy === query.capability.taxonomy) {
    notes.push(`exact taxonomy match: ${listing.capability.taxonomy}`)
  } else {
    notes.push(`semantic widen: description cosine added this candidate`)
  }
  if (query.constraints?.price_ceiling) {
    notes.push(`price ${listing.pricing.amount} ${listing.pricing.currency} within ceiling ${query.constraints.price_ceiling.amount}`)
  }
  if (query.constraints?.latency_target_ms) {
    notes.push(`p95 ${listing.sla.latency_ms.p95}ms vs target ${query.constraints.latency_target_ms.p95}ms`)
  }
  notes.push(`trust=${signals.trust.toFixed(3)} stake=${signals.stake.toFixed(3)}`)
  return notes
}
