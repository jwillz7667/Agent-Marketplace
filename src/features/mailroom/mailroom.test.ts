import { describe, it, expect, beforeEach } from 'vitest'
import { generateKeyPair, verifyDetached, type KeyPair } from '../../shared/crypto/index'
import { stripForSigning } from '../../domain/index'
import { FixedClock } from '../../shared/time/clock'
import {
  ConflictError,
  ForbiddenError,
  PaymentRequiredError,
  ReplayError,
} from '../../shared/errors'
import { MailroomService, type CoreSigner } from './service'
import {
  MemoryFlagRepo,
  MemoryMessageRepo,
  MemoryPostageRepo,
  MemoryThreadRepo,
  MemoryWebhookRepo,
} from './memory'
import {
  FakeIdentity,
  FakeNonces,
  FakePolicy,
  FakeReputation,
  FakeValueTransfer,
  TEST_CONFIG,
  makeCoreSigner,
  makeDelegation,
  signAccept,
  signCounter,
  signFlag,
  signInboxQuery,
  signQuote,
  signQuoteRequest,
  signWebhook,
} from './test-helpers'

// Test principals + agents.
const PRINCIPAL = 'did:praxis:org:acme'
const REQUESTER = 'did:praxis:agent:requester'
const PROVIDER = 'did:praxis:agent:provider'

interface Harness {
  svc: MailroomService
  clock: FixedClock
  identity: FakeIdentity
  reputation: FakeReputation
  policy: FakePolicy
  valueTransfer: FakeValueTransfer
  messages: MemoryMessageRepo
  threads: MemoryThreadRepo
  postage: MemoryPostageRepo
  flags: MemoryFlagRepo
  coreSigner: CoreSigner
  requesterKeys: KeyPair
  providerKeys: KeyPair
}

const buildHarness = async (
  opts: { maxPostagePerDay?: string } = {},
): Promise<Harness> => {
  const clock = new FixedClock('2026-06-06T15:00:00.000Z')
  const identity = new FakeIdentity()
  const reputation = new FakeReputation()
  const valueTransfer = new FakeValueTransfer()
  const messages = new MemoryMessageRepo()
  const threads = new MemoryThreadRepo()
  const postage = new MemoryPostageRepo()
  const webhooks = new MemoryWebhookRepo()
  const flags = new MemoryFlagRepo()
  const policy = new FakePolicy()
  const coreSigner = await makeCoreSigner()

  const requesterKeys = await generateKeyPair()
  const providerKeys = await generateKeyPair()
  identity.register(REQUESTER, requesterKeys.publicKey)
  identity.register(PROVIDER, providerKeys.publicKey)
  identity.register(coreSigner.did, coreSigner.publicKey)
  identity.setDelegation(
    REQUESTER,
    makeDelegation(PRINCIPAL, REQUESTER, { maxPostagePerDay: opts.maxPostagePerDay ?? '1.000' }),
  )
  identity.setDelegation(
    PROVIDER,
    makeDelegation(PRINCIPAL, PROVIDER, { maxPostagePerDay: opts.maxPostagePerDay ?? '1.000' }),
  )

  const svc = new MailroomService({
    clock,
    nonces: new FakeNonces(),
    identity,
    valueTransfer,
    policy,
    reputation,
    coreSigner,
    config: TEST_CONFIG,
    messages,
    threads,
    postage,
    webhooks,
    flags,
  })

  return {
    svc,
    clock,
    identity,
    reputation,
    policy,
    valueTransfer,
    messages,
    threads,
    postage,
    flags,
    coreSigner,
    requesterKeys,
    providerKeys,
  }
}

