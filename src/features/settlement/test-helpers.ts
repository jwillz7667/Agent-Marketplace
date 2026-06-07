import Big from 'big.js'
import {
  signDetached,
  generateKeyPair,
  bytesToB64u,
  type KeyPair,
} from '../../shared/crypto/index'
import type {
  DelegationCredential,
  Eip3009Authorization,
  Money,
  PaymentPayload,
  Passport,
  Quote,
  Receipt,
  ReputationMetrics,
  ReputationSnapshot,
} from '../../domain/index'
import { newQuoteId } from '../../domain/index'
import type {
  ApprovalPort,
  IdentityResolver,
  Ledger,
  LedgerEntry,
  NonceStore,
  PendingApproval,
  PolicyAction,
  PolicyDecision,
  ReputationPort,
  WalletSigner,
} from '../../shared/ports/index'
import type { Config } from '../../shared/config/index'
import type { CoreSigner } from './core-signer'

export const TEST_CONFIG: Config = {
  PORT: 8080,
  NODE_ENV: 'test',
  PERSISTENCE: 'memory',
  GOV_API_KEY: 'test-gov-key',
  LOG_LEVEL: 'silent',
  SIGNATURE_SKEW_MS: 2000,
}

// Resolves Ed25519 public keys by DID. Unknown DIDs resolve null so verification fails closed.
export class FakeIdentity implements IdentityResolver {
  private readonly keys = new Map<string, Uint8Array>()

  register(did: string, publicKey: Uint8Array): void {
    this.keys.set(did, publicKey)
  }

  async resolvePassport(did: string): Promise<Passport | null> {
    const pub = this.keys.get(did)
    if (!pub) return null
    return {
      did,
      controller: 'did:praxis:org:test',
      keys: [{ id: '#sign-1', type: 'Ed25519', pub: bytesToB64u(pub) }],
      services: {},
      delegation_ref: null,
      kyc_level: 'principal-verified',
      sig: 'test',
    }
  }

  async publicKeyFor(did: string): Promise<Uint8Array | null> {
    return this.keys.get(did) ?? null
  }

  async activeDelegation(_did: string): Promise<DelegationCredential | null> {
    return null
  }

  async isRevoked(_did: string): Promise<boolean> {
    return false
  }
}

// Single-use nonce store; no expiry pruning needed for a deterministic test clock.
export class FakeNonces implements NonceStore {
  private readonly seen = new Set<string>()
  async checkAndConsume(nonce: string): Promise<boolean> {
    if (this.seen.has(nonce)) return false
    this.seen.add(nonce)
    return true
  }
}

// Records every ingested receipt + signal so tests can assert reputation effects, including the
// slashing-direction signals.
export class FakeReputation implements ReputationPort {
  readonly receipts: Receipt[] = []
  readonly signals: { did: string; kind: string; weight: number }[] = []

  async getSnapshot(_did: string): Promise<ReputationSnapshot | null> {
    return null
  }
  async getRaw(_did: string): Promise<ReputationMetrics | null> {
    return null
  }
  async ingestReceipt(receipt: Receipt): Promise<void> {
    this.receipts.push(receipt)
  }
  async ingestSignal(did: string, kind: string, weight: number): Promise<void> {
    this.signals.push({ did, kind, weight })
  }
}

// Append-only in-memory ledger fake (the foundation's real Ledger does the hash-chaining; the
// settlement module only needs append + list for its tests).
export class FakeLedger implements Ledger {
  readonly entries: LedgerEntry[] = []

  async append(input: { kind: string; subject?: string; payload: unknown }): Promise<LedgerEntry> {
    const seq = this.entries.length
    const entry: LedgerEntry = {
      seq,
      prevHash: seq === 0 ? '' : this.entries[seq - 1]!.hash,
      hash: `h${seq}`,
      ts: new Date().toISOString(),
      kind: input.kind,
      subject: input.subject,
      payload: input.payload,
    }
    this.entries.push(entry)
    return entry
  }
  async list(filter?: { kind?: string; subject?: string }): Promise<LedgerEntry[]> {
    return this.entries.filter(
      (e) => (filter?.kind ? e.kind === filter.kind : true) && (filter?.subject ? e.subject === filter.subject : true),
    )
  }
  async merkleRoot(): Promise<string> {
    return 'root'
  }
  async verifyChain(): Promise<boolean> {
    return true
  }
}

// Records enqueued approvals; tests assert the call was parked (and that no money moved).
// `resolve(...)` flips a parked approval to its supervisor ruling so escalation-resolution tests can
// redeem it; `consume(...)` enforces the same single-use + agent/action binding as production.
export class FakeApprovals implements ApprovalPort {
  readonly enqueued: PendingApproval[] = []
  private readonly byId = new Map<string, PendingApproval>()

