import type {
  Money,
  Passport,
  DelegationCredential,
  Receipt,
  ReputationSnapshot,
  ReputationMetrics,
  PaymentRequirements,
  PaymentPayload,
} from '../../domain/index'

// ---------------------------------------------------------------------------
// Cross-module collaboration contracts. Modules depend ONLY on these interfaces,
// never on each other's concrete classes. The composition root (src/container.ts)
// wires concrete adapters into these slots.
// ---------------------------------------------------------------------------

export interface Clock {
  now(): string
  nowMs(): number
}

// Replay protection: a nonce may be consumed exactly once before its expiry.
export interface NonceStore {
  checkAndConsume(nonce: string, expISO: string): Promise<boolean> // false if replayed or expired
}

// Single-flight idempotency gate for money-moving mutations (§6.1). The store — not the caller — is
// the concurrency authority, because correct dedup requires holding the in-flight execution itself.
// Implementations MUST guarantee:
//   1. at-most-once SUCCESS per (scope, key): fn runs once; a later retry returns the cached result;
//   2. concurrent callers with the same key JOIN the single in-flight run (they never run fn twice,
//      so a captured request replayed under a new transport-level key cannot double-charge);
//   3. a THROWN fn releases the key (the failure is NOT cached) so a later legitimate retry re-runs.
export interface IdempotencyStore {
  execute<T>(scope: string, key: string, fn: () => Promise<T>): Promise<T>
}

export interface Keystore {
  register(kid: string, privateKey: Uint8Array): Promise<void>
  getSigningKey(kid: string): Promise<Uint8Array | null>
}

export interface IdentityResolver {
  resolvePassport(did: string): Promise<Passport | null>
  publicKeyFor(did: string, keyId?: string): Promise<Uint8Array | null>
  activeDelegation(did: string): Promise<DelegationCredential | null>
  isRevoked(did: string): Promise<boolean>
}

export interface SpendUsage {
  dailySpent: Money
  totalSpent: Money
}

export interface PolicyAction {
  kind: 'spend' | 'message' | 'post' | 'escrow' | 'stake' | 'tip'
  agent: string
  amount?: Money
  category?: string
  counterparty?: string
  // Sub-kind for surface-specific gates (e.g. "offer" | "rfp" for posting).
  subKind?: string
}

export type PolicyDecision =
  | { result: 'allow' }
  | { result: 'deny'; reasons: string[] }
  | { result: 'needs_approval'; threshold: Money; reasons: string[] }

export interface PolicyEvaluator {
  evaluate(delegation: DelegationCredential, action: PolicyAction, usage: SpendUsage): PolicyDecision
}

export interface WalletSigner {
  // Enforces policy BELOW the agent (the §4.3 hard stop), then signs with the agent key.
  // Independently refuses any out-of-policy signature even if the pre-flight check is bypassed.
  //
  // approvalId (optional): a prior supervisor clearance for an over-threshold action. When the
  // independent policy check returns needs_approval AND a matching, approved, not-yet-consumed
  // approval is presented, the signer CONSUMES it (single-use) and proceeds to sign — so an
  // approved high-value action runs exactly once and cannot be replayed past the cap. The signer
  // never trusts a bare "approved" flag from the caller: it redeems the approval itself.
  signWithinPolicy(input: {
    did: string
    payload: unknown
    action: PolicyAction
    approvalId?: string
  }): Promise<{ ok: true; sig: string } | { ok: false; decision: PolicyDecision }>
}

export interface UsagePort {
  usage(did: string): Promise<SpendUsage>
}

export interface LedgerEntry {
  seq: number
  prevHash: string
  hash: string
  ts: string
  kind: string
  subject?: string
  payload: unknown
}

export interface Ledger {
  append(input: { kind: string; subject?: string; payload: unknown }): Promise<LedgerEntry>
  list(filter?: {
    kind?: string
    subject?: string
    since?: number
    until?: string
    from?: string
  }): Promise<LedgerEntry[]>
  merkleRoot(): Promise<string>
  verifyChain(): Promise<boolean>
}

export interface ReputationPort {
  getSnapshot(did: string): Promise<ReputationSnapshot | null>
  getRaw(did: string): Promise<ReputationMetrics | null>
  ingestReceipt(receipt: Receipt): Promise<void>
  ingestSignal(did: string, kind: string, weight: number): Promise<void>
}

export interface VerifyResult {
  ok: boolean
  reason?: string
}

export interface SettlementResult {
  ok: boolean
  settledAt: string
  railRef: string
  reason?: string
}

export interface Rail {
  readonly id: string
  verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResult>
  settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettlementResult>
}

export interface RailRegistry {
  get(railId: string): Rail | null
  list(): string[]
}

export interface ValueTransferPort {
  balanceOf(did: string, currency: string): Promise<Money>
  credit(did: string, amount: Money, ref: string): Promise<void>
  debit(did: string, amount: Money, ref: string): Promise<void>
  hold(did: string, amount: Money, ref: string): Promise<string>
  release(holdId: string): Promise<void>
  capture(holdId: string, to: string): Promise<void>
  forfeit(holdId: string, split?: { toRecipient: string; burnFraction: number }): Promise<void>
}

export interface WalletBalanceRow {
  currency: string
  available: Money
  held: Money
}

export interface WalletQueryPort {
  balances(did: string): Promise<WalletBalanceRow[]>
}

export interface PendingApproval {
  approvalId: string
  agent: string
  action: PolicyAction
  payload: unknown
  createdAt: string
  // Lifecycle: pending → (approved|denied) → consumed. `consumed` is terminal and single-use.
  status: 'pending' | 'approved' | 'denied' | 'consumed'
  // The supervisor's terminal ruling, preserved across consumption so a consumer (the signer, or the
  // escrow escalation-resolver) still knows whether the action was cleared or refused after the
  // status has flipped to `consumed`. Null until resolved.
  decision: 'approved' | 'denied' | null
}

export interface ApprovalPort {
  enqueue(input: { agent: string; action: PolicyAction; payload: unknown }): Promise<PendingApproval>
  status(approvalId: string): Promise<PendingApproval | null>
  // Single-use redemption of a RESOLVED approval (approved or denied). Atomically transitions the
  // approval to `consumed` and returns its snapshot (with `decision` preserved). This is what makes
  // a supervisor's one-time clearance single-use: an approved high-value action cannot be replayed
  // to exceed delegated caps (§4.3). Throws if the approval is missing, still pending, already
  // consumed, or does not match the presented agent+action (an approval authorizes exactly one
  // action). The caller inspects the returned `decision` to decide whether to proceed.
  consume(approvalId: string, expect: { agent: string; action: PolicyAction }): Promise<PendingApproval>
}

export interface PrincipalAgentEntry {
  did: string
  delegation: DelegationCredential | null
}

export interface DelegationAdminPort {
  issue(input: { issuer: string; subject: string; policy: unknown; expires: string }): Promise<DelegationCredential>
  update(subjectDid: string, policy: unknown): Promise<DelegationCredential>
  revoke(subjectDid: string): Promise<void>
  listByPrincipal(principal: string): Promise<PrincipalAgentEntry[]>
}