describe('MailroomService.send — postage + storage', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  it('escrows micro-postage and stores the message indexed by recipient + cursor', async () => {
    const msg = await signQuoteRequest(REQUESTER, h.requesterKeys, PROVIDER)

    const res = await h.svc.send(msg)

    expect(res.msg_id).toBe(msg.msg_id)
    expect(res.thread_state).toBe('QUOTING')
    expect(res.postage.amount).toBe('0.001')
    expect(res.postage.currency).toBe('USDC')

    // A hold was placed against the sender for exactly the postage amount, ref-tied to the msg.
    const holds = [...h.valueTransfer.holds.values()]
    expect(holds).toHaveLength(1)
    expect(holds[0]?.did).toBe(REQUESTER)
    expect(holds[0]?.amount).toEqual({ amount: '0.001', currency: 'USDC' })
    expect(holds[0]?.ref).toBe(`postage:${msg.msg_id}`)
    expect(holds[0]?.state).toBe('held')

    // Stored + retrievable in the recipient's inbox at the returned cursor.
    const stored = await h.messages.get(msg.msg_id)
    expect(stored?.cursor).toBe(res.cursor)
    expect(stored?.message.to).toBe(PROVIDER)
    expect(stored?.message.postage?.escrow_id).toBe(holds[0]?.holdId)
  })

  it('rejects a replayed nonce (replay protection)', async () => {
    const msg = await signQuoteRequest(REQUESTER, h.requesterKeys, PROVIDER, { nonce: 'fixed-nonce' })

    await h.svc.send(msg)

    // A second send reusing the SAME nonce (different msg_id) must be rejected.
    const replay = await signQuoteRequest(REQUESTER, h.requesterKeys, PROVIDER, {
      nonce: 'fixed-nonce',
      msgId: 'msg_REPLAY',
    })
    await expect(h.svc.send(replay)).rejects.toBeInstanceOf(ReplayError)
  })

  it('denies sending with no active delegation', async () => {
    const stranger = 'did:praxis:agent:stranger'
    const strangerKeys = await generateKeyPair()
    h.identity.register(stranger, strangerKeys.publicKey)
    // No delegation set for stranger.
    const msg = await signQuoteRequest(stranger, strangerKeys, PROVIDER)
    await expect(h.svc.send(msg)).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('fails closed on needs_approval — no postage escrowed, no message stored (C1)', async () => {
    // Messaging has no parking/poll surface, so a needs_approval decision must be refused outright
    // rather than silently holding postage and delivering. Regression: the old code only threw on
    // `deny`, letting needs_approval fall through to escrow + store.
    h.policy.needsApproval(REQUESTER)
    const msg = await signQuoteRequest(REQUESTER, h.requesterKeys, PROVIDER)

    await expect(h.svc.send(msg)).rejects.toBeInstanceOf(ForbiddenError)

    // The hard stop is BEFORE the postage hold and the store write.
    expect([...h.valueTransfer.holds.values()]).toHaveLength(0)
    expect(await h.messages.get(msg.msg_id)).toBeNull()
  })
})

describe('MailroomService.send — daily postage cap (§7.4)', () => {
  it('rejects when the day postage would exceed max_postage_per_day', async () => {
    // Cap of 0.0015 with 0.001 postage allows exactly ONE send; the second exceeds the cap.
    const h = await buildHarness({ maxPostagePerDay: '0.0015' })

    const first = await signQuoteRequest(REQUESTER, h.requesterKeys, PROVIDER)
    await h.svc.send(first)

    const second = await signQuoteRequest(REQUESTER, h.requesterKeys, PROVIDER)
    await expect(h.svc.send(second)).rejects.toBeInstanceOf(PaymentRequiredError)

    // Only the first send placed a hold; the capped send escrowed nothing.
    expect([...h.valueTransfer.holds.values()]).toHaveLength(1)
  })
})

describe('MailroomService.send — thread state machine (§7.3)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  it('advances OPEN→QUOTING→OFFERED→AGREED across a legal negotiation', async () => {
    // R opens with QUOTE_REQUEST → QUOTING.
    const qr = await signQuoteRequest(REQUESTER, h.requesterKeys, PROVIDER)
    const r1 = await h.svc.send(qr)
    expect(r1.thread_state).toBe('QUOTING')

    // P replies with a QUOTE → OFFERED.
    const quote = await signQuote(PROVIDER, h.providerKeys, REQUESTER, { inReplyTo: qr.msg_id })
    const r2 = await h.svc.send(quote)
    expect(r2.thread_state).toBe('OFFERED')
    expect(r2.thread_id).toBe(r1.thread_id)

    // R counters → stays OFFERED (legal self-transition).
    const counter = await signCounter(REQUESTER, h.requesterKeys, PROVIDER, { inReplyTo: quote.msg_id })
    const r3 = await h.svc.send(counter)
    expect(r3.thread_state).toBe('OFFERED')

    // R accepts → AGREED.
    const accept = await signAccept(REQUESTER, h.requesterKeys, PROVIDER, {
      inReplyTo: quote.msg_id,
      acceptsQuoteId: 'qt_TEST_1',
    })
    const r4 = await h.svc.send(accept)
    expect(r4.thread_state).toBe('AGREED')
  })

  it('rejects an illegal transition (ACCEPT while still QUOTING) and refunds the hold', async () => {
    const qr = await signQuoteRequest(REQUESTER, h.requesterKeys, PROVIDER)
    await h.svc.send(qr)

    // ACCEPT from QUOTING is illegal (no QUOTE has landed yet). nextThreadState keeps QUOTING.
    const accept = await signAccept(PROVIDER, h.providerKeys, REQUESTER, { inReplyTo: qr.msg_id })
    await expect(h.svc.send(accept)).rejects.toBeInstanceOf(ConflictError)

    // The rejected send's postage hold was released (no net charge for an illegal transition).
    const holds = [...h.valueTransfer.holds.values()]
    // First send held; the illegal accept's hold was placed then released.
    const released = holds.filter((x) => x.state === 'released')
    expect(released).toHaveLength(1)
  })

  it('rejects ACCEPT as a thread root (cannot accept a never-offered deal)', async () => {
    const accept = await signAccept(REQUESTER, h.requesterKeys, PROVIDER, { acceptsQuoteId: 'qt_X' })
    await expect(h.svc.send(accept)).rejects.toBeInstanceOf(ConflictError)
  })

  it('rejects any message into a CLOSED thread', async () => {
    const inquiry = await signQuoteRequest(REQUESTER, h.requesterKeys, PROVIDER)
    await h.svc.send(inquiry)

    // REJECT closes the thread.
    const reject = {
      msg_id: 'msg_REJECT',
      in_reply_to: inquiry.msg_id,
      from: PROVIDER,
      to: REQUESTER,
      type: 'REJECT' as const,
      body: { reason: 'out_of_capacity' as const },
      nonce: 'nonce-reject',
      iat: '2026-06-06T15:00:00Z',
      exp: '2026-06-13T15:00:00Z',
    }
    const { signDetached } = await import('../../shared/crypto/index')
    const sig = await signDetached(reject, h.providerKeys.privateKey, `${PROVIDER}#sign-1`)
    const r = await h.svc.send({ ...reject, sig })
    expect(r.thread_state).toBe('CLOSED')

    // A further reply must be rejected.
    const after = await signCounter(REQUESTER, h.requesterKeys, PROVIDER, { inReplyTo: inquiry.msg_id })
    await expect(h.svc.send(after)).rejects.toBeInstanceOf(ConflictError)
  })
})

