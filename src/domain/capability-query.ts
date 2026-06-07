import type { Money } from './money'

// CapabilityQuery (§2.1) and the ranked-match result objects (§2.3).

export interface QueryCapability {
  readonly taxonomy: string
  readonly description?: string
  readonly semantic?: boolean
}

export interface QueryIoRequirements {
  readonly input_schema_ref?: string
  readonly output_schema_ref?: string
  readonly must_validate?: boolean
}

export interface PriceCeiling {
  readonly amount: string
  readonly currency: string
  readonly per: string
}

export interface QueryConstraints {
  readonly price_ceiling?: PriceCeiling
  readonly latency_target_ms?: { readonly p95: number }
  readonly min_trust?: number
  readonly min_completed_jobs?: number
  readonly regions_allowed?: readonly string[]
  readonly compliance_tags?: readonly string[]
}

export interface RankingPrefs {
  readonly weight_price?: number
  readonly weight_latency?: number
  readonly weight_trust?: number
  readonly weight_schema?: number
  readonly weight_stake?: number
}

export interface CapabilityQuery {
  readonly query_id: string
  readonly requester: string
  readonly capability: QueryCapability
  readonly io_requirements?: QueryIoRequirements
  readonly constraints?: QueryConstraints
  readonly ranking_prefs?: RankingPrefs
  readonly max_results: number
  readonly nonce: string
  readonly iat: string
  readonly exp: string
  readonly sig: string
}

// Per-signal breakdown so an agent can audit why a listing ranked where it did.
export interface MatchExplanation {
  readonly listing_id: string
  readonly score: number
  readonly signals: {
    readonly schema_match: number
    readonly price_headroom: number
    readonly latency: number
    readonly trust: number
    readonly stake: number
    readonly counterparty_history: number
    readonly freshness: number
  }
  readonly notes: readonly string[]
}

export interface RankedMatch {
  readonly listing_id: string
  readonly provider: string
  readonly price: Money
  readonly quote: import('./quote').Quote
  readonly match_explanation: MatchExplanation
}
