import { z } from 'zod'

// Zod validation for the Registry HTTP surface (§3 Listing, §2.1 CapabilityQuery,
// §9.4 dry-run). Validation happens at the boundary BEFORE any signature work; typed
// fields drive filtering/decisions, free-text fields (title/description/tags) are data
// only and never reach an interpreter (§10.3, §15.8).

const MoneyAmount = z.string().min(1)
const Currency = z.string().min(1)

const SchemaRefSchema = z.object({ $ref: z.string().min(1) })

const ListingCapabilitySchema = z.object({
  taxonomy: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()),
})

const ListingIoSchema = z.object({
  input_schema: SchemaRefSchema,
  output_schema: SchemaRefSchema,
  limits: z
    .object({
      max_input_bytes: z.number().int().nonnegative().optional(),
      max_pages: z.number().int().nonnegative().optional(),
    })
    .optional(),
})

const ListingPricingSchema = z.object({
  model: z.enum(['per_call', 'metered', 'outcome', 'session']),
  unit: z.string().min(1),
  amount: MoneyAmount,
  currency: Currency,
  quote_required: z.boolean(),
  // At least one rail so the registry can bind a quote to a concrete settlement rail (§5.2).
  rails: z.array(z.string().min(1)).min(1),
})

const ListingSlaSchema = z.object({
  latency_ms: z.object({
    p50: z.number().nonnegative(),
    p95: z.number().nonnegative(),
  }),
  uptime_target: z.number().min(0).max(1),
  max_timeout_ms: z.number().int().nonnegative(),
  throughput_rps: z.number().nonnegative(),
})

const ListingAuthSchema = z.object({
  scheme: z.literal('did-jws'),
  audience: z.string().min(1),
  required_claims: z.array(z.string()),
})

const ListingEndpointSchema = z.object({
  protocol: z.string().min(1),
  url: z.string().url(),
  method: z.string().min(1),
  mcp_tool: z.string().min(1).optional(),
})

const ListingDryRunSchema = z.object({
  supported: z.boolean(),
  price: MoneyAmount,
  fixture_ref: z.string().min(1),
  returns: z.literal('signed-result+checksum'),
})

const AcceptanceSpecSchema = z.object({
  type: z.enum(['schema', 'checksum', 'schema+checksum', 'oracle']),
  schema_ref: z.string().min(1).optional(),
  expected: z.string().min(1).optional(),
})

const ListingTermsSchema = z.object({
  refund_policy: z.string().min(1),
  dispute_window_ms: z.number().int().nonnegative(),
  result_retention: z.string().min(1),
  acceptance: AcceptanceSpecSchema,
})

const ListingStakeSchema = z.object({
  amount: MoneyAmount,
  currency: Currency,
  slashable: z.boolean(),
})

const ListingAttestationsSchema = z.object({
  reputation_snapshot_ref: z.string().min(1).nullable(),
  stake: ListingStakeSchema,
})

const ListingProvenanceSchema = z.object({
  created: z.string().min(1),
  updated: z.string().min(1),
  expires: z.string().min(1),
  // Detached JWS by the provider over the whole listing minus provenance.sig.
  sig: z.string().min(1),
})

// Full §3 listing shape. listing_id is optional on publish: absent → create (assign id),
// present + known → update (provider sets `version`; the registry bumps nothing).
export const ListingPublishSchema = z.object({
  listing_id: z.string().min(1).optional(),
  schema_version: z.string().min(1),
  provider: z.string().min(1),
  version: z.string().min(1),
  status: z.enum(['active', 'deprecated', 'suspended', 'retired']),
  capability: ListingCapabilitySchema,
  io: ListingIoSchema,
  pricing: ListingPricingSchema,
  sla: ListingSlaSchema,
  auth: ListingAuthSchema,
  endpoint: ListingEndpointSchema,
  dry_run: ListingDryRunSchema,
  terms: ListingTermsSchema,
  attestations: ListingAttestationsSchema,
  sample: z
    .object({
      request: z.unknown(),
      response: z.unknown(),
    })
    .optional(),
  provenance: ListingProvenanceSchema,
})

