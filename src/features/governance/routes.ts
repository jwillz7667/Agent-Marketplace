import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { DelegationPolicy } from '../../domain/index'
import { AuthError } from '../../shared/errors'
import type { GovernanceService } from './service'
import type { DelegationPolicyInput } from './schema'
import {
  AgentDidParamsSchema,
  AgentsQuerySchema,
  AgentsResponseSchema,
  ApprovalDecisionBodySchema,
  ApprovalDecisionResponseSchema,
  ApprovalIdParamsSchema,
  ApprovalsListResponseSchema,
  AuditQuerySchema,
  AuditResponseSchema,
  KillResponseSchema,
  PolicyUpdateBodySchema,
  PolicyUpdateResponseSchema,
} from './schema'

// Length-independent-then-content constant-time string compare. We avoid a short-circuit on
// the first differing byte so a network attacker cannot probe the secret byte-by-byte via
// timing. The length leak is bounded by first folding a length mismatch into the accumulator
// and comparing a fixed number of bytes. Node builtins would also work, but this keeps the
// guard self-contained and dependency-free.
const constantTimeEqual = (a: string, b: string): boolean => {
  // Compare over the longer length so the loop count does not vary on the secret's length;
  // any out-of-range index contributes a guaranteed-mismatch byte.
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : -1
    const cb = i < b.length ? b.charCodeAt(i) : -2
    diff |= ca ^ cb
  }
  return diff === 0
}

// Extracts and validates the supervisor bearer token. DENY BY DEFAULT: a missing header, a
// non-Bearer scheme, or a token that does not constant-time-match config.GOV_API_KEY all
// reject with AuthError(401). The expected token comes from the injected config — never
// process.env (hexagonal DI; §0 / build contract).
const requireSupervisor = (header: string | undefined, expected: string): void => {
  if (typeof header !== 'string') throw new AuthError('missing Authorization header')
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) throw new AuthError('Authorization header must use the Bearer scheme')
  const token = header.slice(prefix.length)
  if (token.length === 0) throw new AuthError('missing bearer token')
  if (!constantTimeEqual(token, expected)) throw new AuthError('invalid supervisor token')
}

// Project the domain DelegationPolicy (readonly arrays) into the mutable shape the Zod
// response serializer expects. Spreading each array yields fresh mutable copies so the
// structural readonly mismatch disappears without an unsafe cast.
const policyToResponse = (p: DelegationPolicy): DelegationPolicyInput => ({
  spend: {
    per_tx_max: { ...p.spend.per_tx_max },
    daily_max: { ...p.spend.daily_max },
    total_max: { ...p.spend.total_max },
  },
  categories_allow: [...p.categories_allow],
  categories_deny: [...p.categories_deny],
  counterparties_allow: [...p.counterparties_allow],
  counterparties_deny: [...p.counterparties_deny],
  require_human_approval_over: { ...p.require_human_approval_over },
  messaging: { send: p.messaging.send, max_postage_per_day: p.messaging.max_postage_per_day },
  posting: {
    offers: p.posting.offers,
    rfps: p.posting.rfps,
    max_post_spend_per_day: p.posting.max_post_spend_per_day,
  },
  escrow: { may_commit: p.escrow.may_commit, max_escrow: { ...p.escrow.max_escrow } },
  may_stake: p.may_stake,
})

export interface GovernanceRoutesDeps {
  readonly service: GovernanceService
  readonly govApiKey: string
}

// Human Governance Plane control API (§12, §14.2 GOVERNANCE). A single onRequest hook applies
// the supervisor bearer guard to EVERY route in this plugin, so no governance surface is
// reachable without the token. Handlers validate-then-delegate and throw AppError subclasses.
export const makeGovernanceRoutes =
  (deps: GovernanceRoutesDeps): FastifyPluginAsyncZod =>
  async (app) => {
    // Deny by default: guard fires before any handler/body parsing for all routes below.
    app.addHook('onRequest', async (req) => {
      requireSupervisor(req.headers.authorization, deps.govApiKey)
    })

    const { service } = deps

    // GET /gov/agents?principal=<did> — agents under governance with policy + balances + standing.
    app.get(
      '/gov/agents',
      { schema: { querystring: AgentsQuerySchema, response: { 200: AgentsResponseSchema } } },
      async (req) => {
        const { principal } = req.query
        const agents = await service.listAgents(principal)
        return {
          principal,
          agents: agents.map((a) => ({
            did: a.did,
            policy: a.policy !== null ? policyToResponse(a.policy) : null,
            delegation_expires: a.delegation_expires,
            balances: a.balances.map((b) => ({
              currency: b.currency,
              available: { amount: b.available.amount, currency: b.available.currency },
              held: { amount: b.held.amount, currency: b.held.currency },
            })),
            standing: a.standing,
          })),
        }
      },
    )

    // PUT /gov/agents/:did/policy — update the agent's DelegationPolicy; audited.
    app.put(
      '/gov/agents/:did/policy',
      {
        schema: {
          params: AgentDidParamsSchema,
          body: PolicyUpdateBodySchema,
          response: { 200: PolicyUpdateResponseSchema },
        },
      },
      async (req) => {
        const result = await service.updatePolicy(req.params.did, req.body.policy)
        return {
          subject: result.subject,
          issuer: result.issuer,
          issued: result.issued,
          expires: result.expires,
          policy: policyToResponse(result.policy),
        }
      },
    )

    // POST /gov/agents/:did/kill — KILL SWITCH: revoke the delegation immediately; audited.
    app.post(
      '/gov/agents/:did/kill',
      { schema: { params: AgentDidParamsSchema, response: { 200: KillResponseSchema } } },
      async (req) => {
        return service.kill(req.params.did)
      },
    )

    // GET /gov/approvals — the pending human-approval queue.
    app.get(
      '/gov/approvals',
      { schema: { response: { 200: ApprovalsListResponseSchema } } },
      async () => {
        const approvals = await service.listPendingApprovals()
        return { approvals: approvals.map((a) => ({ ...a })) }
      },
    )

    // POST /gov/approvals/:id — approve/deny a held action; audited.
    app.post(
      '/gov/approvals/:id',
      {
        schema: {
          params: ApprovalIdParamsSchema,
          body: ApprovalDecisionBodySchema,
          response: { 200: ApprovalDecisionResponseSchema },
        },
      },
      async (req) => {
        const resolved = await service.resolveApproval(req.params.id, req.body.decision, req.body.note)
        return { approval: { ...resolved } }
      },
    )

    // GET /gov/audit?kind&subject&since&from — query/export the audit log + integrity proof.
    app.get(
      '/gov/audit',
      { schema: { querystring: AuditQuerySchema, response: { 200: AuditResponseSchema } } },
      async (req) => {
        const { kind, subject, since, from } = req.query
        const view = await service.audit({
          ...(kind !== undefined ? { kind } : {}),
          ...(subject !== undefined ? { subject } : {}),
          ...(since !== undefined ? { since } : {}),
          ...(from !== undefined ? { from } : {}),
        })
        return {
          entries: view.entries.map((e) => ({
            seq: e.seq,
            prevHash: e.prevHash,
            hash: e.hash,
            ts: e.ts,
            kind: e.kind,
            ...(e.subject !== undefined ? { subject: e.subject } : {}),
            payload: e.payload,
          })),
          merkleRoot: view.merkleRoot,
          chainValid: view.chainValid,
        }
      },
    )
  }

export { requireSupervisor, constantTimeEqual }
