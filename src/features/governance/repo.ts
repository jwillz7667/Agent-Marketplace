import type { PendingApproval } from '../../shared/ports/index'

// Persistence port owned by the governance module for the human-approval queue (§12).
// A parked action (a spend/message/etc. that needs human sign-off) lives here as a
// PendingApproval until a supervisor approves or denies it. The factory constructs the
// in-memory adapter by default; the container can swap a durable adapter without touching
// the service. Keyed by approvalId.
export interface ApprovalRepo {
  put(approval: PendingApproval): Promise<void>
  get(approvalId: string): Promise<PendingApproval | null>
  listPending(): Promise<PendingApproval[]>
}