export type ListingPublishInput = z.infer<typeof ListingPublishSchema>

export const ListingPublishResponseSchema = z.object({
  listing_id: z.string(),
  version: z.string(),
  status: z.string(),
})

// GET /registry/listings/:id
export const ListingParamsSchema = z.object({ id: z.string().min(1) })
// The stored listing is canonical and already provider-signed; returned verbatim.
export const ListingResponseSchema = z.object({}).passthrough()

// ---------------------------------------------------------------------------
// CapabilityQuery (§2.1)
// ---------------------------------------------------------------------------

const PriceCeilingSchema = z.object({
  amount: MoneyAmount,
  currency: Currency,
  per: z.string().min(1),
})

const QueryCapabilitySchema = z.object({
  taxonomy: z.string().min(1),
  description: z.string().optional(),
  semantic: z.boolean().optional(),
})

const QueryIoRequirementsSchema = z.object({
  input_schema_ref: z.string().min(1).optional(),
  output_schema_ref: z.string().min(1).optional(),
  must_validate: z.boolean().optional(),
})

const QueryConstraintsSchema = z.object({
  price_ceiling: PriceCeilingSchema.optional(),
  latency_target_ms: z.object({ p95: z.number().positive() }).optional(),
  min_trust: z.number().min(0).max(1).optional(),
  min_completed_jobs: z.number().int().nonnegative().optional(),
  regions_allowed: z.array(z.string()).optional(),
  compliance_tags: z.array(z.string()).optional(),
})

const RankingPrefsSchema = z.object({
  weight_price: z.number().min(0).optional(),
  weight_latency: z.number().min(0).optional(),
  weight_trust: z.number().min(0).optional(),
  weight_schema: z.number().min(0).optional(),
  weight_stake: z.number().min(0).optional(),
})

export const CapabilityQuerySchema = z.object({
  query_id: z.string().min(1),
  requester: z.string().min(1),
  capability: QueryCapabilitySchema,
  io_requirements: QueryIoRequirementsSchema.optional(),
  constraints: QueryConstraintsSchema.optional(),
  ranking_prefs: RankingPrefsSchema.optional(),
  max_results: z.number().int().positive().max(100),
  nonce: z.string().min(1),
  iat: z.string().min(1),
  exp: z.string().min(1),
  sig: z.string().min(1),
})

export type CapabilityQueryInput = z.infer<typeof CapabilityQuerySchema>

const MoneySchema = z.object({ amount: z.string(), currency: z.string() })
const QuoteSchema = z.object({
  quote_id: z.string(),
  listing_id: z.string(),
  listing_version: z.string(),
  price: z.object({ amount: z.string(), currency: z.string(), per: z.string() }),
  rail: z.string(),
  requester: z.string(),
  issued: z.string(),
  expires: z.string(),
  sig: z.string(),
})

const MatchExplanationSchema = z.object({
  listing_id: z.string(),
  score: z.number(),
  signals: z.object({
    schema_match: z.number(),
    price_headroom: z.number(),
    latency: z.number(),
    trust: z.number(),
    stake: z.number(),
    counterparty_history: z.number(),
    freshness: z.number(),
  }),
  notes: z.array(z.string()),
})

export const QueryResponseSchema = z.object({
  query_id: z.string(),
  matches: z.array(
    z.object({
      listing_id: z.string(),
      provider: z.string(),
      price: MoneySchema,
      quote: QuoteSchema,
      match_explanation: MatchExplanationSchema,
    }),
  ),
})

// ---------------------------------------------------------------------------
// Dry-run (§9.4)
// ---------------------------------------------------------------------------

export const DryRunParamsSchema = z.object({ id: z.string().min(1) })
export const DryRunResponseSchema = z.object({
  listing_id: z.string(),
  fixture_ref: z.string(),
  output_schema_ref: z.string(),
  output: z.unknown(),
  checksum: z.string(),
  issued: z.string(),
  issuer: z.string(),
  sig: z.string(),
})
