import { describe, it, expect, beforeEach } from 'vitest'
import { FixedClock } from '../../../shared/time/clock'
import { MemoryIdempotencyStore } from '../../../infrastructure/persistence/memory/idempotency-store'
import { verifyDetached } from '../../../shared/crypto/index'
import { stripForSigning } from '../../../domain/index'
import { ForbiddenError, PaymentRequiredError } from '../../../shared/errors'
import type { Quote, Receipt } from '../../../domain/index'
import { buildSettlement, type SettlementModule } from '../index'
import {
  FakeApprovals,
  FakeIdentity,
  FakeLedger,
  FakeNonces,
  FakeReputation,
  FakeSigner,
  capSigner,
  makeCoreSigner,
  signPayment,
  signQuote,
  TEST_CONFIG,
  generateKeyPair,
  type KeyPair,
} from '../test-helpers'
import type { CoreSigner } from '../core-signer'

const LISTING = 'lst_demo'
const PAYER = 'did:praxis:agent:payer'
const PAYEE = 'did:praxis:agent:payee'

interface Harness {
  module: SettlementModule
  identity: FakeIdentity
  ledger: FakeLedger
  reputation: FakeReputation
  approvals: FakeApprovals
  clock: FixedClock
  registry: CoreSigner
  facilitator: CoreSigner
  payerKeys: KeyPair
}

const newHarness = async (signer = new FakeSigner()): Promise<Harness> => {
  const clock = new FixedClock('2026-06-06T15:00:00.000Z')
  const identity = new FakeIdentity()
  const ledger = new FakeLedger()
  const reputation = new FakeReputation()
  const approvals = new FakeApprovals()
  const nonces = new FakeNonces()
  const idempotency = new MemoryIdempotencyStore()

  const registry = await makeCoreSigner('did:praxis:core:registry', 'registry#sign-1')
  const facilitator = await makeCoreSigner('did:praxis:core:facilitator', 'facilitator#sign-1')
  const payerKeys = await generateKeyPair()

  identity.register(PAYER, payerKeys.publicKey)
  identity.register(registry.did, registry.publicKey)
  identity.register(facilitator.did, facilitator.publicKey)

  const module = buildSettlement({
    clock,
    nonces,
    idempotency,
    identity,
    keystore: { register: async () => {}, getSigningKey: async () => null },
    policy: { evaluate: () => ({ result: 'allow' }) },
    signer,
    ledger,
    reputation,
    approvals,
    coreSigner: facilitator,
    registrySignerDid: registry.did,
    config: TEST_CONFIG,
  })

  // Seed the payer's wallet so the rail can settle.
  await module.faucet(PAYER, { amount: '100.00', currency: 'USDC' })

  return { module, identity, ledger, reputation, approvals, clock, registry, facilitator, payerKeys }
}

