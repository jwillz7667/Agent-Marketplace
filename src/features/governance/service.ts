import type { DelegationPolicy } from '../../domain/index'
import { NotFoundError } from '../../shared/errors'
import type {
  Clock,
  DelegationAdminPort,
  IdentityResolver,
  Ledger,
  LedgerEntry,
  PendingApproval,
  ReputationPort,
  WalletBalanceRow,
  WalletQueryPort,
} from '../../shared/ports/index'
import type { ApprovalQueue, ApprovalDecision } from './approvals'
import type { DelegationPolicyInput } from './schema'

// Audit kinds appended to the §11 ledger by the governance plane. Every governance config
// change and decision is itself signed-and-logged (§12: "the governance plane is auditable
// too"), so a supervisor can reconstruct who changed what, when, from the audit trail.
export const GOV_AUDIT_KIND = {
  policyChange: 'gov_policy_change',
  kill: 'gov_kill',
  approval: 'gov_approval',
} as const

// The actor recorded on every governance audit entry. The supervisor authenticates with the
// bearer token (config.GOV_API_KEY) at the route boundary; the plane does not (yet) carry a
// per-supervisor identity, so audit attribution is the bearer-holding role.
const SUPERVISOR = 'supervisor' as const

export interface GovAgentView {
  readonly did: string
  readonly policy: DelegationPolicy | null
  readonly delegation_expires: string | null
  readonly balances: readonly WalletBalanceRow[]
  readonly standing: { trust: number; jobs: number } | null
}

export interface AuditView {
  readonly entries: readonly LedgerEntry[]
  readonly merkleRoot: string
  readonly chainValid: boolean
}

export interface AuditFilter {
  readonly kind?: string
  readonly subject?: string
  readonly since?: number
  readonly from?: string
}

export interface GovernanceDeps {
  readonly clock: Clock
  readonly identity: IdentityResolver
  readonly delegationAdmin: DelegationAdminPort
  readonly walletQuery: WalletQueryPort
  readonly reputation: ReputationPort
  readonly ledger: Ledger
  readonly approvals: ApprovalQueue
}

export class GovernanceService {
  constructor(private readonly deps: GovernanceDeps) {}

  // GET /gov/agents — compose the oversight view for every agent the principal delegates to:
  // current policy + expiry (from the delegation), wallet balances, and measured standing.
  // listByPrincipal is the only admin read surface, so the principal is required by the route.
  async listAgents(principal: string): Promise<GovAgentView[]> {
    const entries = await this.deps.delegationAdmin.listByPrincipal(principal)

    return Promise.all(
      entries.map(async (entry): Promise<GovAgentView> => {
        const [balances, snapshot] = await Promise.all([
          this.deps.walletQuery.balances(entry.did),
          this.deps.reputation.getSnapshot(entry.did),
        ])
        return {
          did: entry.did,
          policy: entry.delegation?.policy ?? null,
          delegation_expires: entry.delegation?.expires ?? null,
          balances,
          standing: snapshot ? { trust: snapshot.trust, jobs: snapshot.metrics.jobs } : null,
        }
      }),
    )
  }

  // PUT /gov/agents/:did/policy — set/update the agent's DelegationCredential policy (§4.2).
  // The new policy is already Zod-validated at the boundary; the admin port re-validates and
  // re-signs. We capture the BEFORE policy from the active delegation so the audit entry
  // records the exact transition, then APPEND a gov_policy_change to the ledger.
  async updatePolicy(did: string, policy: DelegationPolicyInput): Promise<{
    subject: string
    issuer: string
    issued: string
    expires: string
    policy: DelegationPolicy
  }> {
    const before = (await this.deps.identity.activeDelegation(did))?.policy ?? null

    const credential = await this.deps.delegationAdmin.update(did, policy)

    await this.deps.ledger.append({
      kind: GOV_AUDIT_KIND.policyChange,
      subject: did,
      payload: {
        ...(before !== null ? { before } : {}),
        after: credential.policy,
        by: SUPERVISOR,
        ts: this.deps.clock.now(),
      },
    })

    return {
      subject: credential.subject,
      issuer: credential.issuer,
      issued: credential.issued,
      expires: credential.expires,
      policy: credential.policy,
    }
  }

  // POST /gov/agents/:did/kill — the KILL SWITCH (§12, §10.2). Immediately revokes the
  // delegation; the below-the-agent signer stops authorizing any further action for this DID.
  // The revocation is appended as gov_kill so the instant cutoff is auditable.
  async kill(did: string): Promise<{ did: string; revoked: true; at: string }> {
    await this.deps.delegationAdmin.revoke(did)
    const at = this.deps.clock.now()

    await this.deps.ledger.append({
      kind: GOV_AUDIT_KIND.kill,
      subject: did,
      payload: { did, by: SUPERVISOR, ts: at },
    })

    return { did, revoked: true, at }
  }

  // GET /gov/approvals — the pending human-approval queue (§12).
  async listPendingApprovals(): Promise<PendingApproval[]> {
    const all = await this.deps.approvals.listPending()
    // listPending already filters to status==='pending'; map to a fresh array for the response.
    return all
  }

  // POST /gov/approvals/:id — approve/deny a held action. We flip queue state via the
  // ApprovalQueue and APPEND a gov_approval audit entry recording the decision. On approve the
  // originator (settlement/mailroom) observes the flipped status and re-submits the parked
  // action out-of-band; this plane never replays it. The audit entry is subjected to the
  // PARKED AGENT's DID so the trail joins to that agent's history.
  async resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    note?: string,
  ): Promise<PendingApproval> {
    const resolved = await this.deps.approvals.resolve(approvalId, decision)

    await this.deps.ledger.append({
      kind: GOV_AUDIT_KIND.approval,
      subject: resolved.agent,
      payload: {
        id: approvalId,
        decision,
        ...(note !== undefined ? { note } : {}),
        by: SUPERVISOR,
        ts: this.deps.clock.now(),
      },
    })

    return resolved
  }

  // GET /gov/audit — read the audit trail with optional filters, plus the current merkleRoot
  // and a chain-integrity check, so a supervisor can confirm the log is intact (§11, §12).
  async audit(filter: AuditFilter = {}): Promise<AuditView> {
    const [entries, merkleRoot, chainValid] = await Promise.all([
      this.deps.ledger.list(filter),
      this.deps.ledger.merkleRoot(),
      this.deps.ledger.verifyChain(),
    ])
    return { entries, merkleRoot, chainValid }
  }
}
