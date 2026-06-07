import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sha256Tagged, canonicalize } from '../../src/shared/crypto/index'
import {
  availableBalance,
  buildHarness,
  futureIso,
  generousPolicy,
  heldBalance,
  nowIso,
  publishListing,
  registerAndProvision,
  registerPrincipal,
  signDetachedField,
  signEnvelope,
  type Harness,
  type TestAgent,
} from './harness'

// §14.4 — END-TO-END escrow-negotiated job flow over HTTP. Mailroom negotiation (INQUIRY → QUOTE
// → ACCEPT → signed agreement, NO money beyond postage) → escrow open (funds HELD) → deliver +
// objective acceptance → capture, with both-direction §9.5 dispute slashing, then a final ledger
// hash-chain + governance audit integrity check.

interface MatchQuote {
  quote_id: string
  listing_id: string
  listing_version: string
  price: { amount: string; currency: string; per: string }
  rail: string
  requester: string
  issued: string
  expires: string
  sig: string
}

// Obtain a registry-signed bound quote for a listing (used to seed the mailroom QUOTE body).
const getQuote = async (h: Harness, requester: TestAgent, listingId: string): Promise<MatchQuote> => {
  const query = await signEnvelope(
    {
      query_id: `q_${randomBytes(6).toString('hex')}`,
      requester: requester.did,
      capability: { taxonomy: 'doc.extract.tables' },
      constraints: { price_ceiling: { amount: '100000', currency: 'USDC', per: 'call' } },
      max_results: 25,
    },
    requester.keys,
    requester.kid,
  )
  const res = await h.app.inject({ method: 'POST', url: '/registry/query', payload: query })
  expect(res.statusCode, res.body).toBe(200)
  const matches = (res.json() as { matches: { listing_id: string; quote: MatchQuote }[] }).matches
  const match = matches.find((m) => m.listing_id === listingId)
  if (!match) throw new Error(`no quote for listing ${listingId}`)
  return match.quote
}

// Send a signed mailroom message and return the parsed response.
const sendMessage = async (
  h: Harness,
  sender: TestAgent,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; json: Record<string, unknown> }> => {
  const signed = await signEnvelope(body, sender.keys, sender.kid)
  const res = await h.app.inject({ method: 'POST', url: '/mailroom/send', payload: signed })
  return { statusCode: res.statusCode, json: res.json() as Record<string, unknown> }
}

// Open an escrow over HTTP: both parties sign the contract base (minus both sigs + envelope
// fields, matching CONTRACT_OMIT), then the payer's envelope (nonce/iat/exp + sig_payer) is
// verified. Returns the inject response.
const openEscrow = async (
  h: Harness,
  opts: {
    payer: TestAgent
    payee: TestAgent
    jobRef: string
    total: string
    milestones: {
      id: string
      amount: string
      acceptance: { type: 'schema' | 'checksum' | 'schema+checksum' | 'oracle'; schema_ref?: string; expected?: string }
    }[]
    stakeAmount: string
    disputeWindowMs?: number
  },
) => {
  const escrowId = `esc_${randomBytes(8).toString('hex')}`
  const base = {
    escrow_id: escrowId,
    job_ref: opts.jobRef,
    payer: opts.payer.did,
    payee: opts.payee.did,
    amount: { amount: opts.total, currency: 'USDC' },
    milestones: opts.milestones,
    deliver_by: futureIso(24 * 60 * 60 * 1000),
    on_timeout: 'refund' as const,
    dispute_window_ms: opts.disputeWindowMs ?? 86400000,
    provider_stake: { amount: opts.stakeAmount, currency: 'USDC', slashable: true },
  }
  const sigPayer = await signDetachedField(base, opts.payer.keys, opts.payer.kid)
  const sigPayee = await signDetachedField(base, opts.payee.keys, opts.payee.kid)
  const payload = {
    ...base,
    sig_payer: sigPayer,
    sig_payee: sigPayee,
    nonce: `esc-${randomBytes(8).toString('hex')}`,
    iat: nowIso(),
    exp: futureIso(),
  }
  const res = await h.app.inject({ method: 'POST', url: '/escrow', payload })
  return { escrowId, res }
}

