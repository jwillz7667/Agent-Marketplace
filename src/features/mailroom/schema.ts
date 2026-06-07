import { z } from 'zod'

// Zod validation for the Mailroom HTTP surface (§7.1 message schema, §7.2 type table,
// §7.4 anti-spam postage, §7.5 handoff). Validation runs at the boundary BEFORE any
// signature/policy work. CRITICAL (§10.3, §15.8): every free-text field (subject, scope
// prose, status notes, reason details) is validated ONLY as an opaque string. Free text is
// data, never instructions — it never reaches an interpreter and never drives a decision.
// Only the TYPED fields (type, refs, price, milestone ids, reason codes) gate behavior.

// ---------------------------------------------------------------------------
// Shared envelope (§7.1) — every message carries these regardless of type.
// ---------------------------------------------------------------------------

const Did = z.string().min(1)
const MoneyAmount = z.string().min(1)
const Currency = z.string().min(1)

const PriceSchema = z.object({
  amount: MoneyAmount,
  currency: Currency,
  per: z.string().min(1),
})

const MoneySchema = z.object({ amount: MoneyAmount, currency: Currency })

// refs is the structural bridge to settlement (§7.5): the typed (listing_ref, quote_id) a
// deal resolves to. quote_id/job_ref are nullable because they are filled in over a thread.
const RefsSchema = z.object({
  listing_ref: z.string().min(1).nullish(),
  quote_id: z.string().min(1).nullish(),
  job_ref: z.string().min(1).nullish(),
})

const PostageSchema = z.object({
  amount: MoneyAmount,
  currency: Currency,
  escrow_id: z.string().min(1),
})

// The §5.2 Quote object, carried verbatim inside QUOTE message bodies. The mailroom treats
// the quote's typed fields (quote_id, listing_id, price) as the negotiated artifact; the
// signature on it is the provider's, not re-verified here (settlement re-verifies on bind).
const QuoteSchema = z.object({
  quote_id: z.string().min(1),
  listing_id: z.string().min(1),
  listing_version: z.string().min(1),
  price: PriceSchema,
  rail: z.string().min(1),
  requester: Did,
  issued: z.string().min(1),
  expires: z.string().min(1),
  sig: z.string().min(1),
})

const RejectReasonSchema = z.enum([
  'price_too_high',
  'out_of_capacity',
  'capability_mismatch',
  'deadline_infeasible',
  'policy_forbidden',
  'other',
])

const MilestoneSchema = z.object({
  id: z.string().min(1),
  amount: MoneySchema,
  // Free text: milestone description is opaque data only.
  description: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Per-type body schemas (§7.2). Each body shape is fixed so messages are
// machine-actionable. Free-text fields are strings and nothing more.
// ---------------------------------------------------------------------------

// INQUIRY — open a thread, ask a structured question: capability + constraints.
const InquiryBody = z.object({
  capability: z.string().min(1),
  // Free text: the human-readable question. Data only.
  question: z.string().optional(),
  constraints: z.record(z.unknown()).optional(),
})

// QUOTE_REQUEST — request a bindable price: volume, price target, deadline.
const QuoteRequestBody = z.object({
  capability: z.string().min(1),
  volume_estimate: z.number().nonnegative().optional(),
  price_target: PriceSchema.optional(),
  deadline: z.string().min(1).optional(),
})

// QUOTE — offer a bindable price: carries a signed Quote (§5.2).
const QuoteBody = z.object({
  quote: QuoteSchema,
  milestones: z.array(MilestoneSchema).optional(),
})

// OFFER — propose terms for a job: scope, price, milestones.
const OfferBody = z.object({
  // Free text: scope prose. Data only.
  scope: z.string().optional(),
  price: MoneySchema,
  milestones: z.array(MilestoneSchema).optional(),
})

// COUNTER — revise terms: a diff against the prior offer + revised price.
const CounterBody = z.object({
  price: MoneySchema,
  milestones: z.array(MilestoneSchema).optional(),
  // Free text: rationale for the counter. Data only.
  rationale: z.string().optional(),
})

// ACCEPT — accept an offer/quote: references the exact object accepted (§7.5).
const AcceptBody = z.object({
  // The quote_id of the QUOTE this ACCEPT binds to. Settlement consumes this.
  accepts_quote_id: z.string().min(1),
})

// REJECT — decline with an enumerated reason code (typed; drives CLOSED).
const RejectBody = z.object({
  reason: RejectReasonSchema,
  // Free text: optional human detail. Data only — never interpreted.
  detail: z.string().optional(),
})

// DELEGATE — hand a sub-task to another agent: sub-job spec + budget.
const DelegateBody = z.object({
  sub_job: z.record(z.unknown()),
  budget: MoneySchema,
})

// STATUS — progress update on a committed job: milestone id + state.
const StatusBody = z.object({
  milestone_id: z.string().min(1),
  state: z.enum(['started', 'in_progress', 'delivered', 'blocked']),
  // Free text: optional note. Data only.
  note: z.string().optional(),
})

// RECEIPT_REF — point at a settled receipt: receipt id.
const ReceiptRefBody = z.object({
  receipt_id: z.string().min(1),
})

// ---------------------------------------------------------------------------
// Discriminated union on `type` (§7.2). Common envelope fields are spread into
// each member so the discriminator can validate the whole message in one pass.
// ---------------------------------------------------------------------------

const envelope = {
  msg_id: z.string().min(1),
  thread_id: z.string().min(1).optional(),
  in_reply_to: z.string().min(1).nullish(),
  from: Did,
  to: Did,
  refs: RefsSchema.optional(),
  postage: PostageSchema.optional(),
  nonce: z.string().min(1),
  iat: z.string().min(1),
  exp: z.string().min(1),
  sig: z.string().min(1),
}

export const SendMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('INQUIRY'), body: InquiryBody }),
  z.object({ ...envelope, type: z.literal('QUOTE_REQUEST'), body: QuoteRequestBody }),
  z.object({ ...envelope, type: z.literal('QUOTE'), body: QuoteBody }),
  z.object({ ...envelope, type: z.literal('OFFER'), body: OfferBody }),
  z.object({ ...envelope, type: z.literal('COUNTER'), body: CounterBody }),
  z.object({ ...envelope, type: z.literal('ACCEPT'), body: AcceptBody }),
  z.object({ ...envelope, type: z.literal('REJECT'), body: RejectBody }),
  z.object({ ...envelope, type: z.literal('DELEGATE'), body: DelegateBody }),
  z.object({ ...envelope, type: z.literal('STATUS'), body: StatusBody }),
  z.object({ ...envelope, type: z.literal('RECEIPT_REF'), body: ReceiptRefBody }),
])