  async enqueue(input: { agent: string; action: PolicyAction; payload: unknown }): Promise<PendingApproval> {
    const pending: PendingApproval = {
      approvalId: `apr_${this.enqueued.length}`,
      agent: input.agent,
      action: input.action,
      payload: input.payload,
      createdAt: new Date().toISOString(),
      status: 'pending',
      decision: null,
    }
    this.enqueued.push(pending)
    this.byId.set(pending.approvalId, pending)
    return pending
  }

  async status(approvalId: string): Promise<PendingApproval | null> {
    return this.byId.get(approvalId) ?? null
  }

  async consume(approvalId: string, expect: { agent: string; action: PolicyAction }): Promise<PendingApproval> {
    const existing = this.byId.get(approvalId)
    if (!existing) throw new Error(`approval ${approvalId} not found`)
    if (existing.status === 'consumed') throw new Error(`approval ${approvalId} already consumed`)
    if (existing.status === 'pending') throw new Error(`approval ${approvalId} not yet resolved`)
    if (existing.agent !== expect.agent) throw new Error(`approval ${approvalId} issued for a different agent`)
    if (!approvalActionMatches(existing.action, expect.action)) {
      throw new Error(`approval ${approvalId} does not authorize this action`)
    }
    const consumed: PendingApproval = { ...existing, status: 'consumed' }
    this.byId.set(approvalId, consumed)
    return consumed
  }

  // Test-only: simulate a supervisor ruling on a parked approval.
  resolve(approvalId: string, decision: 'approved' | 'denied'): void {
    const existing = this.byId.get(approvalId)
    if (!existing) throw new Error(`approval ${approvalId} not found`)
    this.byId.set(approvalId, { ...existing, status: decision, decision })
  }
}

const approvalActionMatches = (a: PolicyAction, b: PolicyAction): boolean => {
  if (a.kind !== b.kind || a.agent !== b.agent) return false
  if ((a.counterparty ?? null) !== (b.counterparty ?? null)) return false
  if ((a.category ?? null) !== (b.category ?? null)) return false
  if ((a.subKind ?? null) !== (b.subKind ?? null)) return false
  const ca = a.amount ?? null
  const cb = b.amount ?? null
  if (ca === null || cb === null) return ca === cb
  return ca.currency === cb.currency && new Big(ca.amount).eq(cb.amount)
}

// A configurable WalletSigner implementing the §4.3 hard stop. The decider maps an action to a
// PolicyDecision; the signer refuses to sign on anything other than `allow`, so a deny /
// needs_approval is returned WITHOUT producing a signature — modeling the below-the-agent backstop
// that no money can move past. The default decider allows everything.
export class FakeSigner implements WalletSigner {
  readonly attempts: PolicyAction[] = []

  constructor(private readonly decide: (action: PolicyAction) => PolicyDecision = () => ({ result: 'allow' })) {}

  async signWithinPolicy(input: { did: string; payload: unknown; action: PolicyAction }): Promise<
    { ok: true; sig: string } | { ok: false; decision: PolicyDecision }
  > {
    this.attempts.push(input.action)
    const decision = this.decide(input.action)
    if (decision.result === 'allow') return { ok: true, sig: `sig:${input.did}` }
    return { ok: false, decision }
  }
}

// Build a signer that denies/parks spends over a cap (and allows everything else).
export const capSigner = (capUsdc: string, over: 'deny' | 'needs_approval'): FakeSigner =>
  new FakeSigner((action) => {
    if (action.amount && action.amount.currency === 'USDC' && new Big(action.amount.amount).gt(capUsdc)) {
      return over === 'deny'
        ? { result: 'deny', reasons: [`exceeds per-tx cap ${capUsdc}`] }
        : { result: 'needs_approval', threshold: { amount: capUsdc, currency: 'USDC' }, reasons: ['over threshold'] }
    }
    return { result: 'allow' }
  })

export const makeCoreSigner = async (did = 'did:praxis:core:facilitator', kid = 'facilitator#sign-1'): Promise<CoreSigner> => {
  const kp = await generateKeyPair()
  return { did, kid, privateKey: kp.privateKey, publicKey: kp.publicKey }
}

