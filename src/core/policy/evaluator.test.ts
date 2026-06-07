import { describe, it, expect } from 'vitest'
import type { PolicyAction, PolicyDecision } from '../../shared/ports/index'
import { PolicyEvaluator } from './evaluator'
import { makeDelegation, noUsage, usageOf, usd, AGENT_DID } from './_fixtures'

const ev = new PolicyEvaluator()

const spend = (over: Partial<PolicyAction> = {}): PolicyAction => ({
  kind: 'spend',
  agent: AGENT_DID,
  amount: usd('0.02'),
  category: 'doc.extract.tables',
  ...over,
})

const reasons = (d: PolicyDecision): string[] => (d.result === 'deny' || d.result === 'needs_approval' ? d.reasons : [])

describe('PolicyEvaluator — spend caps', () => {
  it('allows an in-policy spend under all caps and the approval threshold', () => {
    const d = ev.evaluate(makeDelegation(), spend(), noUsage())
    expect(d.result).toBe('allow')
  })

  it('denies when the per-transaction amount exceeds per_tx_max', () => {
    const d = ev.evaluate(makeDelegation(), spend({ amount: usd('1.50') }), noUsage())
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('per_tx_max exceeded')
  })

  it('allows an amount exactly equal to per_tx_max (boundary, <= passes)', () => {
    const d = ev.evaluate(makeDelegation(), spend({ amount: usd('1.00') }), noUsage())
    expect(d.result).toBe('allow')
  })

  it('denies when daily spent + amount exceeds daily_max', () => {
    // daily_max 25.00, already spent 24.99, charge 0.02 => 25.01 > 25.00
    const d = ev.evaluate(makeDelegation(), spend({ amount: usd('0.02') }), usageOf('24.99', '24.99'))
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('daily_max exceeded')
  })

  it('allows when daily spent + amount lands exactly on daily_max (boundary)', () => {
    const d = ev.evaluate(makeDelegation(), spend({ amount: usd('0.01') }), usageOf('24.99', '24.99'))
    expect(d.result).toBe('allow')
  })

  it('denies when total spent + amount exceeds total_max', () => {
    // total_max 500.00, already 499.99, charge 0.02 => 500.01 > 500.00.
    // Keep daily under its cap so total is the failing constraint.
    const d = ev.evaluate(makeDelegation(), spend({ amount: usd('0.02') }), usageOf('0.00', '499.99'))
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('total_max exceeded')
  })

  it('allows when total spent + amount lands exactly on total_max (boundary)', () => {
    const d = ev.evaluate(makeDelegation(), spend({ amount: usd('0.01') }), usageOf('0.00', '499.99'))
    expect(d.result).toBe('allow')
  })

  it('checks per_tx before daily before total (per_tx wins when all would fail)', () => {
    const d = ev.evaluate(makeDelegation(), spend({ amount: usd('600.00') }), usageOf('24.00', '499.00'))
    expect(reasons(d)[0]).toContain('per_tx_max exceeded')
  })

  it('denies a spend with a currency that does not match the policy caps', () => {
    const d = ev.evaluate(makeDelegation(), spend({ amount: { amount: '0.02', currency: 'EUR' } }), noUsage())
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('currency mismatch')
  })

  it('denies a spend missing a category', () => {
    const d = ev.evaluate(makeDelegation(), spend({ category: undefined }), noUsage())
    expect(reasons(d)[0]).toContain('category')
  })

  it('denies a spend missing an amount', () => {
    const d = ev.evaluate(makeDelegation(), spend({ amount: undefined }), noUsage())
    expect(reasons(d)[0]).toContain('amount')
  })

  it('treats cross-currency tracked usage as zero in the charge currency (cannot leak under a cap)', () => {
    const usage = { dailySpent: { amount: '999', currency: 'EUR' }, totalSpent: { amount: '999', currency: 'EUR' } }
    const d = ev.evaluate(makeDelegation(), spend({ amount: usd('0.02') }), usage)
    expect(d.result).toBe('allow')
  })
})

describe('PolicyEvaluator — category allow/deny globs', () => {
  it('allows a category matching an allow glob', () => {
    expect(ev.evaluate(makeDelegation(), spend({ category: 'doc.summarize' }), noUsage()).result).toBe('allow')
  })

  it('allows an exact (non-glob) allowed category', () => {
    expect(ev.evaluate(makeDelegation(), spend({ category: 'data.geocode' }), noUsage()).result).toBe('allow')
  })

  it('denies a category not present in any allow glob', () => {
    const d = ev.evaluate(makeDelegation(), spend({ category: 'video.transcode' }), noUsage())
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('category not allowed')
  })

  it('deny glob wins over an allow glob for the same id', () => {
    const deleg = makeDelegation({ policy: { categories_allow: ['payments.*'], categories_deny: ['payments.*'] } })
    const d = ev.evaluate(deleg, spend({ category: 'payments.settle' }), noUsage())
    expect(d.result).toBe('deny')
  })

  it('denies a category caught by a deny glob even when an allow glob would match', () => {
    const d = ev.evaluate(makeDelegation(), spend({ category: 'identity.kyc' }), noUsage())
    expect(d.result).toBe('deny')
  })
})

