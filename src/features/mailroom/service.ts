import Big from 'big.js'
import type { Message, MessageType, ThreadState, Money } from '../../domain/index'
import { newThreadId, nextThreadState, isTerminalThreadState } from '../../domain/index'
import { signDetached } from '../../shared/crypto/index'
import { newId } from '../../domain/index'
import type {
  Clock,
  IdentityResolver,
  NonceStore,
  PolicyEvaluator,
  ReputationPort,
  ValueTransferPort,
} from '../../shared/ports/index'
import { verifySignedObject } from '../../shared/http/index'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PaymentRequiredError,
  ValidationError,
} from '../../shared/errors'
import type { FlagRepo, MessageRepo, PostageRepo, ThreadRepo, WebhookRepo } from './repo'
import type {
  Agreement,
  FlagBodyInput,
  FlagResponse,
  InboxQueryInput,
  InboxResponse,
  SendMessageInput,
  SendResponse,
  WebhookRegisterInput,
  WebhookResponse,
} from './schema'

// CoreSigner: the mailroom's signing identity. The container registers its public key under
// `did` (so settlement/verifiers can check the §7.5 agreement) and the private key in the
// keystore under `kid`.
export interface CoreSigner {
  readonly did: string
  readonly kid: string
  readonly privateKey: Uint8Array
  readonly publicKey: Uint8Array
}

// Narrow config the mailroom needs. We do NOT read process.env inside the module (hexagonal
// DI) — the container passes a typed config. POSTAGE_AMOUNT/CURRENCY are optional; absent,
// the module uses the documented defaults below.
export interface MailroomConfig {
  readonly SIGNATURE_SKEW_MS: number
  readonly POSTAGE_AMOUNT?: string
  readonly POSTAGE_CURRENCY?: string
  // Fraction of forfeited postage that is burned vs paid to the recipient (§7.4). Default 0.5.
  readonly POSTAGE_BURN_FRACTION?: number
  // Reputation weight applied per spam flag (§7.4 "penalty stacks on repeated spam flags").
  readonly SPAM_SIGNAL_WEIGHT?: number
}

export interface MailroomDeps {
  readonly clock: Clock
  readonly nonces: NonceStore
  readonly identity: IdentityResolver
  readonly valueTransfer: ValueTransferPort
  readonly policy: PolicyEvaluator
  readonly reputation: ReputationPort
  readonly coreSigner: CoreSigner
  readonly config: MailroomConfig
  readonly messages: MessageRepo
  readonly threads: ThreadRepo
  readonly postage: PostageRepo
  readonly webhooks: WebhookRepo
  readonly flags: FlagRepo
}

// Micro-postage (§7.4 / §13.4). Deliberately tiny: it is negative-EV only at flood volume and
// costs a legitimate negotiator nothing net (refunded on reply/legit). Default 0.001 USDC.
export const DEFAULT_POSTAGE_AMOUNT = '0.001'
export const DEFAULT_POSTAGE_CURRENCY = 'USDC'
const DEFAULT_BURN_FRACTION = 0.5
const DEFAULT_SPAM_SIGNAL_WEIGHT = 1

// UTC calendar day key for daily postage accounting. The cap is per UTC day (§7.4).
const utcDayOf = (iso: string): string => iso.slice(0, 10)

export class MailroomService {
  private readonly envDeps: {
    identity: IdentityResolver
    nonces: NonceStore
    clock: Clock
    skewMs: number
  }
  private readonly postageAmount: string
  private readonly postageCurrency: string
  private readonly burnFraction: number
  private readonly spamWeight: number

  constructor(private readonly deps: MailroomDeps) {
    this.envDeps = {
      identity: deps.identity,
      nonces: deps.nonces,
      clock: deps.clock,
      skewMs: deps.config.SIGNATURE_SKEW_MS,
    }
    this.postageAmount = deps.config.POSTAGE_AMOUNT ?? DEFAULT_POSTAGE_AMOUNT
    this.postageCurrency = deps.config.POSTAGE_CURRENCY ?? DEFAULT_POSTAGE_CURRENCY
    this.burnFraction = deps.config.POSTAGE_BURN_FRACTION ?? DEFAULT_BURN_FRACTION
    this.spamWeight = deps.config.SPAM_SIGNAL_WEIGHT ?? DEFAULT_SPAM_SIGNAL_WEIGHT
  }