export type SendMessageInput = z.infer<typeof SendMessageSchema>

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

// The signed agreement object the §7.5 handoff produces on ACCEPT. The Settlement layer
// consumes THIS; the mailroom never moves money beyond postage. It references the concrete
// (listing_ref, quote_id) the thread resolved to, and is signed with the mailroom core key.
export const AgreementSchema = z.object({
  agreement_id: z.string(),
  thread_id: z.string(),
  listing_ref: z.string().nullable(),
  quote_id: z.string(),
  parties: z.object({ requester: z.string(), provider: z.string() }),
  terms: z.object({
    price: PriceSchema,
    milestones: z.array(MilestoneSchema),
  }),
  agreed_at: z.string(),
  iat: z.string(),
  issuer: z.string(),
  sig: z.string(),
})

export type Agreement = z.infer<typeof AgreementSchema>

export const SendResponseSchema = z.object({
  msg_id: z.string(),
  thread_id: z.string(),
  thread_state: z.string(),
  cursor: z.number(),
  postage: z.object({ amount: z.string(), currency: z.string(), escrow_id: z.string() }),
  // Present only on a successful ACCEPT handoff (§7.5).
  agreement: AgreementSchema.optional(),
})

export type SendResponse = z.infer<typeof SendResponseSchema>

// GET /mailroom/inbox — the caller proves identity by passing a SIGNED query object as the
// query string (recipient + since + nonce/iat/exp + sig). verifySignedObject checks the
// detached JWS over the query minus `sig`, with signerDid = recipient. Rationale: a GET has
// no body, and an Authorization header carrying a signed token IS this same object; encoding
// the signed envelope directly in the query keeps one verification path and avoids a second
// header-parsing surface. `since` is coerced because query params arrive as strings.
export const InboxQuerySchema = z.object({
  recipient: Did,
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(200).default(50),
  nonce: z.string().min(1),
  iat: z.string().min(1),
  exp: z.string().min(1),
  sig: z.string().min(1),
})

export type InboxQueryInput = z.infer<typeof InboxQuerySchema>

// Stored messages are returned verbatim (already sender-signed + canonical) plus their
// server-assigned monotonic cursor. passthrough keeps the full signed object intact.
export const InboxResponseSchema = z.object({
  recipient: z.string(),
  messages: z.array(z.object({ cursor: z.number(), message: z.object({}).passthrough() })),
  next_cursor: z.number(),
})

export type InboxResponse = z.infer<typeof InboxResponseSchema>

// POST /mailroom/webhook — register a push delivery endpoint (§7.2 push model). Owner-signed.
export const WebhookRegisterSchema = z.object({
  owner: Did,
  url: z.string().url(),
  nonce: z.string().min(1),
  iat: z.string().min(1),
  exp: z.string().min(1),
  sig: z.string().min(1),
})

export type WebhookRegisterInput = z.infer<typeof WebhookRegisterSchema>

export const WebhookResponseSchema = z.object({
  webhook_id: z.string(),
  owner: z.string(),
  url: z.string(),
  registered_at: z.string(),
})

export type WebhookResponse = z.infer<typeof WebhookResponseSchema>

// POST /mailroom/:msgId/flag — recipient flags a message legit (refund) or spam (forfeit).
export const FlagParamsSchema = z.object({ msgId: z.string().min(1) })

export const FlagBodySchema = z.object({
  flagger: Did,
  kind: z.enum(['legit', 'spam']),
  nonce: z.string().min(1),
  iat: z.string().min(1),
  exp: z.string().min(1),
  sig: z.string().min(1),
})

export type FlagBodyInput = z.infer<typeof FlagBodySchema>

export const FlagResponseSchema = z.object({
  msg_id: z.string(),
  kind: z.enum(['legit', 'spam']),
  postage_action: z.enum(['released', 'forfeited', 'noop']),
})

export type FlagResponse = z.infer<typeof FlagResponseSchema>
