import { z } from 'zod'

// Zod validation for the identity HTTP surface. Every inbound object is validated at
// the boundary before any signature work; typed fields drive decisions, free text never
// reaches an interpreter. Money is { amount, currency }; policy mirrors §4.2 exactly.

const MoneySchema = z.object({
  amount: z.string().min(1),
  currency: z.string().min(1),
})

const PassportKeySchema = z.object({
  id: z.string().min(1), // e.g. "#sign-1"
  type: z.literal('Ed25519'),
  pub: z.string().min(1), // base64url public key
})

// services is an open string->string map (mailbox, listings, ...). Required (not defaulted):
// the principal signs the COMPLETE passport, so injecting a default here would change the
// canonical signing bytes and break verification. Clients send {} explicitly when empty.
const PassportServicesSchema = z.record(z.string())

export const PassportSchema = z.object({
  did: z.string().min(1),
  controller: z.string().min(1),
  keys: z.array(PassportKeySchema).min(1),
  services: PassportServicesSchema,
  delegation_ref: z.string().min(1).nullable(),
  kyc_level: z.enum(['unverified', 'principal-verified', 'enhanced']),
  // Detached JWS by the controller principal (or self, for a bootstrapping org passport).
  nonce: z.string().min(1),
  iat: z.string().min(1),
  exp: z.string().min(1),
  sig: z.string().min(1),
})

export type PassportInput = z.infer<typeof PassportSchema>

// DelegationPolicy (§4.2). Validated when the admin/governance plane issues credentials.
export const DelegationPolicySchema = z.object({
  spend: z.object({
    per_tx_max: MoneySchema,
    daily_max: MoneySchema,
    total_max: MoneySchema,
  }),
  categories_allow: z.array(z.string()),
  categories_deny: z.array(z.string()),
  counterparties_allow: z.array(z.string()),
  counterparties_deny: z.array(z.string()),
  require_human_approval_over: MoneySchema,
  messaging: z.object({
    send: z.boolean(),
    max_postage_per_day: z.string().min(1),
  }),
  posting: z.object({
    offers: z.boolean(),
    rfps: z.boolean(),
    max_post_spend_per_day: z.string().min(1),
  }),
  escrow: z.object({
    may_commit: z.boolean(),
    max_escrow: MoneySchema,
  }),
  may_stake: z.boolean(),
})

export type DelegationPolicyInput = z.infer<typeof DelegationPolicySchema>

// POST /identity/register — body is the signed Passport itself.
export const RegisterBodySchema = PassportSchema
export const RegisterResponseSchema = z.object({
  did: z.string(),
  controller: z.string(),
  kyc_level: z.string(),
})

// The canonical stored Passport (domain shape — envelope fields dropped after registration).
// Used as the resolve response so the returned object type matches the schema exactly.
export const StoredPassportSchema = z.object({
  did: z.string(),
  controller: z.string(),
  keys: z.array(PassportKeySchema),
  services: z.record(z.string()),
  delegation_ref: z.string().nullable(),
  kyc_level: z.enum(['unverified', 'principal-verified', 'enhanced']),
  sig: z.string(),
})

// GET /identity/:did — returns the canonical stored Passport.
export const ResolveParamsSchema = z.object({ did: z.string().min(1) })
export const ResolveResponseSchema = StoredPassportSchema

// POST /identity/:did/rotate — a signed key-rotation request by the controller.
export const RotateParamsSchema = z.object({ did: z.string().min(1) })
export const RotateBodySchema = z.object({
  new_key: PassportKeySchema,
  // The id of the existing key being retired/deprecated by this rotation.
  deprecate_key_id: z.string().min(1),
  nonce: z.string().min(1),
  iat: z.string().min(1),
  exp: z.string().min(1),
  sig: z.string().min(1),
})
export const RotateResponseSchema = z.object({
  did: z.string(),
  active_key_id: z.string(),
  deprecated_key_id: z.string(),
})

// POST /identity/:did/revoke — the kill switch (§10.2). Signed by the controller.
export const RevokeParamsSchema = z.object({ did: z.string().min(1) })
export const RevokeBodySchema = z.object({
  // Optional free-text reason for the audit trail; treated as data only.
  reason: z.string().max(500).optional(),
  nonce: z.string().min(1),
  iat: z.string().min(1),
  exp: z.string().min(1),
  sig: z.string().min(1),
})
export const RevokeResponseSchema = z.object({
  did: z.string(),
  revoked: z.literal(true),
})
