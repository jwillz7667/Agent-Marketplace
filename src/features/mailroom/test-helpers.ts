import {
  signDetached,
  generateKeyPair,
  bytesToB64u,
  type KeyPair,
} from '../../shared/crypto/index'
import type {
  DelegationCredential,
  DelegationPolicy,
  Money,
  Passport,
  Receipt,
  ReputationMetrics,
  ReputationSnapshot,
} from '../../domain/index'
import type {
  IdentityResolver,
  NonceStore,
  PolicyAction,
  PolicyDecision,
  PolicyEvaluator,
  ReputationPort,
  SpendUsage,
  ValueTransferPort,
} from '../../shared/ports/index'
import type { CoreSigner, MailroomConfig } from './service'
import { SendMessageSchema, type SendMessageInput } from './schema'

// Test fakes for the consumed ports. Minimal but faithful to each port's contract.

export const TEST_CONFIG: MailroomConfig = {
  SIGNATURE_SKEW_MS: 2000,
  POSTAGE_AMOUNT: '0.001',
  POSTAGE_CURRENCY: 'USDC',
  POSTAGE_BURN_FRACTION: 0.5,
  SPAM_SIGNAL_WEIGHT: 1,
}

// FakeIdentity resolves Ed25519 public keys + an optional active delegation per DID.
export class FakeIdentity implements IdentityResolver {
  private readonly keys = new Map<string, Uint8Array>()
  private readonly delegations = new Map<string, DelegationCredential>()
  private readonly revoked = new Set<string>()

  register(did: string, publicKey: Uint8Array): void {
    this.keys.set(did, publicKey)
  }

  setDelegation(did: string, delegation: DelegationCredential): void {
    this.delegations.set(did, delegation)
  }

  setRevoked(did: string): void {
    this.revoked.add(did)
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

  async isRevoked(did: string): Promise<boolean> {
    return this.revoked.has(did)
  }
}

// FakeNonces: single-use, no expiry pruning for a deterministic test clock.
export class FakeNonces implements NonceStore {
  private readonly seen = new Set<string>()
  async checkAndConsume(nonce: string): Promise<boolean> {
    if (this.seen.has(nonce)) return false
    this.seen.add(nonce)
    return true
  }
}

// FakeReputation records ingested spam signals so tests can assert the §7.4 penalty stacked.
export class FakeReputation implements ReputationPort {
  readonly signals: Array<{ did: string; kind: string; weight: number }> = []

  async getSnapshot(_did: string): Promise<ReputationSnapshot | null> {
    return null
  }
  async getRaw(_did: string): Promise<ReputationMetrics | null> {
    return null
  }
  async ingestReceipt(_receipt: Receipt): Promise<void> {}
  async ingestSignal(did: string, kind: string, weight: number): Promise<void> {
    this.signals.push({ did, kind, weight })
  }
}

// FakeValueTransfer tracks holds + their terminal disposition so tests assert release/forfeit.
type HoldState = 'held' | 'released' | 'captured' | 'forfeited'
export interface HoldRecord {
  readonly holdId: string
  readonly did: string
  readonly amount: Money
  readonly ref: string
  state: HoldState
}

export class FakeValueTransfer implements ValueTransferPort {
  readonly holds = new Map<string, HoldRecord>()
  private seq = 0

  async balanceOf(_did: string, currency: string): Promise<Money> {
    return { amount: '0', currency }
  }
  async credit(_did: string, _amount: Money, _ref: string): Promise<void> {}
  async debit(_did: string, _amount: Money, _ref: string): Promise<void> {}

  async hold(did: string, amount: Money, ref: string): Promise<string> {
    const holdId = `hold_${++this.seq}`
    this.holds.set(holdId, { holdId, did, amount, ref, state: 'held' })
    return holdId
  }
  async release(holdId: string): Promise<void> {
    const h = this.holds.get(holdId)
    if (h) h.state = 'released'
  }
  async capture(holdId: string, _to: string): Promise<void> {
    const h = this.holds.get(holdId)
    if (h) h.state = 'captured'
  }
  async forfeit(holdId: string, _split?: { toRecipient: string; burnFraction: number }): Promise<void> {
    const h = this.holds.get(holdId)
    if (h) h.state = 'forfeited'
  }
}

// FakePolicy: coarse messaging gate (the §4.3 pre-flight). Denies if messaging.send is false
// or the counterparty is on the deny list. It deliberately does NOT re-implement the numeric
// per-day postage cap: that precise accounting is the mailroom's own responsibility (§7.4), so
// the service's PaymentRequiredError day-cap path can be exercised independently of policy.
export class FakePolicy implements PolicyEvaluator {
  private readonly approvalRequired = new Set<string>()