// Sign + send a deliver/accept/dispute body (single `sig` envelope).
const escrowAction = async (
  h: Harness,
  path: string,
  signer: TestAgent,
  body: Record<string, unknown>,
) => {
  const signed = await signEnvelope(body, signer.keys, signer.kid)
  return h.app.inject({ method: 'POST', url: path, payload: signed })
}

describe('§14.4 escrow-negotiated job flow (end-to-end over HTTP)', () => {
  let h: Harness
  let principal: TestAgent
  let provider: TestAgent
  let requester: TestAgent

  beforeAll(async () => {
    h = await buildHarness()
    principal = await registerPrincipal(h)
    // Provider needs stake funds + escrow.may_commit + may_stake (it stakes against its delivery)
    // and messaging to negotiate. Requester is the payer: escrow.may_commit + messaging + funds.
    provider = await registerAndProvision(h, principal, {
      policy: generousPolicy(),
      fund: { amount: '1000', currency: 'USDC' },
    })
    requester = await registerAndProvision(h, principal, {
      policy: generousPolicy(),
      fund: { amount: '1000', currency: 'USDC' },
    })
  })

  afterAll(async () => {
    await h.close()
  })

  it('negotiates via the Mailroom and emits a signed agreement without moving money beyond postage', async () => {
    // (2) INQUIRY (requester opens) → QUOTE (provider, carries a registry-signed Quote) → ACCEPT
    // (requester). The ACCEPT emits a signed §7.5 agreement bound to (listing_ref, quote_id).
    const listingId = await publishListing(h, {
      provider,
      rail: 'dev',
      priceAmount: '10.00',
      acceptanceType: 'schema+checksum',
    })
    const quote = await getQuote(h, requester, listingId)

    const requesterAvailBefore = await availableBalance(h, requester.did)
    const providerAvailBefore = await availableBalance(h, provider.did)

    // INQUIRY opens the thread (OPEN → QUOTING).
    const inquiryId = `msg_${randomBytes(6).toString('hex')}`
    const inquiry = await sendMessage(h, requester, {
      msg_id: inquiryId,
      from: requester.did,
      to: provider.did,
      type: 'INQUIRY',
      body: { capability: 'doc.extract.tables', question: 'can you extract 100 PDFs?' },
    })
    expect(inquiry.statusCode, JSON.stringify(inquiry.json)).toBe(200)
    const threadId = inquiry.json.thread_id as string
    expect(inquiry.json.thread_state).toBe('QUOTING')

    // QUOTE in reply (QUOTING → OFFERED); body carries the signed Quote + milestones.
    const quoteMsgId = `msg_${randomBytes(6).toString('hex')}`
    const quoteMsg = await sendMessage(h, provider, {
      msg_id: quoteMsgId,
      thread_id: threadId,
      in_reply_to: inquiryId,
      from: provider.did,
      to: requester.did,
      type: 'QUOTE',
      refs: { listing_ref: listingId, quote_id: quote.quote_id },
      body: {
        quote,
        milestones: [{ id: 'm1', amount: { amount: '10.00', currency: 'USDC' }, description: 'all rows' }],
      },
    })
    expect(quoteMsg.statusCode, JSON.stringify(quoteMsg.json)).toBe(200)
    expect(quoteMsg.json.thread_state).toBe('OFFERED')

    // ACCEPT in reply to the QUOTE (OFFERED → AGREED) → emits the agreement.
    const acceptMsgId = `msg_${randomBytes(6).toString('hex')}`
    const accept = await sendMessage(h, requester, {
      msg_id: acceptMsgId,
      thread_id: threadId,
      in_reply_to: quoteMsgId,
      from: requester.did,
      to: provider.did,
      type: 'ACCEPT',
      body: { accepts_quote_id: quote.quote_id },
    })
    expect(accept.statusCode, JSON.stringify(accept.json)).toBe(200)
    expect(accept.json.thread_state).toBe('AGREED')

    const agreement = accept.json.agreement as
      | { listing_ref: string | null; quote_id: string; parties: { requester: string; provider: string }; issuer: string }
      | undefined
    expect(agreement).toBeDefined()
    if (!agreement) throw new Error('no agreement')
    expect(agreement.quote_id).toBe(quote.quote_id)
    expect(agreement.listing_ref).toBe(listingId)
    expect(agreement.parties.requester).toBe(requester.did)
    expect(agreement.parties.provider).toBe(provider.did)
    // Signed by the mailroom core key — the binding artifact the Settlement layer will consume.
    expect(agreement.issuer).toBe(h.container.coreSigners.mailroom.did)

    // NO money moved beyond postage: each side sent one message at 0.001 USDC postage (held, not
    // spent). The requester sent 2 messages, the provider 1; postage is HELD (refundable), so
    // available drops by exactly the postage holds and nothing else.
    const requesterAvailAfter = await availableBalance(h, requester.did)
    const providerAvailAfter = await availableBalance(h, provider.did)
    expect(Number(requesterAvailBefore) - Number(requesterAvailAfter)).toBeCloseTo(0.002, 6) // 2 msgs
    expect(Number(providerAvailBefore) - Number(providerAvailAfter)).toBeCloseTo(0.001, 6) // 1 msg
    // The postage is HELD, not gone from the system.
    expect(Number(await heldBalance(h, requester.did))).toBeCloseTo(0.002, 6)
  })

  it('opens escrow (funds HELD), auto-accepts an objective checksum delivery, and completes', async () => {
    // (3)+(4)+(5): a pure-objective ('checksum') milestone with a matching delivered hash
    // auto-captures on delivery (no human), the escrow completes, and a ledger receipt is written.
    const result = { rows: [{ page: 1, table: 1, cells: [['ok']] }] }
    const expectedHash = sha256Tagged(canonicalize(result))

    const requesterAvailBefore = await availableBalance(h, requester.did)
    const providerAvailBefore = await availableBalance(h, provider.did)
    const requesterHeldBefore = await heldBalance(h, requester.did) // may carry prior-test postage
    const providerHeldBefore = await heldBalance(h, provider.did)

    const { escrowId, res } = await openEscrow(h, {
      payer: requester,
      payee: provider,
      jobRef: 'job_happy',
      total: '20.00',
      milestones: [{ id: 'm1', amount: '20.00', acceptance: { type: 'checksum', expected: expectedHash } }],
      stakeAmount: '5.00',
    })
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json() as { state: string }).state).toBe('open')

    // Funds HELD: payer's 20 moved available→held; provider's 5 stake moved available→held. Assert
    // the DELTA (held may already carry refundable postage from the negotiation test above).
    expect(Number(requesterAvailBefore) - Number(await availableBalance(h, requester.did))).toBeCloseTo(20, 6)
    expect(Number(await heldBalance(h, requester.did)) - Number(requesterHeldBefore)).toBeCloseTo(20, 6)
    expect(Number(providerAvailBefore) - Number(await availableBalance(h, provider.did))).toBeCloseTo(5, 6)
    expect(Number(await heldBalance(h, provider.did)) - Number(providerHeldBefore)).toBeCloseTo(5, 6)

    // (4) Provider delivers the matching hash → objective pass → AUTO-CAPTURE (no accept needed).
    const deliver = await escrowAction(h, `/escrow/${escrowId}/deliver`, provider, {
      milestone_id: 'm1',
      result_hash: expectedHash,
      provider: provider.did,
    })
    expect(deliver.statusCode, deliver.body).toBe(200)
    const delivered = deliver.json() as { state: string; milestones: { id: string; state: string }[] }
    expect(delivered.milestones[0]?.state).toBe('released')
    expect(delivered.state).toBe('released')

    // (5) Provider captured the milestone AND got its stake back (clean completion releases stake).
    // Net provider available change = +20 (captured) (stake returned to available).
    const providerAvailFinal = await availableBalance(h, provider.did)
    expect(Number(providerAvailFinal) - Number(providerAvailBefore)).toBeCloseTo(20, 6)
    // Stake returned: provider held is back to its pre-escrow baseline (any prior postage aside).
    expect(Number(await heldBalance(h, provider.did)) - Number(providerHeldBefore)).toBeCloseTo(0, 6)
    // Payer's held funds for this milestone are gone (captured), not returned.
    expect(Number(await availableBalance(h, requester.did))).toBeCloseTo(Number(requesterAvailBefore) - 20, 6)

    // A receipt for this escrow job is on the ledger.
    const entries = await h.container.ledger.ledger.list({ kind: 'receipt', subject: provider.did })
    const jobReceipt = entries.find((e) => (e.payload as { job_ref?: string }).job_ref === 'job_happy')
    expect(jobReceipt).toBeDefined()
  })

  it('resolves a provider-misdelivery dispute FOR the requester (refund + slash provider stake)', async () => {
    // (6) schema+checksum milestone (does NOT auto-settle on delivery). Provider delivers a hash
    // that does NOT match expected → on dispute the objective check FAILS → refund the payer and
    // slash the provider's stake to the payer.
    const expectedHash = `sha256:${randomBytes(16).toString('hex')}`
    const wrongHash = `sha256:${randomBytes(16).toString('hex')}`

    const requesterAvailBefore = await availableBalance(h, requester.did)
    const providerAvailBefore = await availableBalance(h, provider.did)

    const { escrowId, res } = await openEscrow(h, {
      payer: requester,
      payee: provider,
      jobRef: 'job_misdeliver',
      total: '15.00',
      milestones: [{ id: 'm1', amount: '15.00', acceptance: { type: 'schema+checksum', expected: expectedHash } }],
      stakeAmount: '8.00',
    })
    expect(res.statusCode, res.body).toBe(200)

    // Provider delivers a non-matching hash → 'delivered' (awaits accept/dispute), NOT auto-settled.
    const deliver = await escrowAction(h, `/escrow/${escrowId}/deliver`, provider, {
      milestone_id: 'm1',
      result_hash: wrongHash,
      provider: provider.did,
    })
    expect(deliver.statusCode, deliver.body).toBe(200)
    expect((deliver.json() as { milestones: { state: string }[] }).milestones[0]?.state).toBe('delivered')

    // Requester disputes → objective FAIL → resolve FOR requester: refund + slash provider stake.
    const dispute = await escrowAction(h, `/escrow/${escrowId}/dispute`, requester, {
      milestone_id: 'm1',
      disputer: requester.did,
      reason_code: 'checksum_mismatch',
    })
    expect(dispute.statusCode, dispute.body).toBe(200)
    const resolved = dispute.json() as { state: string; milestones: { state: string }[] }
    expect(resolved.milestones[0]?.state).toBe('refunded')

    // Requester made whole: the 15 hold is released back (net available change ≈ 0). Provider's 8
    // stake is slashed to the payer, so the requester GAINS the stake and the provider LOSES it.
    const requesterAvailFinal = await availableBalance(h, requester.did)
    const providerAvailFinal = await availableBalance(h, provider.did)
    // Requester: milestone refunded (no net loss) + received the slashed 8 stake.
    expect(Number(requesterAvailFinal) - Number(requesterAvailBefore)).toBeCloseTo(8, 6)
    // Provider: staked 8 (moved to held at open) and it was forfeited to payer — net -8 available.
    expect(Number(providerAvailFinal) - Number(providerAvailBefore)).toBeCloseTo(-8, 6)

    // A disputed/refunded receipt was written for this job.
    const entries = await h.container.ledger.ledger.list({ kind: 'receipt', subject: provider.did })
    const jobReceipt = entries.find((e) => (e.payload as { job_ref?: string }).job_ref === 'job_misdeliver')
    expect(jobReceipt).toBeDefined()
    if (!jobReceipt) throw new Error('missing misdelivery receipt')
    expect((jobReceipt.payload as { outcome: string }).outcome).toBe('disputed')
  })

  it('resolves a requester-griefing dispute FOR the provider (capture + slash disputer bond + reputation penalty)', async () => {
    // (7) schema+checksum milestone. Provider delivers a MATCHING hash (objectively good). The
    // requester disputes anyway (griefing) and posts a bond → objective PASS → resolve FOR the
    // provider: capture the milestone, forfeit the disputer's bond to the provider, and stack a
    // frivolous-dispute reputation penalty on the disputer.
    const goodHash = `sha256:${randomBytes(16).toString('hex')}`

    const requesterAvailBefore = await availableBalance(h, requester.did)
    const providerAvailBefore = await availableBalance(h, provider.did)

    const { escrowId, res } = await openEscrow(h, {
      payer: requester,
      payee: provider,
      jobRef: 'job_grief',
      total: '12.00',
      milestones: [{ id: 'm1', amount: '12.00', acceptance: { type: 'schema+checksum', expected: goodHash } }],
      stakeAmount: '4.00',
    })
    expect(res.statusCode, res.body).toBe(200)

    // Provider delivers the MATCHING hash → 'delivered' (schema+checksum does not auto-settle).
    const deliver = await escrowAction(h, `/escrow/${escrowId}/deliver`, provider, {
      milestone_id: 'm1',
      result_hash: goodHash,
      provider: provider.did,
    })
    expect(deliver.statusCode, deliver.body).toBe(200)
    expect((deliver.json() as { milestones: { state: string }[] }).milestones[0]?.state).toBe('delivered')

    // Requester disputes a good delivery WITH a bond → objective PASS → griefing.
    const bond = '3.00'
    const dispute = await escrowAction(h, `/escrow/${escrowId}/dispute`, requester, {
      milestone_id: 'm1',
      disputer: requester.did,
      reason_code: 'bogus_complaint',
      bond: { amount: bond, currency: 'USDC' },
    })
    expect(dispute.statusCode, dispute.body).toBe(200)
    const resolved = dispute.json() as { milestones: { state: string }[] }
    expect(resolved.milestones[0]?.state).toBe('released') // captured to provider

    const requesterAvailFinal = await availableBalance(h, requester.did)
    const providerAvailFinal = await availableBalance(h, provider.did)
    // Requester (griefer): paid the 12 milestone (captured) AND forfeited the 3 bond → net -15.
    expect(Number(requesterAvailFinal) - Number(requesterAvailBefore)).toBeCloseTo(-15, 6)
    // Provider: captured 12 + received the 3 forfeited bond + got its 4 stake back → net +15.
    expect(Number(providerAvailFinal) - Number(providerAvailBefore)).toBeCloseTo(15, 6)

    // Reputation penalty stacked on the griefer (frivolous_dispute → post_flags channel, §9.5).
    const repRes = await h.app.inject({ method: 'GET', url: `/reputation/${requester.did}/raw` })
    expect(repRes.statusCode, repRes.body).toBe(200)
    expect((repRes.json() as { post_flags: number }).post_flags).toBeGreaterThanOrEqual(1)
  })

  it('keeps the ledger hash-chain intact and exposes a valid audit through governance', async () => {
    // (8) White-box: the foundation ledger's chain verifies. Black-box: GET /gov/audit with the
    // supervisor bearer token returns chainValid true (and the entries we wrote).
    expect(await h.container.ledger.ledger.verifyChain()).toBe(true)

    const audit = await h.app.inject({
      method: 'GET',
      url: '/gov/audit',
      headers: { authorization: 'Bearer dev-supervisor-key' },
    })
    expect(audit.statusCode, audit.body).toBe(200)
    const view = audit.json() as { entries: unknown[]; merkleRoot: string; chainValid: boolean }
    expect(view.chainValid).toBe(true)
    expect(view.entries.length).toBeGreaterThan(0)
    expect(view.merkleRoot.length).toBeGreaterThan(0)
  })

  it('rejects the governance audit without a valid supervisor token', async () => {
    const noAuth = await h.app.inject({ method: 'GET', url: '/gov/audit' })
    expect(noAuth.statusCode).toBe(401)
    const badAuth = await h.app.inject({
      method: 'GET',
      url: '/gov/audit',
      headers: { authorization: 'Bearer wrong-key' },
    })
    expect(badAuth.statusCode).toBe(401)
  })
})
