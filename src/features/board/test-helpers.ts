import { signDetached, bytesToB64u, type KeyPair } from '../../shared/crypto/index'
import type {
  DelegationCredential,
  DelegationPolicy,
  Money,
  Passport,
  Receipt,
  ReputationMetrics,
  ReputationSnapshot,
} from '../../domain/index'
import { newPostId } from '../../domain/index'
import type {
  IdentityResolver,
  Ledger,
  LedgerEntry,
  NonceStore,
  PolicyAction,
  PolicyDecision,
  PolicyEvaluator,
  ReputationPort,
  SpendUsage,
  ValueTransferPort,
} from '../../shared/ports/index'
import type { Config } from '../../shared/config/index'
import { sha256Hex } from '../../shared/crypto/index'
import type { BoardPostInput } from './schema'

// Test fakes for the board's consumed ports — minimal but contract-faithful.

export const TEST_CONFIG: Config = {
  PORT: 8080,
  NODE_ENV: 'test',
  PERSISTENCE: 'memory',
  GOV_API_KEY: 'test-gov-key',
  LOG_LEVEL: 'silent',
  SIGNATURE_SKEW_MS: 2000,
}

const defaultPolicy = (): DelegationPolicy => ({
  spend: {
    per_tx_max: { amount: '100', currency: 'USDC' },
    daily_max: { amount: '1000', currency: 'USDC' },
    total_max: { amount: '10000', currency: 'USDC' },
  },
  categories_allow: [],
  categories_deny: [],
  counterparties_allow: [],
  counterparties_deny: [],
  require_human_approval_over: { amount: '500', currency: 'USDC' },
  messaging: { send: true, max_postage_per_day: '10' },
  posting: { offers: true, rfps: true, max_post_spend_per_day: '5' },
  escrow: { may_commit: true, max_escrow: { amount: '500', currency: 'USDC' } },
  may_stake: true,
})

const makeDelegation = (subject: string): DelegationCredential => ({
  type: ['VerifiableCredential', 'PraxisDelegation'],
  issuer: 'did:praxis:org:test',
  subject,
  policy: defaultPolicy(),
  issued: '2026-06-01T00:00:00Z',
  expires: '2026-12-01T00:00:00Z',
  revocation: 'https://gov.example/revoke',
  sig: 'test',
})

// FakeIdentity resolves Ed25519 public keys by DID and grants an active delegation to any DID
// registered with `registerWithDelegation`. DIDs registered key-only have no delegation, so the
// policy gate fails closed for them.
export class FakeIdentity implements IdentityResolver {
  private readonly keys = new Map<string, Uint8Array>()
  private readonly delegations = new Map<string, DelegationCredential>()

  register(did: string, publicKey: Uint8Array): void {
    this.keys.set(did, publicKey)
  }

  registerWithDelegation(did: string, publicKey: Uint8Array): void {
    this.keys.set(did, publicKey)
    this.delegations.set(did, makeDelegation(did))
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

  async activeDelegation(did: string): Promise<DelegationCredential | null> {
    return this.delegations.get(did) ?? null
  }

  async isRevoked(_did: string): Promise<boolean> {
    return false
  }
}

// FakePolicy: allows posting when the delegation permits the post sub-kind; otherwise denies.
// Lets a test flip a DID to denied to exercise the ForbiddenError path.
export class FakePolicy implements PolicyEvaluator {
  private readonly denied = new Set<string>()

  deny(did: string): void {
    this.denied.add(did)
  }

  evaluate(delegation: DelegationCredential, action: PolicyAction, _usage: SpendUsage): PolicyDecision {
    if (this.denied.has(action.agent)) return { result: 'deny', reasons: ['posting blocked in test'] }
    if (action.kind === 'post') {
      if (action.subKind === 'offer' && !delegation.policy.posting.offers) {
        return { result: 'deny', reasons: ['offers not permitted'] }
      }
      if (action.subKind === 'rfp' && !delegation.policy.posting.rfps) {
        return { result: 'deny', reasons: ['rfps not permitted'] }
      }
    }
    return { result: 'allow' }
  }
}

interface Hold {
  readonly did: string
  readonly amount: Money
  readonly ref: string
  status: 'held' | 'released' | 'captured' | 'forfeited'
}

// FakeValueTransfer tracks holds keyed by ref (the board holds under post_id). It records the
// terminal state per hold so a test can assert a forfeit happened. balanceOf is unused by the board.
export class FakeValueTransfer implements ValueTransferPort {
  readonly holdsByRef = new Map<string, Hold>()
  private seq = 0