  // POST /mailroom/send (§7.1, §7.4, §7.5). Order of operations is load-bearing:
  //  1. Verify the sender's detached JWS + iat/exp freshness + single-use nonce (replay-safe).
  //  2. Resolve the sender's active delegation; policy.evaluate the messaging action.
  //  3. Enforce the per-UTC-day postage cap; escrow micro-postage via valueTransfer.hold.
  //  4. Advance the thread state machine (reject illegal transitions); store + index the message.
  //  5. On ACCEPT, emit the signed §7.5 agreement (the ONLY money beyond postage stays here).
  async send(input: SendMessageInput): Promise<SendResponse> {
    const sender = input.from
    const recipient = input.to

    // (1) Signature + freshness + nonce. signerDid is the sender; omit the default `sig`.
    await verifySignedObject(this.envDeps, input as unknown as Record<string, unknown>, {
      signerDid: sender,
    })

    if (await this.deps.identity.isRevoked(sender)) {
      throw new ForbiddenError(`sender ${sender} is revoked`)
    }

    // (2) Authorization lives in the signed DelegationCredential (§4.2). With no active
    // delegation the agent has NO authority to message — fail closed. The signer's hard-stop
    // (§4.3) is the real backstop in production; this pre-flight check is fast rejection.
    const delegation = await this.deps.identity.activeDelegation(sender)
    if (!delegation) throw new ForbiddenError(`no active delegation for ${sender}`)

    const postageAmount: Money = { amount: this.postageAmount, currency: this.postageCurrency }

    // Today's postage spend feeds both the policy usage and the explicit day-cap check below.
    const utcDay = utcDayOf(this.deps.clock.now())
    const spentTodayStr = await this.deps.postage.spentOnDay(sender, utcDay)
    const usage = {
      dailySpent: { amount: spentTodayStr, currency: this.postageCurrency },
      totalSpent: { amount: '0', currency: this.postageCurrency },
    }

    const decision = this.deps.policy.evaluate(
      delegation,
      { kind: 'message', agent: sender, counterparty: recipient, amount: postageAmount },
      usage,
    )
    if (decision.result === 'deny') {
      throw new ForbiddenError(`messaging denied by policy: ${decision.reasons.join('; ')}`)
    }
    // Fail closed on needs_approval: messaging has no parking/poll surface (unlike a payment, §4.3),
    // so a message that requires principal approval is refused here rather than silently escrowing
    // postage and delivering. The principal must widen the delegation before the agent can send.
    if (decision.result === 'needs_approval') {
      throw new ForbiddenError(`messaging requires approval: ${decision.reasons.join('; ')}`)
    }

    // (3) Daily postage cap (§7.4): max_postage_per_day from the delegation messaging policy.
    // Reject BEFORE holding so a capped sender never escrows. PaymentRequiredError (402) signals
    // "you would need to pay more postage than your policy permits today".
    const cap = delegation.policy.messaging.max_postage_per_day
    const projected = new Big(spentTodayStr).plus(this.postageAmount)
    if (projected.gt(cap)) {
      throw new PaymentRequiredError(
        `daily postage cap exceeded: ${projected.toString()} > ${cap} ${this.postageCurrency}`,
        { details: { spent_today: spentTodayStr, cap, attempted: this.postageAmount } },
      )
    }

    // Escrow the micro-postage. ref ties the hold to the message so flag/reply can resolve it.
    const holdId = await this.deps.valueTransfer.hold(sender, postageAmount, `postage:${input.msg_id}`)
    await this.deps.postage.recordHold(sender, utcDay, this.postageAmount)

    // (4) Thread resolution + state machine (§7.3). A message with no in_reply_to opens a NEW
    // thread; otherwise it advances the parent's thread. Conversation state is a pure function
    // of the message DAG, so we recompute the next state and reject illegal transitions.
    const { threadId, nextState } = await this.resolveThread(input, holdId)

    const message: Message = {
      msg_id: input.msg_id,
      thread_id: threadId,
      in_reply_to: input.in_reply_to ?? null,
      from: sender,
      to: recipient,
      type: input.type,
      body: input.body as Record<string, unknown>,
      refs: input.refs ?? undefined,
      postage: { amount: this.postageAmount, currency: this.postageCurrency, escrow_id: holdId },
      nonce: input.nonce,
      iat: input.iat,
      exp: input.exp,
      sig: input.sig,
    }
    const cursor = await this.deps.messages.append(message)

    // Persist the derived thread state + capture any negotiated QUOTE so a later ACCEPT can
    // resolve the concrete (listing_ref, quote_id) for the §7.5 handoff.
    await this.persistThreadState(message, threadId, nextState)

    // (5) §7.5 handoff: an ACCEPT that resolves an agreed QUOTE produces a signed agreement.
    // The mailroom NEVER moves money beyond postage — it emits the binding artifact and returns
    // it; the Settlement layer consumes it later (atomic call §5.3 or escrow commit §6.2).
    let agreement: Agreement | undefined
    if (input.type === 'ACCEPT') {
      agreement = await this.buildAgreement(message, threadId)
    }

    return {
      msg_id: message.msg_id,
      thread_id: threadId,
      thread_state: nextState,
      cursor,
      postage: { amount: this.postageAmount, currency: this.postageCurrency, escrow_id: holdId },
      ...(agreement ? { agreement } : {}),
    }
  }