  // Flip a sender to needs_approval so a test can exercise the fail-closed approval path.
  needsApproval(did: string): void {
    this.approvalRequired.add(did)
  }

  evaluate(delegation: DelegationCredential, action: PolicyAction, _usage: SpendUsage): PolicyDecision {
    if (action.kind !== 'message') return { result: 'allow' }
    const msg = delegation.policy.messaging
    if (!msg.send) return { result: 'deny', reasons: ['messaging.send disabled'] }
    if (action.counterparty && delegation.policy.counterparties_deny.includes(action.counterparty)) {
      return { result: 'deny', reasons: [`counterparty ${action.counterparty} denied`] }
    }
    if (this.approvalRequired.has(action.agent)) {
      return { result: 'needs_approval', threshold: { amount: '0', currency: 'USDC' }, reasons: ['over threshold in test'] }
    }
    return { result: 'allow' }
  }
}

export const makeCoreSigner = async (): Promise<CoreSigner> => {
  const kp = await generateKeyPair()
  return {
    did: 'did:praxis:core:mailroom',
    kid: 'mailroom#sign-1',
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
  }
}

// Build a delegation whose messaging policy permits sending up to `maxPostagePerDay`.
export interface DelegationOverrides {
  send?: boolean
  maxPostagePerDay?: string
  counterpartiesDeny?: readonly string[]
}

export const makeDelegation = (
  principal: string,
  agent: string,
  o: DelegationOverrides = {},
): DelegationCredential => {
  const money = (amount: string): Money => ({ amount, currency: 'USDC' })
  const policy: DelegationPolicy = {
    spend: { per_tx_max: money('10'), daily_max: money('100'), total_max: money('1000') },
    categories_allow: [],
    categories_deny: [],
    counterparties_allow: [],
    counterparties_deny: o.counterpartiesDeny ?? [],
    require_human_approval_over: money('50'),
    messaging: { send: o.send ?? true, max_postage_per_day: o.maxPostagePerDay ?? '1.000' },
    posting: { offers: true, rfps: true, max_post_spend_per_day: '1.000' },
    escrow: { may_commit: true, max_escrow: money('500') },
    may_stake: true,
  }
  return {
    type: ['VerifiableCredential', 'PraxisDelegation'],
    issuer: principal,
    subject: agent,
    policy,
    issued: '2026-01-01T00:00:00Z',
    expires: '2027-01-01T00:00:00Z',
    revocation: 'https://praxis.example/revoke',
    sig: 'test-delegation-sig',
  }
}

// ---------------------------------------------------------------------------
// Message builders. Each returns a fully-signed §7.1 message envelope. The
// caller signs over the object minus `sig` (matching verifySignedObject's default).
// ---------------------------------------------------------------------------

let msgSeq = 0
export const freshMsgId = (): string => `msg_TEST_${++msgSeq}`

export interface SignedMsgOpts {
  msgId?: string
  threadId?: string
  inReplyTo?: string | null
  refs?: Record<string, unknown>
  nonce?: string
  iat?: string
  exp?: string
}

// Sign an arbitrary object (flag/inbox/webhook envelopes). Returns the object + detached JWS.
const signObject = async <T extends Record<string, unknown>>(
  senderKeys: KeyPair,
  sender: string,
  draft: T,
): Promise<T & { sig: string }> => {
  const sig = await signDetached(draft, senderKeys.privateKey, `${sender}#sign-1`)
  return { ...draft, sig }
}

// Sign a §7.1 message envelope and validate it through the discriminated-union schema so the
// returned value is a precisely-typed SendMessageInput (no casts; the schema is the contract).
const signMessage = async (
  senderKeys: KeyPair,
  sender: string,
  recipient: string,
  type: string,
  body: unknown,
  o: SignedMsgOpts,
): Promise<SendMessageInput> => {
  const draft: Record<string, unknown> = {
    msg_id: o.msgId ?? freshMsgId(),
    ...(o.threadId !== undefined ? { thread_id: o.threadId } : {}),
    in_reply_to: o.inReplyTo ?? null,
    from: sender,
    to: recipient,
    type,
    body,
    ...(o.refs !== undefined ? { refs: o.refs } : {}),
    nonce: o.nonce ?? `nonce-${Math.random()}`,
    iat: o.iat ?? '2026-06-06T15:00:00Z',
    exp: o.exp ?? '2026-06-13T15:00:00Z',
  }
  const sig = await signDetached(draft, senderKeys.privateKey, `${sender}#sign-1`)
  return SendMessageSchema.parse({ ...draft, sig })
}

export const signQuoteRequest = (
  sender: string,
  keys: KeyPair,
  recipient: string,
  o: SignedMsgOpts = {},
) =>
  signMessage(keys, sender, recipient, 'QUOTE_REQUEST', { capability: 'doc.extract.tables', volume_estimate: 10000 }, o)

export const signInquiry = (sender: string, keys: KeyPair, recipient: string, o: SignedMsgOpts = {}) =>
  signMessage(keys, sender, recipient, 'INQUIRY', { capability: 'doc.extract.tables' }, o)

export interface QuoteOpts extends SignedMsgOpts {
  quoteId?: string
  listingId?: string
  price?: { amount: string; currency: string; per: string }
  milestones?: Array<{ id: string; amount: { amount: string; currency: string } }>
}

export const signQuote = (sender: string, keys: KeyPair, recipient: string, o: QuoteOpts = {}) => {
  const quoteId = o.quoteId ?? 'qt_TEST_1'
  const listingId = o.listingId ?? 'lst_TEST_1'
  const price = o.price ?? { amount: '250', currency: 'USDC', per: 'job' }
  const body = {
    quote: {
      quote_id: quoteId,
      listing_id: listingId,
      listing_version: '3.2.0',
      price,
      rail: 'x402-usdc-base',
      requester: recipient,
      issued: '2026-06-06T15:00:00Z',
      expires: '2026-06-06T15:05:00Z',
      sig: 'provider-quote-sig',
    },
    ...(o.milestones !== undefined ? { milestones: o.milestones } : {}),
  }
  const refs = o.refs ?? { listing_ref: listingId, quote_id: quoteId }
  return signMessage(keys, sender, recipient, 'QUOTE', body, { ...o, refs })
}

export const signCounter = (sender: string, keys: KeyPair, recipient: string, o: SignedMsgOpts = {}) =>
  signMessage(keys, sender, recipient, 'COUNTER', { price: { amount: '240', currency: 'USDC' } }, o)

export interface AcceptOpts extends SignedMsgOpts {
  acceptsQuoteId?: string
}

export const signAccept = (sender: string, keys: KeyPair, recipient: string, o: AcceptOpts = {}) =>
  signMessage(keys, sender, recipient, 'ACCEPT', { accepts_quote_id: o.acceptsQuoteId ?? 'qt_TEST_1' }, o)

export const signFlag = async (
  flagger: string,
  keys: KeyPair,
  kind: 'legit' | 'spam',
  o: { nonce?: string; iat?: string; exp?: string } = {},
) => {
  const draft = {
    flagger,
    kind,
    nonce: o.nonce ?? `nonce-flag-${Math.random()}`,
    iat: o.iat ?? '2026-06-06T15:00:00Z',
    exp: o.exp ?? '2026-06-13T15:00:00Z',
  }
  return signObject(keys, flagger, draft)
}

export const signInboxQuery = async (
  recipient: string,
  keys: KeyPair,
  o: { since?: number; limit?: number; nonce?: string; iat?: string; exp?: string } = {},
) => {
  const draft = {
    recipient,
    since: o.since ?? 0,
    limit: o.limit ?? 50,
    nonce: o.nonce ?? `nonce-inbox-${Math.random()}`,
    iat: o.iat ?? '2026-06-06T15:00:00Z',
    exp: o.exp ?? '2026-06-13T15:00:00Z',
  }
  return signObject(keys, recipient, draft)
}

export const signWebhook = async (
  owner: string,
  keys: KeyPair,
  url: string,
  o: { nonce?: string; iat?: string; exp?: string } = {},
) => {
  const draft = {
    owner,
    url,
    nonce: o.nonce ?? `nonce-wh-${Math.random()}`,
    iat: o.iat ?? '2026-06-06T15:00:00Z',
    exp: o.exp ?? '2026-06-13T15:00:00Z',
  }
  return signObject(keys, owner, draft)
}