  async balanceOf(_did: string, currency: string): Promise<Money> {
    return { amount: '0', currency }
  }
  async credit(_did: string, _amount: Money, _ref: string): Promise<void> {}
  async debit(_did: string, _amount: Money, _ref: string): Promise<void> {}

  async hold(did: string, amount: Money, ref: string): Promise<string> {
    this.holdsByRef.set(ref, { did, amount, ref, status: 'held' })
    return `hold_${++this.seq}`
  }

  // The board passes the post_id (the same ref used to create the hold) to release/forfeit.
  async release(holdId: string): Promise<void> {
    const h = this.holdsByRef.get(holdId)
    if (h) h.status = 'released'
  }
  async capture(holdId: string, _to: string): Promise<void> {
    const h = this.holdsByRef.get(holdId)
    if (h) h.status = 'captured'
  }
  async forfeit(holdId: string, _split?: { toRecipient: string; burnFraction: number }): Promise<void> {
    const h = this.holdsByRef.get(holdId)
    if (h) h.status = 'forfeited'
  }
}

// FakeReputation: seedable snapshots + a record of ingested signals (for the flag→post_flag test).
export class FakeReputation implements ReputationPort {
  private readonly snapshots = new Map<string, ReputationSnapshot>()
  readonly signals: { did: string; kind: string; weight: number }[] = []

  setSnapshot(did: string, snapshot: ReputationSnapshot): void {
    this.snapshots.set(did, snapshot)
  }

  async getSnapshot(did: string): Promise<ReputationSnapshot | null> {
    return this.snapshots.get(did) ?? null
  }
  async getRaw(_did: string): Promise<ReputationMetrics | null> {
    return null
  }
  async ingestReceipt(_receipt: Receipt): Promise<void> {}
  async ingestSignal(did: string, kind: string, weight: number): Promise<void> {
    this.signals.push({ did, kind, weight })
  }
}

// FakeLedger: an append log the board reads for WORK_RECORD receipt links and writes
// board_anchor entries to. Receipts are pre-seeded by the test.
export class FakeLedger implements Ledger {
  private readonly entries: LedgerEntry[] = []
  private prevHash = '0'.repeat(64)

  seedReceipt(receipt: Receipt): void {
    this.pushEntry('receipt', receipt.listing_id ?? undefined, receipt)
  }

  private pushEntry(kind: string, subject: string | undefined, payload: unknown): LedgerEntry {
    const seq = this.entries.length + 1
    const hash = sha256Hex(this.prevHash + kind + seq)
    const entry: LedgerEntry = {
      seq,
      prevHash: this.prevHash,
      hash,
      ts: '2026-06-06T15:00:00.000Z',
      kind,
      ...(subject !== undefined ? { subject } : {}),
      payload,
    }
    this.prevHash = hash
    this.entries.push(entry)
    return entry
  }

  async append(input: { kind: string; subject?: string; payload: unknown }): Promise<LedgerEntry> {
    return this.pushEntry(input.kind, input.subject, input.payload)
  }

  async list(filter?: { kind?: string; subject?: string }): Promise<LedgerEntry[]> {
    return this.entries.filter(
      (e) =>
        (filter?.kind === undefined || e.kind === filter.kind) &&
        (filter?.subject === undefined || e.subject === filter.subject),
    )
  }

  async merkleRoot(): Promise<string> {
    return this.prevHash
  }
  async verifyChain(): Promise<boolean> {
    return true
  }
}

export class FakeNonces implements NonceStore {
  private readonly seen = new Set<string>()
  async checkAndConsume(nonce: string): Promise<boolean> {
    if (this.seen.has(nonce)) return false
    this.seen.add(nonce)
    return true
  }
}

const IAT = '2026-06-06T15:00:00Z'
const EXP = '2026-06-06T15:30:00Z'

let nonceCounter = 0
const freshNonce = (): string => `nonce-${Date.now()}-${++nonceCounter}`

// Build + author-sign a board post. The author signs the body minus [sig, counterparty_sig?,
// chain fields] — exactly the omit list the service verifies — so chain fields are NEVER part of
// the signing input. The returned object omits chain fields; the Zod schema defaults them.
export interface PostOverrides {
  post_id?: string
  created?: string
  iat?: string
  exp?: string
  nonce?: string
}

const signBody = async (
  body: Record<string, unknown>,
  authorKeys: KeyPair,
  author: string,
  omit: readonly string[],
): Promise<string> => {
  const signing: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) if (!omit.includes(k)) signing[k] = v
  return signDetached(signing, authorKeys.privateKey, `${author}#sign-1`)
}

