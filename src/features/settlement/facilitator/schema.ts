import { z } from 'zod'

// Zod validation for the §5.3/§14.3 atomic-pay surface (POST /pay/:listingId). Validation runs at
// the boundary BEFORE any signature or settlement work. Untrusted free-text (the optional result
// payload) is treated as opaque data — it is hashed for the receipt, never interpreted.

export const PayParamsSchema = z.object({ listingId: z.string().min(1) })

const QuotePriceSchema = z.object({
  amount: z.string().min(1),
  currency: z.string().min(1),
  per: z.string().min(1),
})

// The signed Quote the registry issued (§5.2). Carried in the body so the facilitator can verify
// the registry core signature over it and bind the payment to it.
export const QuoteSchema = z.object({
  quote_id: z.string().min(1),
  listing_id: z.string().min(1),
  listing_version: z.string().min(1),
  price: QuotePriceSchema,
  rail: z.string().min(1),
  requester: z.string().min(1),
  issued: z.string().min(1),
  expires: z.string().min(1),
  sig: z.string().min(1),
})

const Eip3009AuthorizationSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  value: z.string().min(1),
  validAfter: z.string().min(1),
  validBefore: z.string().min(1),
  nonce: z.string().min(1),
})

// The agent-signed PaymentPayload (§5.3 step 4). Present on the second call.
export const PaymentPayloadSchema = z.object({
  scheme: z.enum(['exact', 'upto', 'stream']),
  rail: z.string().min(1),
  authorization: Eip3009AuthorizationSchema,
  quote_id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  amount: z.string().min(1),
  currency: z.string().min(1),
  nonce: z.string().min(1),
  iat: z.string().min(1),
  exp: z.string().min(1),
  sig: z.string().min(1),
})

// POST /pay/:listingId body. First call carries only the quote → 402 with PaymentRequirements.
// Second call carries the signed payload → settle + receipt. `result` is the provider's delivered
// output (opaque); when present its checksum becomes the receipt's result_hash.
export const PayBodySchema = z.object({
  quote: QuoteSchema,
  // The provider/payee settlement DID the agent discovered for this listing. The quote binds the
  // price to a listing_id/version; the payee is the provider that owns it. PaymentRequirements'
  // pay_to and the signed payload's `to` must both equal this DID — the facilitator never lets a
  // payment redirect to a different recipient than the one the agent intends to pay.
  payee: z.string().min(1),
  payment: PaymentPayloadSchema.optional(),
  result: z.unknown().optional(),
  // A prior supervisor approval for an over-threshold spend. When the first call parked
  // (needs_approval) and the principal then approved, the agent re-submits the SAME signed payload
  // under a FRESH Idempotency-Key with this approval_id; the signer redeems it single-use and the
  // payment proceeds. Omitted on a normal in-policy call.
  approval_id: z.string().min(1).optional(),
})

export type PayBody = z.infer<typeof PayBodySchema>
export type PayParams = z.infer<typeof PayParamsSchema>

// 402 response: the PaymentRequirements (§5.1) the agent must satisfy.
export const PaymentRequirementsSchema = z.object({
  scheme: z.string(),
  rail: z.string(),
  network: z.string(),
  asset: z.string(),
  amount: z.string(),
  pay_to: z.string(),
  quote_id: z.string(),
  nonce: z.string(),
  expires: z.string(),
  facilitator: z.string(),
})

// 200 response: the signed Receipt (§11), returned as PAYMENT-RECEIPT.
const MoneySchema = z.object({ amount: z.string(), currency: z.string() })
export const ReceiptSchema = z.object({
  receipt_id: z.string(),
  quote_id: z.string().nullable(),
  listing_id: z.string().nullable(),
  listing_version: z.string().nullable(),
  job_ref: z.string().nullable().optional(),
  payer: z.string(),
  payee: z.string(),
  amount: MoneySchema,
  rail: z.string(),
  result_hash: z.string(),
  latency_ms: z.number(),
  outcome: z.enum(['delivered', 'refunded', 'partial', 'disputed']),
  settled_at: z.string(),
  facilitator_sig: z.string(),
  payee_sig: z.string(),
})

// When a payment needs principal approval, the call is parked (not charged) and the agent is told
// the approval id to poll (§4.3 hard stop → needs_approval).
export const ApprovalParkedSchema = z.object({
  status: z.literal('needs_approval'),
  approval_id: z.string(),
  threshold: MoneySchema,
  reasons: z.array(z.string()),
})
