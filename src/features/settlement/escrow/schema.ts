import { z } from 'zod'

// Zod validation for the escrow surface (§6.2 / §14.4 / §9.5). Validation runs at the boundary;
// provider-delivered result_hash and any payload sample are opaque data, never interpreted.

const MoneySchema = z.object({ amount: z.string().min(1), currency: z.string().min(1) })

const AcceptanceSpecSchema = z.object({
  type: z.enum(['schema', 'checksum', 'schema+checksum', 'oracle']),
  schema_ref: z.string().min(1).optional(),
  expected: z.string().min(1).optional(),
})

const MilestoneSchema = z.object({
  id: z.string().min(1),
  amount: z.string().min(1),
  acceptance: AcceptanceSpecSchema,
})

const ProviderStakeSchema = z.object({
  amount: z.string().min(1),
  currency: z.string().min(1),
  slashable: z.boolean(),
})

// POST /escrow — the payer-signed EscrowContract (both party sigs present at open; §14.4 step 6).
export const OpenEscrowSchema = z.object({
  escrow_id: z.string().min(1),
  job_ref: z.string().min(1),
  payer: z.string().min(1),
  payee: z.string().min(1),
  amount: MoneySchema,
  milestones: z.array(MilestoneSchema).min(1),
  deliver_by: z.string().min(1),
  on_timeout: z.enum(['refund', 'release', 'arbitrate']),
  dispute_window_ms: z.number().int().nonnegative(),
  provider_stake: ProviderStakeSchema,
  sig_payer: z.string().min(1),
  sig_payee: z.string().min(1),
  // Replay/freshness envelope for the open request (the contract is signed by both parties; this
  // nonce/iat/exp guards the open call itself).
  nonce: z.string().min(1),
  iat: z.string().min(1),
  exp: z.string().min(1),
  // A prior supervisor approval for an over-threshold commit. When a first open parked
  // (needs_approval) and the principal approved, the payer re-submits with this approval_id; the
  // signer redeems it single-use before any funds lock. Omitted on a normal in-policy open.
  approval_id: z.string().min(1).optional(),
})

export type OpenEscrowInput = z.infer<typeof OpenEscrowSchema>

export const EscrowParamsSchema = z.object({ id: z.string().min(1) })

// POST /escrow/:id/deliver — provider submits a milestone result (provider-signed).
export const DeliverSchema = z.object({
  milestone_id: z.string().min(1),
  result_hash: z.string().min(1),
  result_schema_ref: z.string().min(1).optional(),
  provider: z.string().min(1),
  nonce: z.string().min(1),
  iat: z.string().min(1),
  exp: z.string().min(1),
  sig: z.string().min(1),
})

export type DeliverInput = z.infer<typeof DeliverSchema>

// POST /escrow/:id/accept — payer accepts a delivered milestone (payer-signed).
export const AcceptSchema = z.object({
  milestone_id: z.string().min(1),
  payer: z.string().min(1),
  nonce: z.string().min(1),
  iat: z.string().min(1),
  exp: z.string().min(1),
  sig: z.string().min(1),
})

export type AcceptInput = z.infer<typeof AcceptSchema>

// POST /escrow/:id/dispute — either party disputes a milestone (signed). An optional bond is
// posted by the disputer; griefing slashes it (§9.5 both-direction slashing).
export const DisputeSchema = z.object({
  milestone_id: z.string().min(1),
  disputer: z.string().min(1),
  reason_code: z.string().min(1),
  bond: MoneySchema.optional(),
  nonce: z.string().min(1),
  iat: z.string().min(1),
  exp: z.string().min(1),
  sig: z.string().min(1),
})

export type DisputeInput = z.infer<typeof DisputeSchema>

// POST /escrow/:id/resolve — either party triggers settlement of an escalated escrow (subjective
// dispute or arbitrate timeout) AFTER governance has ruled. The caller's signature only authenticates
// the trigger; the outcome is fixed by the redeemed governance ruling, not by the caller.
export const ResolveEscalationSchema = z.object({
  caller: z.string().min(1),
  nonce: z.string().min(1),
  iat: z.string().min(1),
  exp: z.string().min(1),
  sig: z.string().min(1),
})

export type ResolveEscalationInput = z.infer<typeof ResolveEscalationSchema>

const MilestoneRuntimeSchema = z.object({
  id: z.string(),
  state: z.string(),
  result_hash: z.string().nullable(),
})

export const EscrowStateResponseSchema = z.object({
  escrow_id: z.string(),
  state: z.string(),
  milestones: z.array(MilestoneRuntimeSchema),
})
