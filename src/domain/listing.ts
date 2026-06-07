import type { Money } from './money'

// Listing / service schema (§3) — the canonical, machine-callable, priced artifact.

export type ListingStatus = 'active' | 'deprecated' | 'suspended' | 'retired'
export type PricingModel = 'per_call' | 'metered' | 'outcome' | 'session'

export interface ListingCapability {
  readonly taxonomy: string
  readonly title: string
  readonly description: string
  readonly tags: readonly string[]
}

export interface SchemaRef {
  readonly $ref: string
}

export interface ListingIo {
  readonly input_schema: SchemaRef
  readonly output_schema: SchemaRef
  readonly limits?: { readonly max_input_bytes?: number; readonly max_pages?: number }
}

export interface ListingPricing {
  readonly model: PricingModel
  readonly unit: string
  readonly amount: string
  readonly currency: string
  readonly quote_required: boolean
  readonly rails: readonly string[]
}

export interface ListingSla {
  readonly latency_ms: { readonly p50: number; readonly p95: number }
  readonly uptime_target: number
  readonly max_timeout_ms: number
  readonly throughput_rps: number
}

export interface ListingAuth {
  readonly scheme: 'did-jws'
  readonly audience: string
  readonly required_claims: readonly string[]
}

export interface ListingEndpoint {
  readonly protocol: string
  readonly url: string
  readonly method: string
  readonly mcp_tool?: string
}

export interface ListingDryRun {
  readonly supported: boolean
  readonly price: string
  readonly fixture_ref: string
  readonly returns: 'signed-result+checksum'
}

export interface AcceptanceSpec {
  readonly type: 'schema' | 'checksum' | 'schema+checksum' | 'oracle'
  readonly schema_ref?: string
  readonly expected?: string
}

export interface ListingTerms {
  readonly refund_policy: string
  readonly dispute_window_ms: number
  readonly result_retention: string
  readonly acceptance: AcceptanceSpec
}

export interface ListingStake {
  readonly amount: string
  readonly currency: string
  readonly slashable: boolean
}

export interface ListingAttestations {
  readonly reputation_snapshot_ref: string | null
  readonly stake: ListingStake
}

export interface ListingProvenance {
  readonly created: string
  readonly updated: string
  readonly expires: string
  readonly sig: string
}

export interface Listing {
  readonly listing_id: string
  readonly schema_version: string
  readonly provider: string
  readonly version: string // quotes bind to this
  readonly status: ListingStatus
  readonly capability: ListingCapability
  readonly io: ListingIo
  readonly pricing: ListingPricing
  readonly sla: ListingSla
  readonly auth: ListingAuth
  readonly endpoint: ListingEndpoint
  readonly dry_run: ListingDryRun
  readonly terms: ListingTerms
  readonly attestations: ListingAttestations
  readonly sample?: { readonly request: unknown; readonly response: unknown }
  readonly provenance: ListingProvenance
}

export const listingPrice = (l: Listing): Money => ({ amount: l.pricing.amount, currency: l.pricing.currency })

export const listingIsActive = (l: Listing, nowIso: string): boolean =>
  l.status === 'active' && new Date(l.provenance.expires).getTime() > new Date(nowIso).getTime()