  // GET /mailroom/inbox (§7.2 poll). The signed query proves the caller IS the recipient:
  // verifySignedObject with signerDid = recipient. Then return messages with cursor > since.
  async inbox(query: InboxQueryInput): Promise<InboxResponse> {
    await verifySignedObject(this.envDeps, query as unknown as Record<string, unknown>, {
      signerDid: query.recipient,
    })

    const rows = await this.deps.messages.inbox(query.recipient, query.since, query.limit)
    const messages = rows.map((r) => ({ cursor: r.cursor, message: r.message as unknown as Record<string, unknown> }))
    const last = rows.at(-1)
    const next_cursor = last ? last.cursor : query.since
    return { recipient: query.recipient, messages, next_cursor }
  }

  // POST /mailroom/webhook (§7.2 push). Owner-signed registration; delivery itself is out of
  // scope (at-least-once, recipient dedupes on msg_id). We store and return the registration;
  // we NEVER call the external URL here.
  async registerWebhook(input: WebhookRegisterInput): Promise<WebhookResponse> {
    await verifySignedObject(this.envDeps, input as unknown as Record<string, unknown>, {
      signerDid: input.owner,
    })
    const record = {
      webhook_id: newId('wh'),
      owner: input.owner,
      url: input.url,
      registered_at: this.deps.clock.now(),
    }
    await this.deps.webhooks.put(record)
    return record
  }

  // POST /mailroom/:msgId/flag (§7.4). The recipient (and only the recipient) settles postage:
  //  - kind='legit'  → release the hold back to the sender (false-positive / normal ack path).
  //  - kind='spam'   → forfeit the hold (split recipient/burn) AND stack a reputation penalty.
  // Idempotent per msg_id: a second flag returns the recorded outcome without moving value again.
  async flag(msgId: string, input: FlagBodyInput): Promise<FlagResponse> {
    await verifySignedObject(this.envDeps, input as unknown as Record<string, unknown>, {
      signerDid: input.flagger,
    })

    const stored = await this.deps.messages.get(msgId)
    if (!stored) throw new NotFoundError(`message not found: ${msgId}`)

    // Only the recipient may flag — they bear the attention/context cost the postage compensates.
    if (stored.message.to !== input.flagger) {
      throw new ForbiddenError('only the recipient may flag a message')
    }

    const escrowId = stored.message.postage?.escrow_id
    if (!escrowId) throw new ValidationError(`message ${msgId} carries no postage hold`)

    // Idempotency: settle exactly once.
    const prior = await this.deps.flags.outcome(msgId)
    if (prior) return { msg_id: msgId, kind: input.kind, postage_action: prior }

    if (input.kind === 'legit') {
      await this.deps.valueTransfer.release(escrowId)
      await this.deps.flags.record(msgId, 'released')
      return { msg_id: msgId, kind: 'legit', postage_action: 'released' }
    }

    // spam: forfeit the sender's hold (compensate recipient + burn the rest), then penalize.
    await this.deps.valueTransfer.forfeit(escrowId, {
      toRecipient: stored.message.to,
      burnFraction: this.burnFraction,
    })
    await this.deps.reputation.ingestSignal(stored.message.from, 'message_spam', this.spamWeight)
    await this.deps.flags.record(msgId, 'forfeited')
    return { msg_id: msgId, kind: 'spam', postage_action: 'forfeited' }
  }

  // ---- internals --------------------------------------------------------

