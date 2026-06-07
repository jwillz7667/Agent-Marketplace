import { describe, expect, it } from 'vitest'
import type { Receipt, ReceiptOutcome } from '../../domain/index'
import { stripForSigning } from '../../domain/index'
import { didFromPublicKey, generateKeyPair, verifyDetached } from '../../shared/crypto/index'
import { FixedClock } from '../../shared/time/clock'
import { buildReputation } from './index'
import type { CoreSigner } from './reputation.service'

// --- fixtures ---------------------------------------------------------------------------

const makeCoreSigner = async (): Promise<CoreSigner> => {
  const kp = await generateKeyPair()
  // The reputation engine's DID per the spec: did:praxis:core:reputation (§9.2).
  const did = didFromPublicKey(kp.publicKey, 'core')
  return { did, kid: `${did}#rep-1`, privateKey: kp.privateKey, publicKey: kp.publicKey }
}

let receiptSeq = 0
const makeReceipt = (overrides: Partial<Receipt> = {}): Receipt => {
  receiptSeq += 1
  return {
    receipt_id: overrides.receipt_id ?? `rcp_test_${receiptSeq}`,
    quote_id: overrides.quote_id ?? `qt_${receiptSeq}`,
    listing_id: overrides.listing_id ?? 'lst_1',
    listing_version: overrides.listing_version ?? '1',
    job_ref: overrides.job_ref ?? null,
    payer: overrides.payer ?? 'did:praxis:agent:payer1',
    payee: overrides.payee ?? 'did:praxis:agent:provider',
    amount: overrides.amount ?? { amount: '1.00', currency: 'USDC' },
    rail: overrides.rail ?? 'x402-usdc',
    result_hash: overrides.result_hash ?? 'sha256:deadbeef',
    latency_ms: overrides.latency_ms ?? 1000,
    outcome: overrides.outcome ?? 'delivered',
    settled_at: overrides.settled_at ?? '2026-06-06T15:00:00.000Z',
    facilitator_sig: overrides.facilitator_sig ?? 'fac.sig',
    payee_sig: overrides.payee_sig ?? 'payee.sig',
  }
}

const setup = async () => {
  const clock = new FixedClock()
  const coreSigner = await makeCoreSigner()
  const module = buildReputation({ clock, coreSigner })
  return { clock, coreSigner, ...module }
}

const PROVIDER = 'did:praxis:agent:provider'

// Ingest n receipts whose payers are all distinct (high diversity) or all identical (low).
// A module-global counter guarantees distinct payers are unique across every call within a
// test, so diversity is genuinely 1.0 when requested.
let payerSeq = 0
const ingestN = async (
  svc: Awaited<ReturnType<typeof setup>>['reputationService'],
  n: number,
  opts: { distinctPayers: boolean; outcome?: ReceiptOutcome; latencyMs?: number },
): Promise<void> => {
  for (let i = 0; i < n; i += 1) {
    payerSeq += 1
    await svc.ingestReceipt(
      makeReceipt({
        payee: PROVIDER,
        payer: opts.distinctPayers ? `did:praxis:agent:payer${payerSeq}` : 'did:praxis:agent:payerX',
        outcome: opts.outcome ?? 'delivered',
        latency_ms: opts.latencyMs ?? 1000,
      }),
    )
  }
}

// --- tests ------------------------------------------------------------------------------