describe('MailroomService.send — §7.5 ACCEPT handoff', () => {
  it('emits a signed agreement referencing (listing_ref, quote_id) and moves NO money beyond postage', async () => {
    const h = await buildHarness()

    const qr = await signQuoteRequest(REQUESTER, h.requesterKeys, PROVIDER)
    await h.svc.send(qr)

    const quote = await signQuote(PROVIDER, h.providerKeys, REQUESTER, {
      inReplyTo: qr.msg_id,
      quoteId: 'qt_NEGOTIATED',
      listingId: 'lst_ENRICH',
      price: { amount: '240', currency: 'USDC', per: 'job' },
      milestones: [
        { id: 'm1', amount: { amount: '120', currency: 'USDC' } },
        { id: 'm2', amount: { amount: '120', currency: 'USDC' } },
      ],
    })
    await h.svc.send(quote)

    const holdsBefore = [...h.valueTransfer.holds.values()].length

    const accept = await signAccept(REQUESTER, h.requesterKeys, PROVIDER, {
      inReplyTo: quote.msg_id,
      acceptsQuoteId: 'qt_NEGOTIATED',
    })
    const res = await h.svc.send(accept)

    expect(res.thread_state).toBe('AGREED')
    const agreement = res.agreement
    expect(agreement).toBeDefined()
    if (!agreement) throw new Error('no agreement')

    // References the concrete (listing_ref, quote_id) the thread resolved to.
    expect(agreement.quote_id).toBe('qt_NEGOTIATED')
    expect(agreement.listing_ref).toBe('lst_ENRICH')
    expect(agreement.parties).toEqual({ requester: REQUESTER, provider: PROVIDER })
    expect(agreement.terms.price).toEqual({ amount: '240', currency: 'USDC', per: 'job' })
    expect(agreement.terms.milestones.map((m) => m.id)).toEqual(['m1', 'm2'])

    // The agreement is signed by the mailroom core key and verifies (settlement consumes it).
    const payload = stripForSigning(agreement as unknown as Record<string, unknown>, ['sig'])
    const valid = await verifyDetached(payload, agreement.sig, h.coreSigner.publicKey)
    expect(valid).toBe(true)

    // NO money moved beyond postage: the only value-transfer ops are postage holds (one per
    // send), all still 'held'. No capture/credit/debit/forfeit/release was invoked.
    const holds = [...h.valueTransfer.holds.values()]
    expect(holds.length).toBe(holdsBefore + 1) // accept added exactly one postage hold
    expect(holds.every((x) => x.state === 'held')).toBe(true)
  })

  it('rejects ACCEPT when the thread never reached an agreed QUOTE', async () => {
    const h = await buildHarness()
    // Open + go to OFFERED via a bare OFFER (no QUOTE → no negotiated_quote_id captured).
    const qr = await signQuoteRequest(REQUESTER, h.requesterKeys, PROVIDER)
    await h.svc.send(qr)

    // OFFER (not QUOTE) advances to OFFERED but captures no negotiated quote id.
    const { signDetached } = await import('../../shared/crypto/index')
    const offer = {
      msg_id: 'msg_OFFER',
      in_reply_to: qr.msg_id,
      from: PROVIDER,
      to: REQUESTER,
      type: 'OFFER' as const,
      body: { price: { amount: '200', currency: 'USDC' } },
      nonce: 'nonce-offer',
      iat: '2026-06-06T15:00:00Z',
      exp: '2026-06-13T15:00:00Z',
    }
    const offerSig = await signDetached(offer, h.providerKeys.privateKey, `${PROVIDER}#sign-1`)
    await h.svc.send({ ...offer, sig: offerSig })

    const accept = await signAccept(REQUESTER, h.requesterKeys, PROVIDER, { inReplyTo: 'msg_OFFER' })
    await expect(h.svc.send(accept)).rejects.toBeInstanceOf(ConflictError)
  })
})