  // Resolve the thread for an inbound message and compute its next state (§7.3). Holds the
  // postage holdId so it can be released if a transition turns out illegal (fail-safe refund).
  private async resolveThread(
    input: SendMessageInput,
    holdId: string,
  ): Promise<{ threadId: string; nextState: ThreadState }> {
    if (!input.in_reply_to) {
      // New thread: opening state derived from the opening message type over OPEN.
      const threadId = input.thread_id ?? newThreadId()
      const nextState = nextThreadState('OPEN', input.type)
      // An opener that the machine can't move out of OPEN (e.g. ACCEPT with no prior offer) is
      // illegal — you cannot accept a deal that was never offered.
      if (nextState === 'OPEN' && !this.opensThread(input.type)) {
        await this.refundHold(holdId)
        throw new ConflictError(`message type ${input.type} cannot open a new thread`)
      }
      return { threadId, nextState }
    }

    // Reply: look up the parent → its thread → advance from the thread's CURRENT state.
    const parent = await this.deps.messages.get(input.in_reply_to)
    if (!parent) {
      await this.refundHold(holdId)
      throw new NotFoundError(`in_reply_to message not found: ${input.in_reply_to}`)
    }
    const threadId = parent.message.thread_id
    const thread = await this.deps.threads.get(threadId)
    if (!thread) {
      await this.refundHold(holdId)
      throw new NotFoundError(`thread not found: ${threadId}`)
    }

    if (isTerminalThreadState(thread.state)) {
      await this.refundHold(holdId)
      throw new ConflictError(`thread ${threadId} is closed; no further messages allowed`)
    }

    const nextState = nextThreadState(thread.state, input.type)
    // nextThreadState returns the SAME state for a type that does not apply to the current
    // state (it has no effect). REJECT always advances to CLOSED, so a self-transition that is
    // not REJECT and not a legal in-place move (COUNTER on OFFERED) is an illegal transition.
    if (nextState === thread.state && !this.isLegalSelfTransition(thread.state, input.type)) {
      await this.refundHold(holdId)
      throw new ConflictError(
        `illegal thread transition: ${input.type} not allowed from state ${thread.state}`,
      )
    }

    return { threadId, nextState }
  }

  // Persist derived thread state. On the opening message we set opener/counterparty; on a QUOTE
  // we capture the negotiated quote_id + listing_ref so the §7.5 ACCEPT handoff can resolve them.
  private async persistThreadState(
    message: Message,
    threadId: string,
    nextState: ThreadState,
  ): Promise<void> {
    const existing = await this.deps.threads.get(threadId)
    const opener = existing?.opener ?? message.from
    const counterparty = existing?.counterparty ?? message.to

    let negotiated_quote_id = existing?.negotiated_quote_id ?? null
    let listing_ref = existing?.listing_ref ?? null
    if (message.type === 'QUOTE') {
      const quote = this.extractQuote(message)
      negotiated_quote_id = quote.quote_id
      listing_ref = message.refs?.listing_ref ?? quote.listing_id ?? listing_ref
    }

    await this.deps.threads.put({
      thread_id: threadId,
      state: nextState,
      opener,
      counterparty,
      negotiated_quote_id,
      listing_ref,
      updated_at: this.deps.clock.now(),
    })
  }

  // §7.5 handoff. An ACCEPT must resolve a thread that actually reached an agreed QUOTE; the
  // signed agreement references the concrete (listing_ref, quote_id) and carries the negotiated
  // terms. It is signed with the mailroom core key so the Settlement layer can verify provenance.
  private async buildAgreement(message: Message, threadId: string): Promise<Agreement> {
    const thread = await this.deps.threads.get(threadId)
    if (!thread || !thread.negotiated_quote_id) {
      throw new ConflictError('ACCEPT has no negotiated QUOTE to resolve in this thread')
    }

    // The ACCEPT body names the exact quote it binds to (§7.2 "references the exact object
    // accepted"); it must match the thread's negotiated quote, else the accept is incoherent.
    const acceptsQuoteId = (message.body as { accepts_quote_id?: unknown }).accepts_quote_id
    if (typeof acceptsQuoteId !== 'string' || acceptsQuoteId !== thread.negotiated_quote_id) {
      throw new ConflictError('ACCEPT does not reference the thread negotiated quote')
    }

    // Re-derive the agreed terms from the thread's QUOTE message (the binding artifact is a
    // signed quote, never chat prose — §7.5). Find the QUOTE that established negotiated_quote_id.
    const terms = await this.deriveAgreedTerms(message.to, message.from, thread.negotiated_quote_id)

    const agreedAt = this.deps.clock.now()
    const unsigned = {
      agreement_id: newId('agr'),
      thread_id: threadId,
      listing_ref: thread.listing_ref,
      quote_id: thread.negotiated_quote_id,
      // The QUOTE's requester is the party who asked; the ACCEPT sender is the counterparty.
      // We label by negotiation role: provider issued the QUOTE, requester accepts/pays.
      parties: { requester: thread.opener, provider: thread.counterparty },
      terms,
      agreed_at: agreedAt,
      iat: agreedAt,
      issuer: this.deps.coreSigner.did,
    }
    const sig = await signDetached(unsigned, this.deps.coreSigner.privateKey, this.deps.coreSigner.kid)
    return { ...unsigned, sig }
  }

