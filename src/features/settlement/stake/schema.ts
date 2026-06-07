import { z } from 'zod'

// Zod validation for the stake + tip surface (§4.3 reputation stakes; tips).

const MoneySchema = z.object({ amount: z.string().min(1), currency: z.string().min(1) })

// POST /stake — bond slashable funds to back a listing/claim (agent-signed). Policy gate: kind
// 'stake' (may_stake). The bonded total is reflected to reputation via onStakeChanged.
export const StakeSchema = z.object({
  agent: z.string().min(1),
  amount: MoneySchema,
  listing_ref: z.string().min(1).optional(),
  nonce: z.string().min(1),
  iat: z.string().min(1),
  exp: z.string().min(1),
  sig: z.string().min(1),
  // A prior supervisor approval for an over-threshold bond. On re-submission after the principal
  // approved, the agent re-signs (fresh nonce) with this id; the signer redeems it single-use.
  approval_id: z.string().min(1).optional(),
})

export type StakeInput = z.infer<typeof StakeSchema>

export const StakeResponseSchema = z.object({
  stake_id: z.string(),
  did: z.string(),
  amount: MoneySchema,
  total_bonded: MoneySchema,
  state: z.string(),
})

// POST /tip — voluntary extra value transfer agent→agent (§4.3), bounded by policy kind 'tip'.
export const TipSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  amount: MoneySchema,
  note: z.string().max(280).optional(), // opaque free-text; never interpreted
  nonce: z.string().min(1),
  iat: z.string().min(1),
  exp: z.string().min(1),
  sig: z.string().min(1),
  // A prior supervisor approval for an over-threshold tip. On re-submission after the principal
  // approved, the agent re-signs (fresh nonce) with this id; the signer redeems it single-use.
  approval_id: z.string().min(1).optional(),
})

export type TipInput = z.infer<typeof TipSchema>

export const TipResponseSchema = z.object({
  tip_id: z.string(),
  from: z.string(),
  to: z.string(),
  amount: MoneySchema,
  settled_at: z.string(),
})

export const ApprovalParkedSchema = z.object({
  status: z.literal('needs_approval'),
  approval_id: z.string(),
  threshold: MoneySchema,
  reasons: z.array(z.string()),
})
