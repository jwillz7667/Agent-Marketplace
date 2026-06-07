import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyDetached } from '../../src/shared/crypto/index'
import { stripForSigning } from '../../src/domain/index'
import {
  availableBalance,
  buildHarness,
  freshNonce,
  generousPolicy,
  nowIso,
  publishListing,
  registerAndProvision,
  registerPrincipal,
  signDetachedField,
  signEnvelope,
  type Harness,
  type TestAgent,
} from './harness'

// §14.3 — END-TO-END atomic x402 pay flow, driven through the live HTTP surface (app.inject).
// Identity → Registry (discovery + signed quote) → Settlement/Facilitator (402 → settle) →
// Ledger → Reputation, with the §4.3 below-the-agent policy hard stop and §6.1 idempotency.

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

interface QueryMatch {
  listing_id: string
  provider: string
  price: { amount: string; currency: string }
  quote: MatchQuote
  match_explanation: { listing_id: string; score: number; signals: Record<string, number>; notes: string[] }
}

// Sign + send a §2.1 CapabilityQuery; return the ranked matches.
const queryMatches = async (
  h: Harness,
  requester: TestAgent,
  opts: { taxonomy?: string; priceCeiling?: string } = {},
): Promise<QueryMatch[]> => {
  const query = await signEnvelope(
    {
      query_id: `q_${randomBytes(6).toString('hex')}`,
      requester: requester.did,
      capability: { taxonomy: opts.taxonomy ?? 'doc.extract.tables' },
      constraints: opts.priceCeiling
        ? { price_ceiling: { amount: opts.priceCeiling, currency: 'USDC', per: 'call' } }
        : {},
      max_results: 10,
    },
    requester.keys,
    requester.kid,
  )
  const res = await h.app.inject({ method: 'POST', url: '/registry/query', payload: query })
  expect(res.statusCode, res.body).toBe(200)
  return (res.json() as { matches: QueryMatch[] }).matches
}

// Build a §5.3 PaymentPayload (EIP-3009 authorization + payload) signed by the payer over the
// object minus `sig`. The payload carries the full §13 envelope (nonce + iat + exp): the single-use
// nonce (bounded by exp) is the primary replay guard, so a captured payload cannot be re-settled
// under a fresh Idempotency-Key. The EIP-3009 validAfter/validBefore the rail enforces is a second,
// looser bound.
const buildPayment = async (
  payer: TestAgent,
  payee: string,
  quote: MatchQuote,
  overrides: { nonce?: string; authNonce?: string; exp?: string } = {},
): Promise<Record<string, unknown>> => {
  const nowMs = Date.now()
  const unsigned = {
    scheme: 'exact' as const,
    rail: quote.rail,
    authorization: {
      from: payer.did,
      to: payee,
      value: quote.price.amount,
      validAfter: new Date(nowMs - 60_000).toISOString(),
      validBefore: new Date(nowMs + 5 * 60_000).toISOString(),
      nonce: overrides.authNonce ?? `auth-${randomBytes(8).toString('hex')}`,
    },
    quote_id: quote.quote_id,
    from: payer.did,
    to: payee,
    amount: quote.price.amount,
    currency: quote.price.currency,
    nonce: overrides.nonce ?? `pay-${randomBytes(8).toString('hex')}`,
    iat: nowIso(),
    exp: overrides.exp ?? new Date(nowMs + 5 * 60_000).toISOString(),
  }
  const sig = await signDetachedField(unsigned, payer.keys, payer.kid)
  return { ...unsigned, sig }
}

