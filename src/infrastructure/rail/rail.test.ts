import { describe, it, expect, beforeEach } from 'vitest'
import { FixedClock } from '../../shared/time/clock'
import { RailError } from '../../shared/errors'
import type { PaymentPayload, PaymentRequirements } from '../../domain/index'
import {
  WalletService,
  MemoryHoldRepo,
  MemorySpendRepo,
  MemoryWalletRepo,
} from '../../features/settlement/wallet/index'
import { buildRailRegistry, getRailOrThrow } from './registry'

const PAYER = 'did:praxis:agent:payer'
const PAYEE = 'did:praxis:agent:payee'

const newWallet = (clock: FixedClock) =>
  new WalletService({ clock, wallets: new MemoryWalletRepo(), holds: new MemoryHoldRepo(), spends: new MemorySpendRepo() })

const requirements = (rail: string): PaymentRequirements => ({
  scheme: 'exact',
  rail,
  network: 'praxis-internal',
  asset: 'USDC',
  amount: '0.02',
  pay_to: PAYEE,
  quote_id: 'qt_x',
  nonce: 'req:qt_x',
  expires: '2026-06-06T15:05:00.000Z',
  facilitator: 'praxis-internal',
})

const payment = (rail: string, overrides: Partial<PaymentPayload> = {}): PaymentPayload => ({
  scheme: 'exact',
  rail,
  authorization: {
    from: PAYER,
    to: PAYEE,
    value: '0.02',
    validAfter: '2026-06-06T14:00:00.000Z',
    validBefore: '2026-06-06T16:00:00.000Z',
    nonce: 'auth-1',
  },
  quote_id: 'qt_x',
  from: PAYER,
  to: PAYEE,
  amount: '0.02',
  currency: 'USDC',
  nonce: 'pay-1',
  iat: '2026-06-06T15:00:00.000Z',
  exp: '2026-06-06T15:10:00.000Z',
  sig: 'test',
  ...overrides,
})

describe('RailRegistry', () => {
  it('registers dev + x402 and resolves them, throwing on unknown', () => {
    const clock = new FixedClock()
    const wallet = newWallet(clock)
    const rails = buildRailRegistry({ clock, valueTransfer: wallet })

    expect(rails.list().sort()).toEqual(['dev', 'x402'])
    expect(rails.get('dev')?.id).toBe('dev')
    expect(rails.get('x402')?.id).toBe('x402')
    expect(rails.get('nope')).toBeNull()
    expect(() => getRailOrThrow(rails, 'nope')).toThrow(RailError)
  })
})

describe('DevRail', () => {
  let clock: FixedClock
  let wallet: WalletService
  beforeEach(async () => {
    clock = new FixedClock()
    wallet = newWallet(clock)
    await wallet.credit(PAYER, { amount: '1.00', currency: 'USDC' }, 'seed')
  })

  it('verifies + settles by moving USDC between internal wallets', async () => {
    const rail = getRailOrThrow(buildRailRegistry({ clock, valueTransfer: wallet }), 'dev')

    expect((await rail.verify(payment('dev'), requirements('dev'))).ok).toBe(true)
    const res = await rail.settle(payment('dev'), requirements('dev'))

    expect(res.ok).toBe(true)
    expect(res.railRef).toContain('dev:')
    expect((await wallet.balanceOf(PAYER, 'USDC')).amount).toBe('0.98')
    expect((await wallet.balanceOf(PAYEE, 'USDC')).amount).toBe('0.02')
  })

  it('refuses on payee mismatch / insufficient funds', async () => {
    const rail = getRailOrThrow(buildRailRegistry({ clock, valueTransfer: wallet }), 'dev')

    expect((await rail.verify(payment('dev', { to: 'did:praxis:agent:evil' }), requirements('dev'))).ok).toBe(false)
    const broke = newWallet(clock)
    const rail2 = getRailOrThrow(buildRailRegistry({ clock, valueTransfer: broke }), 'dev')
    expect((await rail2.verify(payment('dev'), requirements('dev'))).ok).toBe(false)
    await expect(rail2.settle(payment('dev'), requirements('dev'))).rejects.toBeInstanceOf(RailError)
  })
})

describe('X402Rail', () => {
  let clock: FixedClock
  let wallet: WalletService
  beforeEach(async () => {
    clock = new FixedClock()
    wallet = newWallet(clock)
    await wallet.credit(PAYER, { amount: '1.00', currency: 'USDC' }, 'seed')
  })

  it('validates the EIP-3009 auth shape + settles against the internal ledger', async () => {
    const rail = getRailOrThrow(buildRailRegistry({ clock, valueTransfer: wallet }), 'x402')

    expect((await rail.verify(payment('x402'), requirements('x402'))).ok).toBe(true)
    const res = await rail.settle(payment('x402'), requirements('x402'))

    expect(res.railRef).toBe('x402:auth-1')
    expect((await wallet.balanceOf(PAYEE, 'USDC')).amount).toBe('0.02')
  })

  it('rejects an expired authorization (validBefore <= now)', async () => {
    const rail = getRailOrThrow(buildRailRegistry({ clock, valueTransfer: wallet }), 'x402')
    const expired = payment('x402', {
      authorization: {
        from: PAYER,
        to: PAYEE,
        value: '0.02',
        validAfter: '2026-06-06T13:00:00.000Z',
        validBefore: '2026-06-06T14:00:00.000Z', // before the fixed clock (15:00)
        nonce: 'auth-2',
      },
    })

    expect((await rail.verify(expired, requirements('x402'))).ok).toBe(false)
    await expect(rail.settle(expired, requirements('x402'))).rejects.toBeInstanceOf(RailError)
  })

  it('rejects an auth value that disagrees with the requirements amount', async () => {
    const rail = getRailOrThrow(buildRailRegistry({ clock, valueTransfer: wallet }), 'x402')
    const wrong = payment('x402', {
      authorization: {
        from: PAYER,
        to: PAYEE,
        value: '99.00',
        validAfter: '2026-06-06T14:00:00.000Z',
        validBefore: '2026-06-06T16:00:00.000Z',
        nonce: 'auth-3',
      },
    })

    expect((await rail.verify(wrong, requirements('x402'))).ok).toBe(false)
  })
})