describe('PolicyEvaluator — counterparty allow/deny', () => {
  it('denies an exact-match denied counterparty', () => {
    const d = ev.evaluate(makeDelegation(), spend({ counterparty: 'did:praxis:agent:badactor' }), noUsage())
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('counterparty denied')
  })

  it('allows a counterparty under the "*" allow-list', () => {
    const d = ev.evaluate(makeDelegation(), spend({ counterparty: 'did:praxis:agent:friend' }), noUsage())
    expect(d.result).toBe('allow')
  })

  it('denies a counterparty absent from a restricted allow-list', () => {
    const deleg = makeDelegation({ policy: { counterparties_allow: ['did:praxis:agent:partner'] } })
    const d = ev.evaluate(deleg, spend({ counterparty: 'did:praxis:agent:stranger' }), noUsage())
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('counterparty not allowed')
  })

  it('counterparty deny short-circuits even an otherwise allowed action', () => {
    const d = ev.evaluate(
      makeDelegation(),
      { kind: 'message', agent: AGENT_DID, counterparty: 'did:praxis:agent:badactor' },
      noUsage(),
    )
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('counterparty denied')
  })
})

describe('PolicyEvaluator — human approval threshold', () => {
  it('returns needs_approval when amount exceeds require_human_approval_over', () => {
    // Raise caps so per_tx/daily/total do not pre-empt the approval branch.
    const deleg = makeDelegation({
      policy: {
        spend: { per_tx_max: usd('100.00'), daily_max: usd('1000.00'), total_max: usd('100000.00') },
      },
    })
    const d = ev.evaluate(deleg, spend({ amount: usd('10.01') }), noUsage())
    expect(d.result).toBe('needs_approval')
    if (d.result === 'needs_approval') expect(d.threshold).toEqual(usd('10.00'))
  })

  it('allows exactly at the approval threshold (only strictly-over needs approval)', () => {
    const deleg = makeDelegation({
      policy: { spend: { per_tx_max: usd('100.00'), daily_max: usd('1000.00'), total_max: usd('100000.00') } },
    })
    const d = ev.evaluate(deleg, spend({ amount: usd('10.00') }), noUsage())
    expect(d.result).toBe('allow')
  })

  it('hard caps (per_tx/daily/total) deny before the approval branch is reached', () => {
    // amount over per_tx (1.00) AND over approval (10.00): per_tx deny takes precedence.
    const d = ev.evaluate(makeDelegation(), spend({ amount: usd('50.00') }), noUsage())
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('per_tx_max exceeded')
  })
})

describe('PolicyEvaluator — tip kind (same path as spend)', () => {
  it('applies spend caps to a tip', () => {
    const tip: PolicyAction = { kind: 'tip', agent: AGENT_DID, amount: usd('2.00'), category: 'doc.extract' }
    const d = ev.evaluate(makeDelegation(), tip, noUsage())
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('per_tx_max exceeded')
  })

  it('allows an in-policy tip', () => {
    const tip: PolicyAction = { kind: 'tip', agent: AGENT_DID, amount: usd('0.10'), category: 'doc.extract' }
    expect(ev.evaluate(makeDelegation(), tip, noUsage()).result).toBe('allow')
  })
})

describe('PolicyEvaluator — message gate', () => {
  it('allows a message when messaging.send is true', () => {
    expect(ev.evaluate(makeDelegation(), { kind: 'message', agent: AGENT_DID }, noUsage()).result).toBe('allow')
  })

  it('denies a message when messaging.send is false', () => {
    const deleg = makeDelegation({ policy: { messaging: { send: false, max_postage_per_day: '0' } } })
    const d = ev.evaluate(deleg, { kind: 'message', agent: AGENT_DID }, noUsage())
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('messaging.send is disabled')
  })
})

describe('PolicyEvaluator — post gate', () => {
  it('allows an offer post when posting.offers is true', () => {
    const d = ev.evaluate(makeDelegation(), { kind: 'post', agent: AGENT_DID, subKind: 'offer' }, noUsage())
    expect(d.result).toBe('allow')
  })

  it('allows an rfp post when posting.rfps is true', () => {
    const d = ev.evaluate(makeDelegation(), { kind: 'post', agent: AGENT_DID, subKind: 'rfp' }, noUsage())
    expect(d.result).toBe('allow')
  })

  it('denies an offer post when posting.offers is false', () => {
    const deleg = makeDelegation({
      policy: { posting: { offers: false, rfps: true, max_post_spend_per_day: '1.00' } },
    })
    const d = ev.evaluate(deleg, { kind: 'post', agent: AGENT_DID, subKind: 'offer' }, noUsage())
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('posting.offers is disabled')
  })

  it('denies an rfp post when posting.rfps is false', () => {
    const deleg = makeDelegation({
      policy: { posting: { offers: true, rfps: false, max_post_spend_per_day: '1.00' } },
    })
    const d = ev.evaluate(deleg, { kind: 'post', agent: AGENT_DID, subKind: 'rfp' }, noUsage())
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('posting.rfps is disabled')
  })

  it('denies any post when posting is fully disabled', () => {
    const deleg = makeDelegation({
      policy: { posting: { offers: false, rfps: false, max_post_spend_per_day: '0' } },
    })
    const d = ev.evaluate(deleg, { kind: 'post', agent: AGENT_DID, subKind: 'offer' }, noUsage())
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('posting is disabled')
  })

  it('allows a non-offer/non-rfp post subkind when posting is enabled at all', () => {
    const d = ev.evaluate(makeDelegation(), { kind: 'post', agent: AGENT_DID, subKind: 'work_record' }, noUsage())
    expect(d.result).toBe('allow')
  })
})

