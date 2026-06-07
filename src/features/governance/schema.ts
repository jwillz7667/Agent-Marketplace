import { z } from 'zod'

// Zod validation for the Human Governance Plane control API (§12, §14.2 GOVERNANCE).
// This is an OVERSIGHT surface, not a shopping one: a supervisor sets the rules their
// agents operate under and reads the audit log. Every inbound object is validated at the
// boundary before any side effect; free-text fields (notes) are data only — they are
// audited verbatim and never reach an interpreter (§10.3, §15.8).

const MoneySchema = z.object({
  amount: z.string().min(1),
  currency: z.string().min(1),
})

// DelegationPolicy (§4.2) — mirrors src/domain/delegation.ts and the core identity schema
// exactly so a policy validated here is structurally identical to one the DelegationAdminPort
// will re-validate. Keeping the two in lockstep is intentional: the governance plane is the
// human write path for the same policy object the signer enforces below the agent (§4.3).
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

// PUT /gov/agents/:did/policy — params + body.
export const AgentDidParamsSchema = z.object({
  did: z.string().min(1),
})

export const PolicyUpdateBodySchema = z.object({
  policy: DelegationPolicySchema,
})

export type PolicyUpdateBody = z.infer<typeof PolicyUpdateBodySchema>

// GET /gov/agents?principal=<did> — the principal whose delegated agents to list.
// Required because DelegationAdminPort only exposes listByPrincipal (no list-all surface),
// and a supervisor token is always scoped to the org/principal it governs.
export const AgentsQuerySchema = z.object({
  principal: z.string().min(1),
})

// POST /gov/approvals/:id — approve or deny a parked action.
export const ApprovalIdParamsSchema = z.object({
  id: z.string().min(1),
})

export const ApprovalDecisionBodySchema = z.object({
  decision: z.enum(['approve', 'deny']),
  // Free-text supervisor note, audited verbatim. Bounded so it cannot bloat the ledger.
  note: z.string().max(2000).optional(),
})

export type ApprovalDecisionBody = z.infer<typeof ApprovalDecisionBodySchema>

// GET /gov/audit?... — filters mirror the Ledger.list contract (§11).
export const AuditQuerySchema = z.object({
  kind: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  since: z.coerce.number().int().positive().optional(),
  from: z.string().min(1).optional(),
})

export type AuditQuery = z.infer<typeof AuditQuerySchema>

// ---------------------------------------------------------------------------
// Response shapes. The Zod serializer validates outbound bodies too, so these
// describe exactly what each route returns.
// ---------------------------------------------------------------------------

const WalletBalanceRowSchema = z.object({
  currency: z.string(),
  available: MoneySchema,
  held: MoneySchema,
})

// Reputation is projected to the load-bearing oversight fields (§9, §12 monitoring): the
// composite trust plus the count of settled jobs. Null when the agent has no snapshot yet.
const AgentStandingSchema = z
  .object({
    trust: z.number(),
    jobs: z.number(),
  })
  .nullable()

const GovAgentSchema = z.object({
  did: z.string(),
  policy: DelegationPolicySchema.nullable(),
  delegation_expires: z.string().nullable(),
  balances: z.array(WalletBalanceRowSchema),
  standing: AgentStandingSchema,
})

export const AgentsResponseSchema = z.object({
  principal: z.string(),
  agents: z.array(GovAgentSchema),
})

export const PolicyUpdateResponseSchema = z.object({
  subject: z.string(),
  issuer: z.string(),
  issued: z.string(),
  expires: z.string(),
  policy: DelegationPolicySchema,
})

export const KillResponseSchema = z.object({
  did: z.string(),
  revoked: z.literal(true),
  at: z.string(),
})

const PolicyActionSchema = z.object({
  kind: z.enum(['spend', 'message', 'post', 'escrow', 'stake', 'tip']),
  agent: z.string(),
  amount: MoneySchema.optional(),
  category: z.string().optional(),
  counterparty: z.string().optional(),
  subKind: z.string().optional(),
})

const PendingApprovalSchema = z.object({
  approvalId: z.string(),
  agent: z.string(),
  action: PolicyActionSchema,
  payload: z.unknown(),
  createdAt: z.string(),
  // `consumed` is the terminal single-use state set when a resolved clearance is redeemed at the
  // signing boundary or by an escrow escalation-resolve (§4.3).
  status: z.enum(['pending', 'approved', 'denied', 'consumed']),
  // The supervisor's terminal ruling, preserved across consumption (null until resolved).
  decision: z.enum(['approved', 'denied']).nullable(),
})

export const ApprovalsListResponseSchema = z.object({
  approvals: z.array(PendingApprovalSchema),
})

export const ApprovalDecisionResponseSchema = z.object({
  approval: PendingApprovalSchema,
})

const LedgerEntrySchema = z.object({
  seq: z.number(),
  prevHash: z.string(),
  hash: z.string(),
  ts: z.string(),
  kind: z.string(),
  subject: z.string().optional(),
  payload: z.unknown(),
})

export const AuditResponseSchema = z.object({
  entries: z.array(LedgerEntrySchema),
  merkleRoot: z.string(),
  chainValid: z.boolean(),
})
