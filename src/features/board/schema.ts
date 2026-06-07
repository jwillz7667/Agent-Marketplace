import { z } from 'zod'

// Zod validation for the Board HTTP surface (§8.1 post types, §8.3 query/subscribe, §8.5
// flag/tombstone). Validation runs at the boundary BEFORE any signature work. Typed fields
// (type, capability, regions, price, trust floor) drive filtering/ranking; free-text fields
// (titles, descriptions, prose `reason`/`change`/`outcome`) are DATA only and never reach an
// interpreter — they are a prompt-injection surface (§10.3, §15.8).

const Amount = z.string().min(1)
const Currency = z.string().min(1)
const Did = z.string().min(1)
const Iso = z.string().min(1)

// The detached-JWS signature envelope every signed object carries (§ envelope).
const EnvelopeFields = {
  nonce: z.string().min(1),
  iat: Iso,
  exp: Iso,
  sig: z.string().min(1),
}

// Chain fields are server-assigned. They are present on a STORED post but MUST NOT appear on
// an inbound post body (the author signs BEFORE they exist). We default them so the inbound
// discriminated union and the stored shape share one schema; the service overwrites them.
const ChainFields = {
  seq: z.number().int().nonnegative().default(0),
  prev_hash: z.string().default(''),
  post_hash: z.string().default(''),
}

const PriceFrom = z.object({ amount: Amount, currency: Currency, per: z.string().min(1) })
const StakeSpec = z.object({ amount: Amount, currency: Currency, slashable: z.boolean() })

// ---------------------------------------------------------------------------
// §8.1 post-type schemas. Discriminated on `type`.
// ---------------------------------------------------------------------------

export const OfferPostSchema = z.object({
  type: z.literal('OFFER'),
  post_id: z.string().min(1),
  author: Did,
  created: Iso,
  capability: z.string().min(1),
  listing_ref: z.string().min(1),
  price_from: PriceFrom,
  regions: z.array(z.string().min(1)),
  expires: Iso,
  stake: StakeSpec,
  ...ChainFields,
  ...EnvelopeFields,
})

export const RfpPostSchema = z.object({
  type: z.literal('RFP'),
  post_id: z.string().min(1),
  author: Did,
  created: Iso,
  capability: z.string().min(1),
  spec: z.object({
    input_schema_ref: z.string().min(1).optional(),
    output_schema_ref: z.string().min(1).optional(),
    volume: z.number().int().nonnegative().optional(),
  }),
  budget: z.object({ amount: Amount, currency: Currency }),
  deadline: Iso,
  acceptance: z.object({ type: z.string().min(1) }),
  bid_via: z.string().min(1),
  ...ChainFields,
  ...EnvelopeFields,
})

export const AnnouncementPostSchema = z.object({
  type: z.literal('ANNOUNCEMENT'),
  post_id: z.string().min(1),
  author: Did,
  created: Iso,
  subject: z.string().min(1),
  change: z.string(),
  effective: Iso,
  ...ChainFields,
  ...EnvelopeFields,
})

export const WorkRecordPostSchema = z.object({
  type: z.literal('WORK_RECORD'),
  post_id: z.string().min(1),
  author: Did,
  created: Iso,
  receipt_ref: z.string().min(1),
  counterparty: Did,
  outcome: z.string().min(1),
  latency_ms: z.number().int().nonnegative(),
  // Second detached JWS by the counterparty over the body minus both sigs + chain fields.
  counterparty_sig: z.string().min(1),
  ...ChainFields,
  ...EnvelopeFields,
})

export const TombstonePostSchema = z.object({
  type: z.literal('TOMBSTONE'),
  post_id: z.string().min(1),
  author: Did,
  created: Iso,
  target_post_id: z.string().min(1),
  reason: z.string(),
  ...ChainFields,
  ...EnvelopeFields,
})

export const BoardPostSchema = z.discriminatedUnion('type', [
  OfferPostSchema,
  RfpPostSchema,
  AnnouncementPostSchema,
  WorkRecordPostSchema,
  TombstonePostSchema,
])

export type BoardPostInput = z.infer<typeof BoardPostSchema>

// A stored post echoed back to the caller (chain fields populated). The board is canonical
// and post bodies are author-signed; returned verbatim via a passthrough object.
export const StoredPostSchema = z.object({}).passthrough()

export const PostResponseSchema = z.object({
  post_id: z.string(),
  seq: z.number().int(),
  prev_hash: z.string(),
  post_hash: z.string(),
  merkle_root: z.string(),
})

// ---------------------------------------------------------------------------
// §8.3 query — two-stage filter-then-rank.
// ---------------------------------------------------------------------------

export const PostTypeSchema = z.enum(['OFFER', 'RFP', 'ANNOUNCEMENT', 'WORK_RECORD', 'TOMBSTONE'])

export const BoardQuerySchema = z.object({
  // Hard filters (§8.3): structured, typed fields only.
  type: PostTypeSchema.optional(),
  capability: z.string().min(1).optional(),
  author: Did.optional(),
  region: z.string().min(1).optional(),
  since: Iso.optional(),
  until: Iso.optional(),
  min_author_trust: z.number().min(0).max(1).optional(),
  max_price: Amount.optional(),
  // Cursor pagination by seq: return posts with seq > cursor.
  cursor: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(200).default(50),
})

export type BoardQueryInput = z.infer<typeof BoardQuerySchema>

const MatchExplanationSchema = z.object({
  post_id: z.string(),
  score: z.number(),
  signals: z.object({
    recency: z.number(),
    author_trust: z.number(),
    price: z.number(),
  }),
  notes: z.array(z.string()),
})

export const BoardQueryResponseSchema = z.object({
  matches: z.array(
    z.object({
      post: StoredPostSchema,
      match_explanation: MatchExplanationSchema,
    }),
  ),
  next_cursor: z.number().int().nullable(),
})

// ---------------------------------------------------------------------------
// §8.3 subscribe — push-discovery.
// ---------------------------------------------------------------------------

export const SubscribeSchema = z.object({
  subscriber: Did,
  topics: z.array(z.string().min(1)).min(1),
  webhook_url: z.string().url().optional(),
  ...EnvelopeFields,
})

export type SubscribeInput = z.infer<typeof SubscribeSchema>

export const SubscribeResponseSchema = z.object({
  subscription_id: z.string(),
  subscriber: z.string(),
  topics: z.array(z.string()),
})

// ---------------------------------------------------------------------------
// §8.5 tombstone + flag.
// ---------------------------------------------------------------------------

export const PostIdParamsSchema = z.object({ postId: z.string().min(1) })

// Tombstone request: the original author signs a retraction referencing the target post.
export const TombstoneRequestSchema = z.object({
  author: Did,
  reason: z.string(),
  ...EnvelopeFields,
})

export type TombstoneRequestInput = z.infer<typeof TombstoneRequestSchema>

// Flag request: a flagger reports a post for abuse/spam (§8.5).
export const FlagRequestSchema = z.object({
  flagger: Did,
  reason: z.string(),
  category: z.enum(['spam', 'fraud', 'injection', 'malware', 'other']),
  ...EnvelopeFields,
})

export type FlagRequestInput = z.infer<typeof FlagRequestSchema>

export const FlagResponseSchema = z.object({
  post_id: z.string(),
  flagger: z.string(),
  flag_count: z.number().int(),
  upheld: z.boolean(),
})

export const AnchorResponseSchema = z.object({
  merkle_root: z.string(),
  head_seq: z.number().int(),
})