export const signOffer = async (
  author: string,
  authorKeys: KeyPair,
  o: PostOverrides & { capability?: string; listingRef?: string; price?: string; regions?: string[] } = {},
): Promise<BoardPostInput> => {
  const body: Record<string, unknown> = {
    type: 'OFFER',
    post_id: o.post_id ?? newPostId(),
    author,
    created: o.created ?? IAT,
    capability: o.capability ?? 'doc.extract.tables',
    listing_ref: o.listingRef ?? 'lst_OFFER1',
    price_from: { amount: o.price ?? '0.02', currency: 'USDC', per: 'call' },
    regions: o.regions ?? ['US', 'EU'],
    expires: '2026-07-01T00:00:00Z',
    stake: { amount: '50.00', currency: 'USDC', slashable: true },
    nonce: o.nonce ?? freshNonce(),
    iat: o.iat ?? IAT,
    exp: o.exp ?? EXP,
  }
  const sig = await signBody(body, authorKeys, author, ['sig'])
  return { ...body, sig } as unknown as BoardPostInput
}

export const signRfp = async (
  author: string,
  authorKeys: KeyPair,
  o: PostOverrides & { capability?: string; budget?: string } = {},
): Promise<BoardPostInput> => {
  const body: Record<string, unknown> = {
    type: 'RFP',
    post_id: o.post_id ?? newPostId(),
    author,
    created: o.created ?? IAT,
    capability: o.capability ?? 'data.enrich.company',
    spec: { input_schema_ref: 'praxis:schema:in', output_schema_ref: 'praxis:schema:out', volume: 50000 },
    budget: { amount: o.budget ?? '300.00', currency: 'USDC' },
    deadline: '2026-06-12T00:00:00Z',
    acceptance: { type: 'schema+checksum' },
    bid_via: 'mailroom',
    nonce: o.nonce ?? freshNonce(),
    iat: o.iat ?? IAT,
    exp: o.exp ?? EXP,
  }
  const sig = await signBody(body, authorKeys, author, ['sig'])
  return { ...body, sig } as unknown as BoardPostInput
}

export const signAnnouncement = async (
  author: string,
  authorKeys: KeyPair,
  o: PostOverrides = {},
): Promise<BoardPostInput> => {
  const body: Record<string, unknown> = {
    type: 'ANNOUNCEMENT',
    post_id: o.post_id ?? newPostId(),
    author,
    created: o.created ?? IAT,
    subject: 'lst_X',
    change: 'version 3.2.0 -> 3.3.0',
    effective: '2026-06-20T00:00:00Z',
    nonce: o.nonce ?? freshNonce(),
    iat: o.iat ?? IAT,
    exp: o.exp ?? EXP,
  }
  const sig = await signBody(body, authorKeys, author, ['sig'])
  return { ...body, sig } as unknown as BoardPostInput
}

// Build a WORK_RECORD. The author signs over the body minus [sig, counterparty_sig, chain
// fields]; the counterparty signs the SAME body minus the same set. `withCounterpartySig`
// controls whether a valid co-signature is attached (false → a bogus placeholder, to test the
// reject path).
export const signWorkRecord = async (
  author: string,
  authorKeys: KeyPair,
  counterparty: string,
  counterpartyKeys: KeyPair,
  receiptRef: string,
  o: PostOverrides & { withCounterpartySig?: boolean; latencyMs?: number } = {},
): Promise<BoardPostInput> => {
  const base: Record<string, unknown> = {
    type: 'WORK_RECORD',
    post_id: o.post_id ?? newPostId(),
    author,
    created: o.created ?? IAT,
    receipt_ref: receiptRef,
    counterparty,
    outcome: 'accepted',
    latency_ms: o.latencyMs ?? 870,
    nonce: o.nonce ?? freshNonce(),
    iat: o.iat ?? IAT,
    exp: o.exp ?? EXP,
  }
  // Author signs minus [sig, counterparty_sig] (chain fields are absent here).
  const authorSig = await signBody(base, authorKeys, author, ['sig', 'counterparty_sig'])
  // Counterparty co-signs the same body minus [sig, counterparty_sig].
  const cpSig =
    (o.withCounterpartySig ?? true)
      ? await signBody(base, counterpartyKeys, counterparty, ['sig', 'counterparty_sig'])
      : 'INVALID-COUNTERPARTY-SIG'
  return { ...base, counterparty_sig: cpSig, sig: authorSig } as unknown as BoardPostInput
}

