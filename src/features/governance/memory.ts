import type { PendingApproval } from '../../shared/ports/index'
import type { ApprovalRepo } from './repo'

// In-memory ApprovalRepo. Single-process, deterministic insertion order so the pending
// queue reads back oldest-first. State is the queue itself (PendingApproval); the service
// is stateless and re-derives nothing from outside this store.
export class MemoryApprovalRepo implements ApprovalRepo {
  private readonly byId = new Map<string, PendingApproval>()

  async put(approval: PendingApproval): Promise<void> {
    this.byId.set(approval.approvalId, approval)
  }

  async get(approvalId: string): Promise<PendingApproval | null> {
    return this.byId.get(approvalId) ?? null
  }

  async listPending(): Promise<PendingApproval[]> {
    // Map preserves insertion order, so pending approvals come back in arrival order.
    return [...this.byId.values()].filter((a) => a.status === 'pending')
  }
}