describe('ReputationService.ingestReceipt', () => {
  it('raises success_rate and trust as delivered receipts accumulate over a poor start', async () => {
    const { reputationService } = await setup()

    // Poor start: a single disputed job => success_rate 0, dispute_rate 1, low trust.
    await reputationService.ingestReceipt(
      makeReceipt({ payee: PROVIDER, payer: 'did:praxis:agent:firstpayer', outcome: 'disputed' }),
    )
    const start = await reputationService.getSnapshot(PROVIDER)
    expect(start!.metrics.success_rate).toBe(0)

    // Then a run of clean deliveries from distinct counterparties recovers standing.
    await ingestN(reputationService, 19, { distinctPayers: true })
    const recovered = await reputationService.getSnapshot(PROVIDER)

    expect(recovered!.metrics.jobs).toBe(20)
    expect(recovered!.metrics.success_rate).toBeCloseTo(0.95, 6) // 19/20
    expect(recovered!.metrics.success_rate).toBeGreaterThan(start!.metrics.success_rate)
    expect(recovered!.trust).toBeGreaterThan(start!.trust)
  })

  it('counts a refunded outcome as a refund, not a success, and lowers trust', async () => {
    const { reputationService } = await setup()

    await ingestN(reputationService, 9, { distinctPayers: true, outcome: 'delivered' })
    const before = await reputationService.getSnapshot(PROVIDER)

    await reputationService.ingestReceipt(
      makeReceipt({ payee: PROVIDER, payer: 'did:praxis:agent:payerR', outcome: 'refunded' }),
    )
    const after = await reputationService.getSnapshot(PROVIDER)

    expect(after!.metrics.refund_rate).toBeCloseTo(0.1, 6)
    expect(after!.metrics.success_rate).toBeCloseTo(0.9, 6)
    expect(after!.trust).toBeLessThan(before!.trust)
  })

  it('treats a partial outcome as half-credit success', async () => {
    const { reputationService } = await setup()

    await reputationService.ingestReceipt(
      makeReceipt({ payee: PROVIDER, payer: 'did:praxis:agent:p1', outcome: 'partial' }),
    )
    const raw = await reputationService.getRaw(PROVIDER)

    expect(raw!.jobs).toBe(1)
    expect(raw!.success_rate).toBe(0.5)
  })

  it('is idempotent on receipt_id — a duplicate receipt does not double-count', async () => {
    const { reputationService } = await setup()
    const r = makeReceipt({ receipt_id: 'rcp_dup', payee: PROVIDER, payer: 'did:praxis:agent:p1' })

    await reputationService.ingestReceipt(r)
    await reputationService.ingestReceipt(r)

    const raw = await reputationService.getRaw(PROVIDER)
    expect(raw!.jobs).toBe(1)
  })

  it('recomputes p50/p95 latency from the observed sample set', async () => {
    const { reputationService } = await setup()
    for (const ms of [100, 200, 300, 400, 500]) {
      await reputationService.ingestReceipt(
        makeReceipt({ payee: PROVIDER, payer: `did:p${ms}`, latency_ms: ms }),
      )
    }
    const raw = await reputationService.getRaw(PROVIDER)
    expect(raw!.latency_ms.p50).toBe(300)
    expect(raw!.latency_ms.p95).toBe(500)
  })

  it('accumulates settled_value but excludes fully-refunded receipts', async () => {
    const { reputationService } = await setup()
    await reputationService.ingestReceipt(
      makeReceipt({ payee: PROVIDER, payer: 'did:a', amount: { amount: '2.50', currency: 'USDC' } }),
    )
    await reputationService.ingestReceipt(
      makeReceipt({ payee: PROVIDER, payer: 'did:b', amount: { amount: '1.50', currency: 'USDC' }, outcome: 'refunded' }),
    )
    const raw = await reputationService.getRaw(PROVIDER)
    expect(raw!.settled_value).toBe('2.5')
  })
})

describe('ReputationService anti-wash (counterparty diversity, §15.2)', () => {
  it('discounts trust when many jobs come from ONE payer vs many distinct payers', async () => {
    const diverse = await setup()
    const concentrated = await setup()

    // Identical work, identical outcome/latency — the only difference is diversity.
    await ingestN(diverse.reputationService, 10, { distinctPayers: true })
    await ingestN(concentrated.reputationService, 10, { distinctPayers: false })

    const diverseSnap = await diverse.reputationService.getSnapshot(PROVIDER)
    const concentratedSnap = await concentrated.reputationService.getSnapshot(PROVIDER)

    // Same success_rate, but the low-diversity (wash-trade-shaped) graph is discounted.
    expect(diverseSnap!.metrics.success_rate).toBe(concentratedSnap!.metrics.success_rate)
    expect(diverseSnap!.metrics.counterparty_diversity).toBe(1)
    expect(concentratedSnap!.metrics.counterparty_diversity).toBeCloseTo(0.1, 6)
    expect(concentratedSnap!.trust).toBeLessThan(diverseSnap!.trust)
  })
})

