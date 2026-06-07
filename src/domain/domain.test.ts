import { describe, it, expect } from 'vitest'
import {
  mFromString,
  mAdd,
  mSub,
  mCmp,
  mGte,
  mIsValidAmount,
  matchTaxonomy,
  taxonomyAllowed,
  validateTaxonomyId,
  nextThreadState,
  milestonesSumToTotal,
  computeTrust,
  emptyMetrics,
  quoteMatchesListingVersion,
  type EscrowContract,
  type Quote,
} from './index'

describe('money', () => {
  it('adds and subtracts without float drift', () => {
    expect(mAdd(mFromString('0.1'), mFromString('0.2')).amount).toBe('0.3')
    expect(mSub(mFromString('1.00'), mFromString('0.02')).amount).toBe('0.98')
  })

  it('compares correctly', () => {
    expect(mCmp(mFromString('1'), mFromString('2'))).toBe(-1)
    expect(mGte(mFromString('5'), mFromString('5'))).toBe(true)
  })

  it('rejects invalid / negative amounts at construction', () => {
    expect(mIsValidAmount('-1')).toBe(false)
    expect(mIsValidAmount('abc')).toBe(false)
    expect(() => mFromString('-1')).toThrow()
  })

  it('refuses cross-currency arithmetic', () => {
    expect(() => mAdd(mFromString('1', 'USDC'), mFromString('1', 'EUR'))).toThrow()
  })
})

describe('taxonomy glob matching', () => {
  it('matches wildcards and prefixes', () => {
    expect(matchTaxonomy('*', 'anything.here')).toBe(true)
    expect(matchTaxonomy('doc.*', 'doc.extract.tables')).toBe(true)
    expect(matchTaxonomy('doc.*', 'doc')).toBe(true)
    expect(matchTaxonomy('infer.llm.*', 'infer.llm.chat')).toBe(true)
    expect(matchTaxonomy('doc.*', 'data.geocode')).toBe(false)
  })

  it('applies deny over allow', () => {
    expect(taxonomyAllowed('payments.send', ['*'], ['payments.*'])).toBe(false)
    expect(taxonomyAllowed('doc.extract.tables', ['doc.*'], ['payments.*'])).toBe(true)
    expect(taxonomyAllowed('identity.rotate', ['doc.*'], [])).toBe(false)
  })

  it('validates taxonomy ids', () => {
    expect(validateTaxonomyId('doc.extract.tables')).toBe(true)
    expect(validateTaxonomyId('Doc.Bad')).toBe(false)
    expect(validateTaxonomyId('')).toBe(false)
  })
})

describe('thread state machine', () => {
  it('walks the negotiation happy path', () => {
    let s = nextThreadState('OPEN', 'QUOTE_REQUEST')
    expect(s).toBe('QUOTING')
    s = nextThreadState(s, 'QUOTE')
    expect(s).toBe('OFFERED')
    s = nextThreadState(s, 'COUNTER')
    expect(s).toBe('OFFERED')
    s = nextThreadState(s, 'ACCEPT')
    expect(s).toBe('AGREED')
  })

  it('closes on reject from any state', () => {
    expect(nextThreadState('OFFERED', 'REJECT')).toBe('CLOSED')
    expect(nextThreadState('OPEN', 'REJECT')).toBe('CLOSED')
  })
})

describe('escrow invariants', () => {
  it('requires milestone amounts to sum to total', () => {
    const base: EscrowContract = {
      escrow_id: 'esc_1',
      job_ref: 'job_1',
      payer: 'did:praxis:agent:a',
      payee: 'did:praxis:agent:b',
      amount: { amount: '40.00', currency: 'USDC' },
      milestones: [
        { id: 'm1', amount: '20.00', acceptance: { type: 'schema', schema_ref: 'x' } },
        { id: 'm2', amount: '20.00', acceptance: { type: 'checksum', expected: 'y' } },
      ],
      deliver_by: '2026-06-08T00:00:00Z',
      on_timeout: 'refund',
      dispute_window_ms: 86400000,
      provider_stake: { amount: '10.00', currency: 'USDC', slashable: true },
      sig_payer: 's',
      sig_payee: 's',
    }
    expect(milestonesSumToTotal(base)).toBe(true)
    expect(milestonesSumToTotal({ ...base, milestones: [base.milestones[0]!] })).toBe(false)
  })
})

describe('quote binding', () => {
  it('voids when the listing version changes', () => {
    const q = { listing_version: '3.2.0' } as Quote
    expect(quoteMatchesListingVersion(q, '3.2.0')).toBe(true)
    expect(quoteMatchesListingVersion(q, '3.3.0')).toBe(false)
  })
})

describe('composite trust', () => {
  it('is 0..1 and rewards good measured behavior', () => {
    const strong = computeTrust({
      ...emptyMetrics(),
      success_rate: 0.99,
      uptime: 0.997,
      latency_ms: { p50: 870, p95: 1500 },
      stake: '250',
      jobs: 1000,
      counterparty_diversity: 0.9,
    })
    const weak = computeTrust({
      ...emptyMetrics(),
      success_rate: 0.5,
      dispute_rate: 0.3,
      refund_rate: 0.2,
      uptime: 0.8,
      latency_ms: { p50: 9000, p95: 12000 },
      stake: '0',
      counterparty_diversity: 0.1,
    })
    expect(strong).toBeGreaterThan(0.7)
    expect(strong).toBeLessThanOrEqual(1)
    expect(weak).toBeLessThan(strong)
    expect(weak).toBeGreaterThanOrEqual(0)
  })

  it('discounts low counterparty diversity (anti-wash)', () => {
    const high = computeTrust({ ...emptyMetrics(), success_rate: 1, uptime: 1, jobs: 100, counterparty_diversity: 1 })
    const low = computeTrust({ ...emptyMetrics(), success_rate: 1, uptime: 1, jobs: 100, counterparty_diversity: 0 })
    expect(low).toBeLessThan(high)
  })

  it('penalizes cross-surface spam/post flags', () => {
    const clean = computeTrust({ ...emptyMetrics(), success_rate: 1, uptime: 1, counterparty_diversity: 1 })
    const flagged = computeTrust({ ...emptyMetrics(), success_rate: 1, uptime: 1, counterparty_diversity: 1, spam_flags: 5 })
    expect(flagged).toBeLessThan(clean)
  })
})