// Build + sign a §5.2 Quote with the registry core key (omit only `sig`, matching skipNonce
// verification in the facilitator).
export const signQuote = async (
  registry: CoreSigner,
  opts: {
    listingId: string
    requester: string
    amount?: string
    currency?: string
    rail?: string
    issued?: string
    expires?: string
    listingVersion?: string
  },
): Promise<Quote> => {
  const unsigned = {
    quote_id: newQuoteId(),
    listing_id: opts.listingId,
    listing_version: opts.listingVersion ?? '3.2.0',
    price: { amount: opts.amount ?? '0.02', currency: opts.currency ?? 'USDC', per: 'call' },
    rail: opts.rail ?? 'x402',
    requester: opts.requester,
    issued: opts.issued ?? '2026-06-06T15:00:00.000Z',
    expires: opts.expires ?? '2026-06-06T15:05:00.000Z',
  }
  const sig = await signDetached(unsigned, registry.privateKey, registry.kid)
  return { ...unsigned, sig }
}

// Build + sign a §5.3 PaymentPayload with the payer's key (omit only `sig`).
export const signPayment = async (
  payerKeys: KeyPair,
  opts: {
    from: string
    to: string
    quote: Quote
    rail?: string
    nonce?: string
    iat?: string
    exp?: string
    validAfter?: string
    validBefore?: string
    authNonce?: string
  },
): Promise<PaymentPayload> => {
  const rail = opts.rail ?? opts.quote.rail
  const authorization: Eip3009Authorization = {
    from: opts.from,
    to: opts.to,
    value: opts.quote.price.amount,
    validAfter: opts.validAfter ?? '2026-06-06T14:00:00.000Z',
    validBefore: opts.validBefore ?? '2026-06-06T16:00:00.000Z',
    nonce: opts.authNonce ?? `auth-${Math.random()}`,
  }
  const unsigned = {
    scheme: 'exact' as const,
    rail,
    authorization,
    quote_id: opts.quote.quote_id,
    from: opts.from,
    to: opts.to,
    amount: opts.quote.price.amount,
    currency: opts.quote.price.currency,
    nonce: opts.nonce ?? `pay-${Math.random()}`,
    iat: opts.iat ?? '2026-06-06T15:00:00.000Z',
    exp: opts.exp ?? '2026-06-06T15:10:00.000Z',
  }
  const sig = await signDetached(unsigned, payerKeys.privateKey, `${opts.from}#sign-1`)
  return { ...unsigned, sig }
}

// Build + sign an escrow open request: both party signatures over the contract minus both sigs +
// the open-call envelope fields, matching CONTRACT_OMIT.
export const signEscrowOpen = async (opts: {
  escrowId: string
  jobRef: string
  payer: string
  payee: string
  payerKeys: KeyPair
  payeeKeys: KeyPair
  total: string
  currency?: string
  milestones: { id: string; amount: string; acceptance: { type: 'schema' | 'checksum' | 'schema+checksum' | 'oracle'; schema_ref?: string; expected?: string } }[]
  deliverBy?: string
  onTimeout?: 'refund' | 'release' | 'arbitrate'
  disputeWindowMs?: number
  stakeAmount?: string
  stakeSlashable?: boolean
  nonce?: string
  iat?: string
  exp?: string
}): Promise<Record<string, unknown>> => {
  const currency = opts.currency ?? 'USDC'
  const base = {
    escrow_id: opts.escrowId,
    job_ref: opts.jobRef,
    payer: opts.payer,
    payee: opts.payee,
    amount: { amount: opts.total, currency },
    milestones: opts.milestones,
    deliver_by: opts.deliverBy ?? '2026-06-08T00:00:00.000Z',
    on_timeout: opts.onTimeout ?? 'refund',
    dispute_window_ms: opts.disputeWindowMs ?? 86400000,
    provider_stake: { amount: opts.stakeAmount ?? '10.00', currency, slashable: opts.stakeSlashable ?? true },
  }
  const sigPayer = await signDetached(base, opts.payerKeys.privateKey, `${opts.payer}#sign-1`)
  const sigPayee = await signDetached(base, opts.payeeKeys.privateKey, `${opts.payee}#sign-1`)
  return {
    ...base,
    sig_payer: sigPayer,
    sig_payee: sigPayee,
    nonce: opts.nonce ?? `esc-${Math.random()}`,
    iat: opts.iat ?? '2026-06-06T15:00:00.000Z',
    exp: opts.exp ?? '2026-06-06T15:10:00.000Z',
  }
}

// Sign a simple enveloped body (deliver/accept/dispute/stake/tip) with the given signer key over
// the object minus `sig`.
export const signEnvelope = async (
  body: Record<string, unknown>,
  signerDid: string,
  keys: KeyPair,
): Promise<Record<string, unknown>> => {
  const sig = await signDetached(body, keys.privateKey, `${signerDid}#sign-1`)
  return { ...body, sig }
}

export { generateKeyPair, type KeyPair }
export type { Money }
