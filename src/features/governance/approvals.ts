import Big from 'big.js'
import { newApprovalId } from '../../domain/index'
import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors'
import type { ApprovalPort, Clock, PendingApproval, PolicyAction } from '../../shared/ports/index'
import type { ApprovalRepo } from './repo'

export type ApprovalDecision = 'approve' | 'deny'

// Structural equality for two PolicyActions: binds an approval to EXACTLY the action it was granted
// for, so a clearance issued for one spend cannot be redeemed to authorize a different (e.g. larger,
// or to a different counterparty) action. Amounts compare by normalized numeric value.
const policyActionMatches = (a: PolicyAction, b: PolicyAction): boolean => {
  if (a.kind !== b.kind || a.agent !== b.agent) return false
  if ((a.counterparty ?? null) !== (b.counterparty ?? null)) return false
  if ((a.category ?? null) !== (b.category ?? null)) return false
  if ((a.subKind ?? null) !== (b.subKind ?? null)) return false
  const ca = a.amount ?? null
  const cb = b.amount ?? null
  if (ca === null || cb === null) return ca === cb
  return ca.currency === cb.currency && new Big(ca.amount).eq(cb.amount)
}

// ApprovalQueue implements ApprovalPort (the slot the Settlement / Mailroom modules park
// into when a policy check returns `needs_approval`, §4.3 / §12). The producer calls
// enqueue() to hold an action; it polls status() until a supervisor resolves it via the
// governance POST /gov/approvals/:id route, which calls resolve(). The settlement side then
// re-submits the originally-parked action on its own — this module ONLY flips queue state
// and leaves an audit trail; it never moves money or replays the parked action itself.
export class ApprovalQueue implements ApprovalPort {
  constructor(
    private readonly repo: ApprovalRepo,
    private readonly clock: Clock,
  ) {}

  async enqueue(input: { agent: string; action: PolicyAction; payload: unknown }): Promise<PendingApproval> {
    const approval: PendingApproval = {
      approvalId: newApprovalId(),
      agent: input.agent,
      action: input.action,
      payload: input.payload,
      createdAt: this.clock.now(),
      status: 'pending',
      decision: null,
    }
    await this.repo.put(approval)
    return approval
  }

  async status(approvalId: string): Promise<PendingApproval | null> {
    return this.repo.get(approvalId)
  }

  // Read side used by the governance plane's GET /gov/approvals. Not part of ApprovalPort
  // (producers only enqueue/poll); exposed here so the service reads the queue through the
  // same impl it parks into rather than reaching past it to the repo.
  async listPending(): Promise<PendingApproval[]> {
    return this.repo.listPending()
  }

  // Supervisor resolution path. Idempotent only for a repeated identical decision: a pending
  // approval transitions exactly once to approved/denied. Re-deciding an already-resolved
  // approval the same way is a no-op; flipping it to the opposite decision is a conflict
  // (the parked action may already have been resumed on the first decision).
  async resolve(approvalId: string, decision: ApprovalDecision): Promise<PendingApproval> {
    const existing = await this.repo.get(approvalId)
    if (!existing) throw new NotFoundError(`approval ${approvalId} not found`)

    const target: PendingApproval['status'] = decision === 'approve' ? 'approved' : 'denied'
    if (existing.status !== 'pending') {
      if (existing.status === target) return existing
      throw new ConflictError(`approval ${approvalId} already ${existing.status}`, {
        details: { current: existing.status, attempted: target },
      })
    }

    const resolved: PendingApproval = { ...existing, status: target, decision: target }
    await this.repo.put(resolved)
    return resolved
  }

  // Single-use redemption (ApprovalPort.consume). Atomically flips a RESOLVED approval to
  // `consumed` and returns its snapshot with `decision` preserved. This is the backstop that makes a
  // supervisor's clearance one-shot: even with an approved approval id in hand, an agent cannot
  // replay it to authorize a second (or larger) action — the matching check binds it to one action,
  // and the consumed status prevents re-redemption (§4.3 hard stop).
  //
  // NOTE: this read-then-write is atomic on the single-process memory adapter (no await between the
  // status check and the put on a synchronous Map). A distributed adapter MUST implement consume as
  // a conditional update (compare-and-set on status) so two concurrent redemptions cannot both win.
  async consume(approvalId: string, expect: { agent: string; action: PolicyAction }): Promise<PendingApproval> {
    const existing = await this.repo.get(approvalId)
    if (!existing) throw new NotFoundError(`approval ${approvalId} not found`)
    if (existing.status === 'consumed') {
      throw new ConflictError(`approval ${approvalId} has already been consumed`)
    }
    if (existing.status === 'pending') {
      throw new ConflictError(`approval ${approvalId} is not yet resolved`)
    }
    if (existing.agent !== expect.agent) {
      throw new ForbiddenError(`approval ${approvalId} was issued for a different agent`)
    }
    if (!policyActionMatches(existing.action, expect.action)) {
      throw new ForbiddenError(`approval ${approvalId} does not authorize this action`)
    }

    const consumed: PendingApproval = { ...existing, status: 'consumed' }
    await this.repo.put(consumed)
    return consumed
  }
}