describe('§14.3 atomic x402 pay flow (end-to-end over HTTP)', () => {
  let h: Harness
  let principal: TestAgent
  let provider: TestAgent
  let requester: TestAgent

  beforeAll(async () => {
    h = await buildHarness()

    // (1) Register an org principal, then a provider agent and a requester agent under it. Both
    // agents get a signing key in the keystore (so the below-the-agent signer can act), an active
    // delegation (their spending policy), and a funded wallet.
    principal = await registerPrincipal(h)
    provider = await registerAndProvision(h, principal, {
      policy: generousPolicy(),
      fund: { amount: '100', currency: 'USDC' },
    })
    requester = await registerAndProvision(h, principal, {
      policy: generousPolicy(),
      fund: { amount: '100', currency: 'USDC' },
    })
  })

  afterAll(async () => {
    await h.close()
  })

  it('discovers a listing and returns a signed, bound quote with a match_explanation', async () => {
    // (2) Provider publishes a listing settling on the dev rail.
    const listingId = await publishListing(h, { provider, rail: 'dev', priceAmount: '0.02' })

    // (3) Requester queries → at least one ranked match carrying a registry-signed bound Quote and
    // a match_explanation.
    const matches = await queryMatches(h, requester)
    expect(matches.length).toBeGreaterThanOrEqual(1)

    const match = matches.find((m) => m.listing_id === listingId)
    expect(match).toBeDefined()
    if (!match) throw new Error('listing not in matches')

    expect(match.provider).toBe(provider.did)
    expect(match.match_explanation.listing_id).toBe(listingId)
    expect(match.match_explanation.score).toBeGreaterThanOrEqual(0)
    expect(match.match_explanation.notes.length).toBeGreaterThan(0)

    // The quote binds the listing + price + rail and is signed by the registry core key.
    const quote = match.quote
    expect(quote.listing_id).toBe(listingId)
    expect(quote.rail).toBe('dev')
    expect(quote.price.amount).toBe('0.02')
    expect(quote.requester).toBe(requester.did)

    const registryKey = h.container.coreSigners.registry.publicKey
    const quoteValid = await verifyDetached(stripForSigning(quote, ['sig']), quote.sig, registryKey)
    expect(quoteValid).toBe(true)
  })

  it('returns 402 PaymentRequirements on the first call, then settles + issues a verifiable receipt', async () => {
    const listingId = await publishListing(h, { provider, rail: 'dev', priceAmount: '0.02' })
    const matches = await queryMatches(h, requester)
    const match = matches.find((m) => m.listing_id === listingId)
    expect(match).toBeDefined()
    if (!match) throw new Error('no match')
    const quote = match.quote

    const payerBefore = await availableBalance(h, requester.did)
    const payeeBefore = await availableBalance(h, provider.did)

    // (4) First POST /pay/:listingId WITHOUT a payment → 402 with PaymentRequirements.
    const first = await h.app.inject({
      method: 'POST',
      url: `/pay/${listingId}`,
      payload: { quote, payee: provider.did },
    })
    expect(first.statusCode).toBe(402)
    const req402 = first.json() as Record<string, string>
    expect(req402.scheme).toBe('exact')
    expect(req402.rail).toBe('dev')
    expect(req402.amount).toBe('0.02')
    expect(req402.asset).toBe('USDC')
    expect(req402.pay_to).toBe(provider.did)
    expect(req402.quote_id).toBe(quote.quote_id)
    // x402 echo header present.
    expect(first.headers['payment-required']).toBeDefined()

    // (5) Second POST WITH a signed PaymentPayload + Idempotency-Key → 200 PAYMENT-RECEIPT.
    const payment = await buildPayment(requester, provider.did, quote)
    const idemKey = `idem-${randomBytes(8).toString('hex')}`
    const second = await h.app.inject({
      method: 'POST',
      url: `/pay/${listingId}`,
      headers: { 'idempotency-key': idemKey },
      payload: { quote, payee: provider.did, payment, result: { rows: [{ page: 1 }] } },
    })
    expect(second.statusCode, second.body).toBe(200)
    const receipt = second.json() as Record<string, unknown>

    expect(receipt.payer).toBe(requester.did)
    expect(receipt.payee).toBe(provider.did)
    expect(receipt.quote_id).toBe(quote.quote_id)
    expect(receipt.listing_id).toBe(listingId)
    expect(receipt.rail).toBe('dev')
    expect(receipt.outcome).toBe('delivered')
    expect((receipt.amount as { amount: string }).amount).toBe('0.02')

    // The facilitator signature verifies against the facilitator core key over the receipt minus
    // both sig fields (RECEIPT_SIG_OMIT).
    const facilitatorKey = h.container.coreSigners.facilitator.publicKey
    const receiptValid = await verifyDetached(
      stripForSigning(receipt, ['facilitator_sig', 'payee_sig']),
      receipt.facilitator_sig as string,
      facilitatorKey,
    )
    expect(receiptValid).toBe(true)

    // Payer debited exactly the price; payee credited exactly the price.
    const payerAfter = await availableBalance(h, requester.did)
    const payeeAfter = await availableBalance(h, provider.did)
    expect(Number(payerBefore) - Number(payerAfter)).toBeCloseTo(0.02, 6)
    expect(Number(payeeAfter) - Number(payeeBefore)).toBeCloseTo(0.02, 6)

    // (6) Idempotent retry with the SAME Idempotency-Key + quote → SAME receipt, no double-charge.
    const retry = await h.app.inject({
      method: 'POST',
      url: `/pay/${listingId}`,
      headers: { 'idempotency-key': idemKey },
      payload: { quote, payee: provider.did, payment, result: { rows: [{ page: 1 }] } },
    })
    expect(retry.statusCode, retry.body).toBe(200)
    const retryReceipt = retry.json() as Record<string, unknown>
    expect(retryReceipt.receipt_id).toBe(receipt.receipt_id)

    const payerAfterRetry = await availableBalance(h, requester.did)
    expect(payerAfterRetry).toBe(payerAfter) // not charged twice
  })

  it('rejects a captured payment replayed under a FRESH Idempotency-Key (§13 single-use nonce)', async () => {
    // A1/A4 regression: idempotency is keyed by the client-chosen Idempotency-Key, so a fresh key
    // bypasses the idempotency cache and re-enters settle(). The single-use payload nonce (bounded
    // by exp, both now MANDATORY on PaymentPayload) is the real replay guard: the first settle
    // consumes it, so the captured payload — valid signature, valid still-fresh quote, different
    // Idempotency-Key — must be rejected with 409 and move no money. Without the exp requirement the
    // nonce was never consumed and this exact replay double-charged.
    const listingId = await publishListing(h, { provider, rail: 'dev', priceAmount: '0.03' })
    const matches = await queryMatches(h, requester, { priceCeiling: '1000' })
    const match = matches.find((m) => m.listing_id === listingId)
    if (!match) throw new Error('no match')
    const quote = match.quote

    // The captured payload: a fixed nonce we will deliberately re-send.
    const capturedNonce = `pay-${randomBytes(8).toString('hex')}`
    const payment = await buildPayment(requester, provider.did, quote, { nonce: capturedNonce })

    const first = await h.app.inject({
      method: 'POST',
      url: `/pay/${listingId}`,
      headers: { 'idempotency-key': `idem-${randomBytes(8).toString('hex')}` },
      payload: { quote, payee: provider.did, payment },
    })
    expect(first.statusCode, first.body).toBe(200)

    const payerAfterFirst = await availableBalance(h, requester.did)
    const payeeAfterFirst = await availableBalance(h, provider.did)

    // Replay the SAME signed payload (same nonce) under a brand-new Idempotency-Key.
    const replay = await h.app.inject({
      method: 'POST',
      url: `/pay/${listingId}`,
      headers: { 'idempotency-key': `idem-${randomBytes(8).toString('hex')}` },
      payload: { quote, payee: provider.did, payment },
    })
    expect(replay.statusCode, replay.body).toBe(409)
    expect((replay.json() as { code?: string }).code).toBe('replay_detected')

    // No second charge: balances are exactly where the first (successful) settle left them.
    expect(await availableBalance(h, requester.did)).toBe(payerAfterFirst)
    expect(await availableBalance(h, provider.did)).toBe(payeeAfterFirst)
  })

  it('rejects a PaymentPayload missing its mandatory exp (§13 envelope)', async () => {
    // The exp field is structurally optional in older clients; the verifier must fail closed when a
    // nonce-protected object omits it, rather than silently skipping single-use enforcement.
    const listingId = await publishListing(h, { provider, rail: 'dev', priceAmount: '0.03' })
    const matches = await queryMatches(h, requester, { priceCeiling: '1000' })
    const match = matches.find((m) => m.listing_id === listingId)
    if (!match) throw new Error('no match')
    const quote = match.quote

    const payment = await buildPayment(requester, provider.did, quote)
    // Drop exp and re-sign so the signature itself is valid over the exp-less object — proving the
    // rejection is the envelope rule, not a signature mismatch.
    const { exp: _dropped, sig: _oldSig, ...withoutExp } = payment as Record<string, unknown> & { exp: string }
    const resigned = { ...withoutExp, sig: await signDetachedField(withoutExp, requester.keys, requester.kid) }

    const res = await h.app.inject({
      method: 'POST',
      url: `/pay/${listingId}`,
      headers: { 'idempotency-key': `idem-${randomBytes(8).toString('hex')}` },
      payload: { quote, payee: provider.did, payment: resigned },
    })
    // Schema validation (PaymentPayloadSchema requires exp) rejects at the boundary with 400.
    expect(res.statusCode).toBe(400)
  })

  it('appends the receipt to the ledger and raises the provider reputation', async () => {
    // (7) A settled receipt is on the append-only ledger and the provider has a reputation
    // snapshot reflecting at least one completed job (driven by the prior settles in this suite).
    const ledgerEntries = await h.container.ledger.ledger.list({ kind: 'receipt', subject: provider.did })
    expect(ledgerEntries.length).toBeGreaterThanOrEqual(1)

    const repRes = await h.app.inject({ method: 'GET', url: `/reputation/${provider.did}` })
    expect(repRes.statusCode, repRes.body).toBe(200)
    const snapshot = repRes.json() as { metrics: { jobs: number }; trust: number }
    expect(snapshot.metrics.jobs).toBeGreaterThanOrEqual(1)
    expect(snapshot.trust).toBeGreaterThan(0)

    // The ledger hash-chain remains intact after the settles.
    expect(await h.container.ledger.ledger.verifyChain()).toBe(true)
  })

  it('refuses an over-cap payment BEFORE any money moves (§4.3 hard stop)', async () => {
    // A requester whose per-tx cap is below the price: the below-the-agent signer must refuse the
    // signature, so nothing settles. Listing priced ABOVE the cap.
    const cappedRequester = await registerAndProvision(h, principal, {
      policy: generousPolicy({
        spend: {
          per_tx_max: { amount: '0.01', currency: 'USDC' },
          daily_max: { amount: '10', currency: 'USDC' },
          total_max: { amount: '100', currency: 'USDC' },
        },
      }),
      fund: { amount: '100', currency: 'USDC' },
    })
    const listingId = await publishListing(h, { provider, rail: 'dev', priceAmount: '5.00' })
    const matches = await queryMatches(h, cappedRequester, { priceCeiling: '1000' })
    const match = matches.find((m) => m.listing_id === listingId)
    if (!match) throw new Error('no match')
    const quote = match.quote

    const payerBefore = await availableBalance(h, cappedRequester.did)
    const payeeBefore = await availableBalance(h, provider.did)

    const payment = await buildPayment(cappedRequester, provider.did, quote)
    const res = await h.app.inject({
      method: 'POST',
      url: `/pay/${listingId}`,
      headers: { 'idempotency-key': `idem-${randomBytes(8).toString('hex')}` },
      payload: { quote, payee: provider.did, payment },
    })
    // ForbiddenError → 403. No money moved.
    expect(res.statusCode).toBe(403)
    expect(await availableBalance(h, cappedRequester.did)).toBe(payerBefore)
    expect(await availableBalance(h, provider.did)).toBe(payeeBefore)
  })

  it('settles over the x402 rail too; receipts differ only in the recorded rail', async () => {
    // (9) Rail swap point: the same logical job settles on x402 exactly like dev — identity,
    // discovery, policy and receipt logic are untouched; only receipt.rail differs.
    const devListing = await publishListing(h, { provider, rail: 'dev', priceAmount: '0.05' })
    const x402Listing = await publishListing(h, { provider, rail: 'x402', priceAmount: '0.05' })

    const settle = async (listingId: string): Promise<Record<string, unknown>> => {
      const matches = await queryMatches(h, requester, { priceCeiling: '1000' })
      const match = matches.find((m) => m.listing_id === listingId)
      if (!match) throw new Error(`no match for ${listingId}`)
      const quote = match.quote
      const payment = await buildPayment(requester, provider.did, quote)
      const res = await h.app.inject({
        method: 'POST',
        url: `/pay/${listingId}`,
        headers: { 'idempotency-key': `idem-${randomBytes(8).toString('hex')}` },
        payload: { quote, payee: provider.did, payment },
      })
      expect(res.statusCode, res.body).toBe(200)
      return res.json() as Record<string, unknown>
    }

    const devReceipt = await settle(devListing)
    const x402Receipt = await settle(x402Listing)

    expect(devReceipt.rail).toBe('dev')
    expect(x402Receipt.rail).toBe('x402')
    // Both delivered; both for the same amount + parties — the only material difference is `rail`.
    expect(devReceipt.outcome).toBe('delivered')
    expect(x402Receipt.outcome).toBe('delivered')
    expect((devReceipt.amount as { amount: string }).amount).toBe('0.05')
    expect((x402Receipt.amount as { amount: string }).amount).toBe('0.05')
    expect(devReceipt.payee).toBe(x402Receipt.payee)

    // Both are facilitator-signed and verify.
    const facilitatorKey = h.container.coreSigners.facilitator.publicKey
    for (const r of [devReceipt, x402Receipt]) {
      const ok = await verifyDetached(
        stripForSigning(r, ['facilitator_sig', 'payee_sig']),
        r.facilitator_sig as string,
        facilitatorKey,
      )
      expect(ok).toBe(true)
    }
  })

  // freshNonce is exercised implicitly by signEnvelope; keep an explicit reference so an unused
  // import never silently masks a regression in the harness's nonce generator.
  it('generates unique nonces', () => {
    expect(freshNonce()).not.toBe(freshNonce())
  })
})
