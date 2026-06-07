import { describe, it, expect, beforeEach } from 'vitest'
import { FixedClock } from '../../../shared/time/clock'
import { PaymentRequiredError, NotFoundError, ConflictError, ValidationError } from '../../../shared/errors'
import { WalletService } from './service'
import { MemoryHoldRepo, MemorySpendRepo, MemoryWalletRepo } from './memory'

const A = 'did:praxis:agent:a'
const B = 'did:praxis:agent:b'
const usdc = (amount: string) => ({ amount, currency: 'USDC' })

const newWallet = (seed = '2026-06-06T15:00:00.000Z') => {
  const clock = new FixedClock(seed)
  const svc = new WalletService({
    clock,
    wallets: new MemoryWalletRepo(),
    holds: new MemoryHoldRepo(),
    spends: new MemorySpendRepo(),
  })
  return { clock, svc }
}

describe('WalletService value movement', () => {
  let h: ReturnType<typeof newWallet>
  beforeEach(() => {
    h = newWallet()
  })

  it('credits and reads back available balance', async () => {
    await h.svc.credit(A, usdc('10'), 'seed')

    expect((await h.svc.balanceOf(A, 'USDC')).amount).toBe('10')
  })

  it('debits available and refuses an overdraw with PaymentRequiredError', async () => {
    await h.svc.credit(A, usdc('5'), 'seed')

    await h.svc.debit(A, usdc('3'), 'spend')
    expect((await h.svc.balanceOf(A, 'USDC')).amount).toBe('2')

    await expect(h.svc.debit(A, usdc('10'), 'spend')).rejects.toBeInstanceOf(PaymentRequiredError)
  })

  it('holds move available → held and fail when insufficient', async () => {
    await h.svc.credit(A, usdc('5'), 'seed')

    const holdId = await h.svc.hold(A, usdc('4'), 'job')
    const balances = await h.svc.balances(A)
    expect(balances[0]).toMatchObject({ available: { amount: '1' }, held: { amount: '4' } })
    expect(holdId).toMatch(/^hold_/)

    await expect(h.svc.hold(A, usdc('100'), 'job')).rejects.toBeInstanceOf(PaymentRequiredError)
  })

  it('release returns held → available', async () => {
    await h.svc.credit(A, usdc('5'), 'seed')
    const holdId = await h.svc.hold(A, usdc('4'), 'job')

    await h.svc.release(holdId)

    const balances = await h.svc.balances(A)
    expect(balances[0]).toMatchObject({ available: { amount: '5' }, held: { amount: '0' } })
  })

  it('capture moves held funds to the recipient (the settlement transfer)', async () => {
    await h.svc.credit(A, usdc('5'), 'seed')
    const holdId = await h.svc.hold(A, usdc('4'), 'job')

    await h.svc.capture(holdId, B)

    expect((await h.svc.balanceOf(A, 'USDC')).amount).toBe('1')
    expect((await h.svc.balanceOf(B, 'USDC')).amount).toBe('4')
    const a = await h.svc.balances(A)
    expect(a[0]?.held.amount).toBe('0')
  })

  it('forfeit with split sends part to recipient and burns the rest', async () => {
    await h.svc.credit(A, usdc('10'), 'seed')
    const holdId = await h.svc.hold(A, usdc('10'), 'stake')

    await h.svc.forfeit(holdId, { toRecipient: B, burnFraction: 0.5 })

    expect((await h.svc.balanceOf(B, 'USDC')).amount).toBe('5')
    const a = await h.svc.balances(A)
    expect(a[0]?.held.amount).toBe('0')
  })

  it('forfeit with no split burns the whole hold (leaves the system)', async () => {
    await h.svc.credit(A, usdc('10'), 'seed')
    const holdId = await h.svc.hold(A, usdc('10'), 'stake')

    await h.svc.forfeit(holdId)

    expect((await h.svc.balanceOf(B, 'USDC')).amount).toBe('0')
    const a = await h.svc.balances(A)
    expect(a[0]?.held.amount).toBe('0')
  })

  it('rejects double-spending the same hold', async () => {
    await h.svc.credit(A, usdc('5'), 'seed')
    const holdId = await h.svc.hold(A, usdc('4'), 'job')
    await h.svc.capture(holdId, B)

    await expect(h.svc.capture(holdId, B)).rejects.toBeInstanceOf(ConflictError)
    await expect(h.svc.release(holdId)).rejects.toBeInstanceOf(ConflictError)
  })

  it('throws NotFoundError on an unknown hold', async () => {
    await expect(h.svc.release('hold_missing')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('rejects non-positive amounts', async () => {
    await expect(h.svc.credit(A, usdc('0'), 'seed')).rejects.toBeInstanceOf(ValidationError)
    await expect(h.svc.credit(A, usdc('-1'), 'seed')).rejects.toBeInstanceOf(ValidationError)
  })

  it('serializes concurrent debits so available is never double-spent', async () => {
    await h.svc.credit(A, usdc('10'), 'seed')

    // Fire 10 concurrent debits of 1 each; exactly 10 must succeed (balance is 10).
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => h.svc.debit(A, usdc('1'), 'race')),
    )
    const ok = results.filter((r) => r.status === 'fulfilled').length
    expect(ok).toBe(10)
    expect((await h.svc.balanceOf(A, 'USDC')).amount).toBe('0')
  })
})

describe('WalletService usage accumulator (UsagePort)', () => {
  it('reports zero before any settled spend', async () => {
    const { svc } = newWallet()
    const u = await svc.usage(A)
    expect(u.totalSpent.amount).toBe('0')
    expect(u.dailySpent.amount).toBe('0')
  })

  it('accumulates lifetime + daily spend and resets daily at the UTC day boundary', async () => {
    const { clock, svc } = newWallet('2026-06-06T15:00:00.000Z')

    await svc.recordSpend(A, usdc('0.02'))
    await svc.recordSpend(A, usdc('0.03'))
    let u = await svc.usage(A)
    expect(u.totalSpent.amount).toBe('0.05')
    expect(u.dailySpent.amount).toBe('0.05')

    // Advance into the next UTC day: dailySpent rolls over, totalSpent persists.
    clock.set('2026-06-07T01:00:00.000Z')
    u = await svc.usage(A)
    expect(u.totalSpent.amount).toBe('0.05')
    expect(u.dailySpent.amount).toBe('0')

    await svc.recordSpend(A, usdc('1.00'))
    u = await svc.usage(A)
    expect(u.totalSpent.amount).toBe('1.05')
    expect(u.dailySpent.amount).toBe('1')
  })
})