describe('ReputationService.ingestSignal (cross-surface, §9.3)', () => {
  it('lowers trust when a message_spam signal is folded into the same DID', async () => {
    const { reputationService } = await setup()
    await ingestN(reputationService, 10, { distinctPayers: true })
    const before = await reputationService.getSnapshot(PROVIDER)

    await reputationService.ingestSignal(PROVIDER, 'message_spam', 3)
    const after = await reputationService.getSnapshot(PROVIDER)

    expect(after!.metrics.spam_flags).toBe(3)
    expect(after!.trust).toBeLessThan(before!.trust)
  })

  it('lowers trust on a post_flag signal and rejects unknown signal kinds', async () => {
    const { reputationService } = await setup()
    await ingestN(reputationService, 10, { distinctPayers: true })
    const before = await reputationService.getSnapshot(PROVIDER)

    await reputationService.ingestSignal(PROVIDER, 'post_flag', 2)
    const after = await reputationService.getSnapshot(PROVIDER)
    expect(after!.metrics.post_flags).toBe(2)
    expect(after!.trust).toBeLessThan(before!.trust)

    await expect(reputationService.ingestSignal(PROVIDER, 'bogus', 1)).rejects.toThrow()
  })
})

describe('ReputationService.setStake', () => {
  it('raises trust via stake confidence and creates a subject from nothing', async () => {
    const { reputationService } = await setup()
    await ingestN(reputationService, 5, { distinctPayers: true })
    const before = await reputationService.getSnapshot(PROVIDER)

    await reputationService.setStake(PROVIDER, '250')
    const after = await reputationService.getSnapshot(PROVIDER)

    expect(after!.metrics.stake).toBe('250')
    expect(after!.trust).toBeGreaterThan(before!.trust)
  })

  it('rejects an invalid stake amount', async () => {
    const { reputationService } = await setup()
    await expect(reputationService.setStake(PROVIDER, 'not-a-number')).rejects.toThrow()
  })
})

describe('ReputationService snapshot signing (§9.2, §13)', () => {
  it('produces a verifiable detached JWS over the snapshot minus [sig]', async () => {
    const { reputationService, coreSigner } = await setup()
    await ingestN(reputationService, 3, { distinctPayers: true })

    const snap = await reputationService.getSnapshot(PROVIDER)
    expect(snap).not.toBeNull()
    expect(snap!.issuer).toBe(coreSigner.did)

    const ok = await verifyDetached(stripForSigning(snap!, ['sig']), snap!.sig, coreSigner.publicKey)
    expect(ok).toBe(true)

    // Tampering with a metric must break verification — the signature binds the metrics.
    const tampered = { ...snap!, trust: 0.999999 }
    const bad = await verifyDetached(stripForSigning(tampered, ['sig']), tampered.sig, coreSigner.publicKey)
    expect(bad).toBe(false)
  })

  it('embeds trust equal to the public computeTrust of the embedded metrics (recomputable)', async () => {
    const { reputationService } = await setup()
    await ingestN(reputationService, 4, { distinctPayers: true })
    await reputationService.setStake(PROVIDER, '100')

    const snap = await reputationService.getSnapshot(PROVIDER)
    const { computeTrust } = await import('../../domain/index')
    expect(snap!.trust).toBe(computeTrust(snap!.metrics))
  })

  it('re-issues the snapshot once the cached one has expired (24h TTL)', async () => {
    const { reputationService, clock } = await setup()
    await ingestN(reputationService, 2, { distinctPayers: true })

    const first = await reputationService.getSnapshot(PROVIDER)
    clock.advance(25 * 60 * 60 * 1000) // past the 24h TTL
    const second = await reputationService.getSnapshot(PROVIDER)

    expect(second!.snapshot_id).not.toBe(first!.snapshot_id)
    expect(new Date(second!.issued).getTime()).toBeGreaterThan(new Date(first!.issued).getTime())
  })
})

describe('ReputationService unknown subject', () => {
  it('returns null for getSnapshot and getRaw of an unknown DID', async () => {
    const { reputationService } = await setup()
    expect(await reputationService.getSnapshot('did:praxis:agent:nobody')).toBeNull()
    expect(await reputationService.getRaw('did:praxis:agent:nobody')).toBeNull()
  })
})

describe('measured-not-reviewed invariant (§9.2)', () => {
  it('exposes no stars/rating/review field anywhere in metrics or snapshot', async () => {
    const { reputationService } = await setup()
    await ingestN(reputationService, 1, { distinctPayers: true })

    const snap = await reputationService.getSnapshot(PROVIDER)
    const raw = await reputationService.getRaw(PROVIDER)

    const forbidden = ['stars', 'rating', 'review', 'reviews', 'comment', 'comments', 'feedback', 'text']
    const snapKeys = JSON.stringify(snap)
    const rawKeys = Object.keys(raw!)
    for (const f of forbidden) {
      expect(rawKeys).not.toContain(f)
      expect(snapKeys.toLowerCase()).not.toContain(`"${f}"`)
    }
  })
})