describe('PolicyEvaluator — escrow gate', () => {
  it('allows an in-policy escrow commit under the approval threshold', () => {
    // 5.00 <= max_escrow (100.00) and <= approval threshold (10.00) => straight allow.
    const d = ev.evaluate(makeDelegation(), { kind: 'escrow', agent: AGENT_DID, amount: usd('5.00') }, noUsage())
    expect(d.result).toBe('allow')
  })

  it('escrow over the approval threshold but under max_escrow needs approval', () => {
    const d = ev.evaluate(makeDelegation(), { kind: 'escrow', agent: AGENT_DID, amount: usd('40.00') }, noUsage())
    expect(d.result).toBe('needs_approval')
  })

  it('denies escrow when may_commit is false', () => {
    const deleg = makeDelegation({ policy: { escrow: { may_commit: false, max_escrow: usd('100.00') } } })
    const d = ev.evaluate(deleg, { kind: 'escrow', agent: AGENT_DID, amount: usd('40.00') }, noUsage())
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('escrow.may_commit is disabled')
  })

  it('denies escrow over max_escrow', () => {
    const d = ev.evaluate(makeDelegation(), { kind: 'escrow', agent: AGENT_DID, amount: usd('150.00') }, noUsage())
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('max_escrow exceeded')
  })

  it('returns needs_approval when escrow amount exceeds the approval threshold', () => {
    const d = ev.evaluate(makeDelegation(), { kind: 'escrow', agent: AGENT_DID, amount: usd('50.00') }, noUsage())
    expect(d.result).toBe('needs_approval')
    if (d.result === 'needs_approval') expect(d.threshold).toEqual(usd('10.00'))
  })

  it('denies escrow missing an amount', () => {
    const d = ev.evaluate(makeDelegation(), { kind: 'escrow', agent: AGENT_DID }, noUsage())
    expect(reasons(d)[0]).toContain('amount')
  })

  it('denies escrow with a currency that does not match max_escrow', () => {
    const d = ev.evaluate(
      makeDelegation(),
      { kind: 'escrow', agent: AGENT_DID, amount: { amount: '40.00', currency: 'EUR' } },
      noUsage(),
    )
    expect(reasons(d)[0]).toContain('currency mismatch')
  })
})

describe('PolicyEvaluator — stake gate', () => {
  it('allows a stake when may_stake is true', () => {
    expect(ev.evaluate(makeDelegation(), { kind: 'stake', agent: AGENT_DID }, noUsage()).result).toBe('allow')
  })

  it('denies a stake when may_stake is false', () => {
    const deleg = makeDelegation({ policy: { may_stake: false } })
    const d = ev.evaluate(deleg, { kind: 'stake', agent: AGENT_DID }, noUsage())
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('may_stake is disabled')
  })
})

describe('PolicyEvaluator — deny by default', () => {
  it('denies an unknown action kind', () => {
    const action = { kind: 'wire-transfer', agent: AGENT_DID } as unknown as PolicyAction
    const d = ev.evaluate(makeDelegation(), action, noUsage())
    expect(d.result).toBe('deny')
    expect(reasons(d)[0]).toContain('unknown action kind')
  })

  it('is a pure function: same inputs yield the same decision, no shared state across calls', () => {
    const deleg = makeDelegation()
    const a = ev.evaluate(deleg, spend({ amount: usd('0.50') }), usageOf('24.00', '24.00'))
    const b = ev.evaluate(deleg, spend({ amount: usd('0.50') }), noUsage())
    const c = ev.evaluate(deleg, spend({ amount: usd('0.50') }), usageOf('24.00', '24.00'))
    expect(a.result).toBe('allow')
    expect(b.result).toBe('allow')
    expect(c).toEqual(a)
    // A high-usage call must not contaminate a subsequent fresh-usage call.
    const over = ev.evaluate(deleg, spend({ amount: usd('1.00') }), usageOf('24.99', '24.99'))
    expect(over.result).toBe('deny')
    expect(ev.evaluate(deleg, spend({ amount: usd('1.00') }), noUsage()).result).toBe('allow')
  })
})