  // Walk the recipient's stored inbox plus the accepter's, locating the QUOTE message that
  // carries negotiated_quote_id, and project its typed terms. We never read free-text body
  // fields into a decision — only the typed quote price + milestone ids (§10.3).
  private async deriveAgreedTerms(
    partyA: string,
    partyB: string,
    quoteId: string,
  ): Promise<Agreement['terms']> {
    // The QUOTE was sent to one of the two parties; scan both inboxes (bounded by thread size).
    for (const recipient of [partyA, partyB]) {
      const rows = await this.deps.messages.inbox(recipient, 0, 1000)
      for (const r of rows) {
        if (r.message.type !== 'QUOTE') continue
        const quote = this.tryExtractQuote(r.message)
        if (quote && quote.quote_id === quoteId) {
          const body = r.message.body as { milestones?: unknown }
          return {
            price: { amount: quote.price.amount, currency: quote.price.currency, per: quote.price.per },
            milestones: this.normalizeMilestones(body.milestones),
          }
        }
      }
    }
    throw new ConflictError(`negotiated quote ${quoteId} not found in thread history`)
  }

  private normalizeMilestones(raw: unknown): Agreement['terms']['milestones'] {
    if (!Array.isArray(raw)) return []
    const out: Agreement['terms']['milestones'] = []
    for (const m of raw) {
      if (
        typeof m === 'object' &&
        m !== null &&
        typeof (m as { id?: unknown }).id === 'string' &&
        typeof (m as { amount?: unknown }).amount === 'object'
      ) {
        const mm = m as { id: string; amount: { amount: string; currency: string }; description?: string }
        out.push({
          id: mm.id,
          amount: { amount: mm.amount.amount, currency: mm.amount.currency },
          ...(typeof mm.description === 'string' ? { description: mm.description } : {}),
        })
      }
    }
    return out
  }

  // A QUOTE body always carries a §5.2 Quote; this is enforced by the schema, so extraction is
  // a typed read, not a defensive parse.
  private extractQuote(message: Message): { quote_id: string; listing_id: string; price: { amount: string; currency: string; per: string } } {
    const quote = this.tryExtractQuote(message)
    if (!quote) throw new ValidationError('QUOTE message body is missing a quote object')
    return quote
  }

  private tryExtractQuote(
    message: Message,
  ): { quote_id: string; listing_id: string; price: { amount: string; currency: string; per: string } } | null {
    const q = (message.body as { quote?: unknown }).quote
    if (
      typeof q === 'object' &&
      q !== null &&
      typeof (q as { quote_id?: unknown }).quote_id === 'string' &&
      typeof (q as { listing_id?: unknown }).listing_id === 'string'
    ) {
      const quote = q as {
        quote_id: string
        listing_id: string
        price: { amount: string; currency: string; per: string }
      }
      return { quote_id: quote.quote_id, listing_id: quote.listing_id, price: quote.price }
    }
    return null
  }

  // Types that legitimately open a thread from OPEN (§7.3). Anything else as a root is illegal.
  private opensThread(type: MessageType): boolean {
    return (
      type === 'INQUIRY' ||
      type === 'QUOTE_REQUEST' ||
      type === 'QUOTE' ||
      type === 'OFFER' ||
      type === 'DELEGATE'
    )
  }

  // A self-transition (nextState === current) is legal only where the state machine intends an
  // in-place move: COUNTER on OFFERED keeps OFFERED, and STATUS on COMMITTED keeps COMMITTED.
  private isLegalSelfTransition(state: ThreadState, type: MessageType): boolean {
    if (state === 'OFFERED' && type === 'COUNTER') return true
    if (state === 'COMMITTED' && type === 'STATUS') return true
    return false
  }

  private async refundHold(holdId: string): Promise<void> {
    // Illegal transitions never net-charge a sender: release the just-placed postage hold.
    await this.deps.valueTransfer.release(holdId)
  }
}