describe('FacilitatorService.pay — atomic x402 (§5.3, §14.3)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('first call without a payment returns 402 PaymentRequirements bound to the quote', async () => {
    const quote = await signQuote(h.registry, { listingId: LISTING, requester: PAYER })

    const outcome = await h.module.facilitatorService.pay(LISTING, undefined, { quote, payee: PAYEE })

    expect(outcome.kind).toBe('requirements')
    if (outcome.kind !== 'requirements') throw new Error('unreachable')
    expect(outcome.requirements).toMatchObject({
      quote_id: quote.quote_id,
      amount: '0.02',
      pay_to: PAYEE,
      rail: 'x402',
    })
  })

  it('settles the payment, moves USDC, and issues a verifiable signed Receipt', async () => {
    const quote = await signQuote(h.registry, { listingId: LISTING, requester: PAYER })
    const payment = await signPayment(h.payerKeys, { from: PAYER, to: PAYEE, quote })

    const outcome = await h.module.facilitatorService.pay(LISTING, 'idem-1', {
      quote,
      payee: PAYEE,
      payment,
      result: { rows: [{ a: 1 }] },
    })

    expect(outcome.kind).toBe('receipt')
    if (outcome.kind !== 'receipt') throw new Error('unreachable')
    const receipt = outcome.receipt

    // Value moved.
    expect((await h.module.valueTransfer.balanceOf(PAYER, 'USDC')).amount).toBe('99.98')
    expect((await h.module.valueTransfer.balanceOf(PAYEE, 'USDC')).amount).toBe('0.02')

    // Receipt shape + binding.
    expect(receipt.outcome).toBe('delivered')
    expect(receipt.quote_id).toBe(quote.quote_id)
    expect(receipt.payer).toBe(PAYER)
    expect(receipt.payee).toBe(PAYEE)
    expect(receipt.rail).toBe('x402')
    expect(receipt.result_hash).toMatch(/^sha256:/)

    // The facilitator signature verifies against the facilitator core key over the receipt minus
    // both sig fields.
    const payload = stripForSigning(receipt as unknown as Record<string, unknown>, ['facilitator_sig', 'payee_sig'])
    expect(await verifyDetached(payload, receipt.facilitator_sig, h.facilitator.publicKey)).toBe(true)

    // Receipt appended to ledger + ingested into reputation; payer spend recorded for usage.
    expect(h.ledger.entries.some((e) => e.kind === 'receipt')).toBe(true)
    expect(h.reputation.receipts).toHaveLength(1)
    expect((await h.module.usage.usage(PAYER)).totalSpent.amount).toBe('0.02')
  })

  it('idempotent retry (same Idempotency-Key + quote_id) returns the SAME receipt and does not double-charge', async () => {
    const quote = await signQuote(h.registry, { listingId: LISTING, requester: PAYER })
    const payment = await signPayment(h.payerKeys, { from: PAYER, to: PAYEE, quote })

    const first = await h.module.facilitatorService.pay(LISTING, 'idem-9', { quote, payee: PAYEE, payment, result: { rows: [] } })
    const second = await h.module.facilitatorService.pay(LISTING, 'idem-9', { quote, payee: PAYEE, payment, result: { rows: [] } })

    if (first.kind !== 'receipt' || second.kind !== 'receipt') throw new Error('unreachable')
    expect(second.receipt.receipt_id).toBe(first.receipt.receipt_id)

    // Charged exactly once.
    expect((await h.module.valueTransfer.balanceOf(PAYEE, 'USDC')).amount).toBe('0.02')
    expect((await h.module.valueTransfer.balanceOf(PAYER, 'USDC')).amount).toBe('99.98')
    expect(h.reputation.receipts).toHaveLength(1)
  })

  it('parks the payment when policy needs approval — NO charge', async () => {
    h = await newHarness(capSigner('0.01', 'needs_approval'))
    const quote = await signQuote(h.registry, { listingId: LISTING, requester: PAYER, amount: '0.02' })
    const payment = await signPayment(h.payerKeys, { from: PAYER, to: PAYEE, quote })

    const outcome = await h.module.facilitatorService.pay(LISTING, 'idem-park', { quote, payee: PAYEE, payment })

    expect(outcome.kind).toBe('needs_approval')
    if (outcome.kind !== 'needs_approval') throw new Error('unreachable')
    expect(outcome.approvalId).toBe('apr_0')
    expect(h.approvals.enqueued).toHaveLength(1)

    // No money moved, no receipt issued.
    expect((await h.module.valueTransfer.balanceOf(PAYEE, 'USDC')).amount).toBe('0')
    expect((await h.module.valueTransfer.balanceOf(PAYER, 'USDC')).amount).toBe('100')
    expect(h.reputation.receipts).toHaveLength(0)
  })

  it('refuses an over-cap spend at the signer BEFORE any money moves', async () => {
    h = await newHarness(capSigner('0.01', 'deny'))
    const quote = await signQuote(h.registry, { listingId: LISTING, requester: PAYER, amount: '0.02' })
    const payment = await signPayment(h.payerKeys, { from: PAYER, to: PAYEE, quote })

    await expect(
      h.module.facilitatorService.pay(LISTING, 'idem-cap', { quote, payee: PAYEE, payment }),
    ).rejects.toBeInstanceOf(ForbiddenError)

    // The signer ran before settlement; balances are untouched.
    expect((await h.module.valueTransfer.balanceOf(PAYER, 'USDC')).amount).toBe('100')
    expect((await h.module.valueTransfer.balanceOf(PAYEE, 'USDC')).amount).toBe('0')
    expect(h.reputation.receipts).toHaveLength(0)
  })

  it('rejects an expired quote with PaymentRequiredError', async () => {
    const quote = await signQuote(h.registry, {
      listingId: LISTING,
      requester: PAYER,
      expires: '2026-06-06T14:59:00.000Z', // already past the fixed clock
    })

    await expect(
      h.module.facilitatorService.pay(LISTING, undefined, { quote, payee: PAYEE }),
    ).rejects.toBeInstanceOf(PaymentRequiredError)
  })

  it('rejects a quote not signed by the registry core key', async () => {
    // Sign the quote with the payer key but claim it is a registry quote.
    const fakeRegistry: CoreSigner = { ...h.registry, privateKey: h.payerKeys.privateKey, publicKey: h.payerKeys.publicKey }
    const quote = await signQuote(fakeRegistry, { listingId: LISTING, requester: PAYER })

    await expect(
      h.module.facilitatorService.pay(LISTING, undefined, { quote: quote as Quote, payee: PAYEE }),
    ).rejects.toThrow()
  })

  it('rail swap: the SAME job settles over dev and over x402 with identical receipt/identity logic', async () => {
    // x402 path.
    const qX = await signQuote(h.registry, { listingId: LISTING, requester: PAYER, rail: 'x402' })
    const pX = await signPayment(h.payerKeys, { from: PAYER, to: PAYEE, quote: qX })
    const rX = await h.module.facilitatorService.pay(LISTING, 'idem-x', { quote: qX, payee: PAYEE, payment: pX })

    // dev path (a fresh harness so balances start clean and nonces don't collide).
    const h2 = await newHarness()
    const qD = await signQuote(h2.registry, { listingId: LISTING, requester: PAYER, rail: 'dev' })
    const pD = await signPayment(h2.payerKeys, { from: PAYER, to: PAYEE, quote: qD })
    const rD = await h2.module.facilitatorService.pay(LISTING, 'idem-d', { quote: qD, payee: PAYEE, payment: pD })

    if (rX.kind !== 'receipt' || rD.kind !== 'receipt') throw new Error('unreachable')

    // Only the rail field differs; every other receipt field is produced by the same code path.
    expect(rX.receipt.rail).toBe('x402')
    expect(rD.receipt.rail).toBe('dev')
    expect(rX.receipt.amount).toEqual(rD.receipt.amount)
    expect(rX.receipt.outcome).toBe(rD.receipt.outcome)
    expect(rX.receipt.payer).toBe(rD.receipt.payer)
    expect(rX.receipt.payee).toBe(rD.receipt.payee)

    // Both signed by the same facilitator core identity (rail choice never touches signing).
    const verify = async (r: Receipt, pub: Uint8Array) =>
      verifyDetached(stripForSigning(r as unknown as Record<string, unknown>, ['facilitator_sig', 'payee_sig']), r.facilitator_sig, pub)
    expect(await verify(rX.receipt, h.facilitator.publicKey)).toBe(true)
    expect(await verify(rD.receipt, h2.facilitator.publicKey)).toBe(true)
  })
})