describe('MailroomService.flag — postage settlement (§7.4)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  const sendOne = async (): Promise<{ msgId: string; holdId: string }> => {
    const msg = await signQuoteRequest(REQUESTER, h.requesterKeys, PROVIDER)
    const res = await h.svc.send(msg)
    return { msgId: res.msg_id, holdId: res.postage.escrow_id }
  }

  it('flag spam forfeits the postage hold and ingests a reputation signal', async () => {
    const { msgId, holdId } = await sendOne()

    const flag = await signFlag(PROVIDER, h.providerKeys, 'spam')
    const res = await h.svc.flag(msgId, flag)

    expect(res.postage_action).toBe('forfeited')
    expect(h.valueTransfer.holds.get(holdId)?.state).toBe('forfeited')
    // The §7.4 reputation penalty stacked against the SENDER, not the flagger.
    expect(h.reputation.signals).toEqual([{ did: REQUESTER, kind: 'message_spam', weight: 1 }])
  })

  it('flag legit releases the postage hold back to the sender', async () => {
    const { msgId, holdId } = await sendOne()

    const flag = await signFlag(PROVIDER, h.providerKeys, 'legit')
    const res = await h.svc.flag(msgId, flag)

    expect(res.postage_action).toBe('released')
    expect(h.valueTransfer.holds.get(holdId)?.state).toBe('released')
    expect(h.reputation.signals).toHaveLength(0)
  })

  it('is idempotent: a second flag returns the recorded outcome without moving value again', async () => {
    const { msgId, holdId } = await sendOne()

    await h.svc.flag(msgId, await signFlag(PROVIDER, h.providerKeys, 'spam'))
    // A second flag (even with a different kind) is a no-op replay of the terminal outcome.
    const res2 = await h.svc.flag(msgId, await signFlag(PROVIDER, h.providerKeys, 'legit'))

    expect(res2.postage_action).toBe('forfeited')
    expect(h.valueTransfer.holds.get(holdId)?.state).toBe('forfeited')
    // Only ONE reputation signal despite two flags.
    expect(h.reputation.signals).toHaveLength(1)
  })

  it('only the recipient may flag a message', async () => {
    const { msgId } = await sendOne()
    // The SENDER tries to flag their own message — forbidden.
    const flag = await signFlag(REQUESTER, h.requesterKeys, 'legit')
    await expect(h.svc.flag(msgId, flag)).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe('MailroomService.inbox + webhook', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  it('returns recipient messages with cursor > since and a next cursor (signed query)', async () => {
    const m1 = await signQuoteRequest(REQUESTER, h.requesterKeys, PROVIDER)
    const r1 = await h.svc.send(m1)
    const m2 = await signQuoteRequest(REQUESTER, h.requesterKeys, PROVIDER)
    const r2 = await h.svc.send(m2)

    const query = await signInboxQuery(PROVIDER, h.providerKeys, { since: 0 })
    const inbox = await h.svc.inbox(query)

    expect(inbox.recipient).toBe(PROVIDER)
    expect(inbox.messages.map((m) => m.cursor)).toEqual([r1.cursor, r2.cursor])
    expect(inbox.next_cursor).toBe(r2.cursor)

    // Paginate from the first cursor → only the second message remains.
    const query2 = await signInboxQuery(PROVIDER, h.providerKeys, { since: r1.cursor })
    const inbox2 = await h.svc.inbox(query2)
    expect(inbox2.messages.map((m) => m.cursor)).toEqual([r2.cursor])
  })

  it('rejects an inbox query signed by someone other than the recipient', async () => {
    // Requester signs a query claiming to be PROVIDER's inbox → signature won't verify.
    const forged = await signInboxQuery(PROVIDER, h.requesterKeys, {})
    await expect(h.svc.inbox(forged)).rejects.toBeTruthy()
  })

  it('registers an owner-signed webhook without calling the URL', async () => {
    const wh = await signWebhook(PROVIDER, h.providerKeys, 'https://provider.example/hook')
    const res = await h.svc.registerWebhook(wh)
    expect(res.owner).toBe(PROVIDER)
    expect(res.url).toBe('https://provider.example/hook')
    expect(res.webhook_id).toMatch(/^wh_/)
  })
})