export const makeReceipt = (overrides: Partial<Receipt> & Pick<Receipt, 'receipt_id' | 'payer' | 'payee'>): Receipt => ({
  receipt_id: overrides.receipt_id,
  quote_id: overrides.quote_id ?? 'qt_1',
  listing_id: overrides.listing_id ?? 'lst_1',
  listing_version: overrides.listing_version ?? '3.2.0',
  job_ref: overrides.job_ref ?? null,
  payer: overrides.payer,
  payee: overrides.payee,
  amount: overrides.amount ?? { amount: '0.02', currency: 'USDC' },
  rail: overrides.rail ?? 'x402-usdc-base',
  result_hash: overrides.result_hash ?? 'sha256:deadbeef',
  latency_ms: overrides.latency_ms ?? 870,
  outcome: overrides.outcome ?? 'delivered',
  settled_at: overrides.settled_at ?? '2026-06-06T15:00:02Z',
  facilitator_sig: overrides.facilitator_sig ?? 'fac-sig',
  payee_sig: overrides.payee_sig ?? 'payee-sig',
})

export const makeSnapshot = (subject: string, trust: number): ReputationSnapshot => ({
  snapshot_id: `rep_${subject}`,
  subject,
  window: '30d',
  metrics: {
    success_rate: 0.99,
    dispute_rate: 0.004,
    refund_rate: 0.006,
    latency_ms: { p50: 870, p95: 3100 },
    uptime: 0.997,
    jobs: 100,
    settled_value: '421.55',
    stake: '250.00',
    first_seen: '2025-12-02T00:00:00Z',
    last_settled: '2026-06-05T00:00:00Z',
    counterparty_diversity: 0.9,
    spam_flags: 0,
    post_flags: 0,
  },
  trust,
  issued: '2026-06-06T00:00:00Z',
  expires: '2026-06-07T00:00:00Z',
  issuer: 'did:praxis:core:reputation',
  sig: 'test',
})

export const signTombstoneReq = async (
  author: string,
  authorKeys: KeyPair,
  o: { reason?: string; nonce?: string } = {},
): Promise<{ author: string; reason: string; nonce: string; iat: string; exp: string; sig: string }> => {
  const body = {
    author,
    reason: o.reason ?? 'retracted',
    nonce: o.nonce ?? freshNonce(),
    iat: IAT,
    exp: EXP,
  }
  const sig = await signDetached(body, authorKeys.privateKey, `${author}#sign-1`)
  return { ...body, sig }
}

export const signFlagReq = async (
  flagger: string,
  flaggerKeys: KeyPair,
  o: { category?: 'spam' | 'fraud' | 'injection' | 'malware' | 'other'; reason?: string; nonce?: string } = {},
): Promise<{
  flagger: string
  reason: string
  category: 'spam' | 'fraud' | 'injection' | 'malware' | 'other'
  nonce: string
  iat: string
  exp: string
  sig: string
}> => {
  const body = {
    flagger,
    reason: o.reason ?? 'spam',
    category: o.category ?? ('spam' as const),
    nonce: o.nonce ?? freshNonce(),
    iat: IAT,
    exp: EXP,
  }
  const sig = await signDetached(body, flaggerKeys.privateKey, `${flagger}#sign-1`)
  return { ...body, sig }
}

export const signSubscribe = async (
  subscriber: string,
  subscriberKeys: KeyPair,
  topics: string[],
  o: { webhookUrl?: string; nonce?: string } = {},
): Promise<{ subscriber: string; topics: string[]; webhook_url?: string; nonce: string; iat: string; exp: string; sig: string }> => {
  const body: Record<string, unknown> = {
    subscriber,
    topics,
    ...(o.webhookUrl !== undefined ? { webhook_url: o.webhookUrl } : {}),
    nonce: o.nonce ?? freshNonce(),
    iat: IAT,
    exp: EXP,
  }
  const sig = await signDetached(body, subscriberKeys.privateKey, `${subscriber}#sign-1`)
  return { ...body, sig } as {
    subscriber: string
    topics: string[]
    webhook_url?: string
    nonce: string
    iat: string
    exp: string
    sig: string
  }
}
