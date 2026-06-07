import Big from 'big.js'
import type { DelegationCredential, DelegationPolicy, Money, Passport } from '../../domain/index'
import { mFromString } from '../../domain/index'
import type {
  ApprovalPort,
  IdentityResolver,
  Keystore,
  PendingApproval,
  PolicyAction,
  UsagePort,
  SpendUsage,
} from '../../shared/ports/index'

// Test-only fixtures + in-memory fakes for the consumed ports. Not part of the public barrel.

export const PRINCIPAL_DID = 'did:praxis:org:acme-llc'
export const AGENT_DID = 'did:praxis:agent:7f3a'
export const KEY_ID = '#sign-1'
export const KID = `${AGENT_DID}${KEY_ID}`

export const usd = (amount: string): Money => mFromString(amount, 'USDC')

export const basePolicy = (): DelegationPolicy => ({
  spend: {
    per_tx_max: usd('1.00'),
    daily_max: usd('25.00'),
    total_max: usd('500.00'),
  },
  categories_allow: ['doc.*', 'data.geocode', 'infer.llm.*'],
  categories_deny: ['payments.*', 'identity.*'],
  counterparties_allow: ['*'],
  counterparties_deny: ['did:praxis:agent:badactor'],
  require_human_approval_over: usd('10.00'),
  messaging: { send: true, max_postage_per_day: '2.00' },
  posting: { offers: true, rfps: true, max_post_spend_per_day: '1.00' },
  escrow: { may_commit: true, max_escrow: usd('100.00') },
  may_stake: true,
})

export const makeDelegation = (overrides?: {
  policy?: Partial<DelegationPolicy>
  expires?: string
  subject?: string
  issuer?: string
}): DelegationCredential => ({
  type: ['VerifiableCredential', 'PraxisDelegation'],
  issuer: overrides?.issuer ?? PRINCIPAL_DID,
  subject: overrides?.subject ?? AGENT_DID,
  policy: { ...basePolicy(), ...overrides?.policy },
  issued: '2026-06-01T00:00:00Z',
  expires: overrides?.expires ?? '2026-07-01T00:00:00Z',
  revocation: 'https://acme.example/revocations/7f3a',
  sig: 'test-sig',
})

export const noUsage = (): SpendUsage => ({ dailySpent: usd('0'), totalSpent: usd('0') })
export const usageOf = (daily: string, total: string): SpendUsage => ({
  dailySpent: usd(daily),
  totalSpent: usd(total),
})

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

export class FakeIdentity implements IdentityResolver {
  constructor(
    private state: {
      delegation: DelegationCredential | null
      revoked: boolean
      passport: Passport | null
      publicKey: Uint8Array | null
    },
  ) {}

  async resolvePassport(_did: string): Promise<Passport | null> {
    return this.state.passport
  }
  async publicKeyFor(_did: string, _keyId?: string): Promise<Uint8Array | null> {
    return this.state.publicKey
  }
  async activeDelegation(_did: string): Promise<DelegationCredential | null> {
    return this.state.delegation
  }
  async isRevoked(_did: string): Promise<boolean> {
    return this.state.revoked
  }
}

export class FakeKeystore implements Keystore {
  private store = new Map<string, Uint8Array>()
  async register(kid: string, privateKey: Uint8Array): Promise<void> {
    this.store.set(kid, privateKey)
  }
  async getSigningKey(kid: string): Promise<Uint8Array | null> {
    return this.store.get(kid) ?? null
  }
}

export class FakeUsage implements UsagePort {
  constructor(private value: SpendUsage) {}
  async usage(_did: string): Promise<SpendUsage> {
    return this.value
  }
}

// Mirrors the real ApprovalQueue matcher: an approval clears exactly one (agent, action) tuple.
const actionMatches = (a: PolicyAction, b: PolicyAction): boolean => {
  if (a.kind !== b.kind || a.agent !== b.agent) return false
  if ((a.counterparty ?? null) !== (b.counterparty ?? null)) return false
  if ((a.category ?? null) !== (b.category ?? null)) return false
  if ((a.subKind ?? null) !== (b.subKind ?? null)) return false
  const ca = a.amount ?? null
  const cb = b.amount ?? null
  if (ca === null || cb === null) return ca === cb
  return ca.currency === cb.currency && new Big(ca.amount).eq(cb.amount)
}

// In-memory ApprovalPort for the signer tests. `seed(...)` pre-loads a RESOLVED approval so a test
// can present a clearance to signWithinPolicy; `enqueue` covers the park path; `consume` enforces
// the same single-use + agent/action-binding contract as the production ApprovalQueue.
export class FakeApprovals implements ApprovalPort {
  private readonly store = new Map<string, PendingApproval>()
  private counter = 0

  // Pre-load a resolved approval and return its id. Default decision is 'approved'.
  seed(input: { agent: string; action: PolicyAction; decision?: 'approved' | 'denied'; approvalId?: string }): string {
    const decision = input.decision ?? 'approved'
    const approvalId = input.approvalId ?? `seed-approval-${(this.counter += 1)}`
    this.store.set(approvalId, {
      approvalId,
      agent: input.agent,
      action: input.action,
      payload: null,
      createdAt: '2026-06-01T00:00:00Z',
      status: decision,
      decision,
    })
    return approvalId
  }

  async enqueue(input: { agent: string; action: PolicyAction; payload: unknown }): Promise<PendingApproval> {
    const approvalId = `approval-${(this.counter += 1)}`
    const pending: PendingApproval = {
      approvalId,
      agent: input.agent,
      action: input.action,
      payload: input.payload,
      createdAt: '2026-06-01T00:00:00Z',
      status: 'pending',
      decision: null,
    }
    this.store.set(approvalId, pending)
    return pending
  }

  async status(approvalId: string): Promise<PendingApproval | null> {
    return this.store.get(approvalId) ?? null
  }

  async consume(approvalId: string, expect: { agent: string; action: PolicyAction }): Promise<PendingApproval> {
    const existing = this.store.get(approvalId)
    if (!existing) throw new Error(`approval ${approvalId} not found`)
    if (existing.status === 'consumed') throw new Error(`approval ${approvalId} already consumed`)
    if (existing.status === 'pending') throw new Error(`approval ${approvalId} not yet resolved`)
    if (existing.agent !== expect.agent) throw new Error(`approval ${approvalId} issued for a different agent`)
    if (!actionMatches(existing.action, expect.action)) {
      throw new Error(`approval ${approvalId} does not authorize this action`)
    }
    const consumed: PendingApproval = { ...existing, status: 'consumed' }
    this.store.set(approvalId, consumed)
    return consumed
  }
}

export const makePassport = (pub: string): Passport => ({
  did: AGENT_DID,
  controller: PRINCIPAL_DID,
  keys: [{ id: KEY_ID, type: 'Ed25519', pub }],
  services: {},
  delegation_ref: 'https://acme.example/delegations/7f3a',
  kyc_level: 'principal-verified',
  sig: 'test-passport-sig',
})

// A passport that resolves but carries no signing keys (degenerate identity record).
export const makeKeylessPassport = (): Passport => ({
  did: AGENT_DID,
  controller: PRINCIPAL_DID,
  keys: [],
  services: {},
  delegation_ref: null,
  kyc_level: 'unverified',
  sig: 'test-passport-sig',
})
