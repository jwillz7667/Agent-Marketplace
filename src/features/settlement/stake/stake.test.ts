import { describe, it, expect, beforeEach } from 'vitest'
import { FixedClock } from '../../../shared/time/clock'
import { MemoryIdempotencyStore } from '../../../infrastructure/persistence/memory/idempotency-store'
import { ForbiddenError, PaymentRequiredError } from '../../../shared/errors'
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
  signEnvelope,
  TEST_CONFIG,
  generateKeyPair,
  type KeyPair,
} from '../test-helpers'
import type { StakeInput, TipInput } from './schema'

const AGENT = 'did:praxis:agent:staker'
const PEER = 'did:praxis:agent:peer'

interface Harness {
  module: SettlementModule
  ledger: FakeLedger
  approvals: FakeApprovals
  stakeChanges: { did: string; total: string }[]
  agentKeys: KeyPair
  peerKeys: KeyPair
}

const newHarness = async (signer = new FakeSigner()): Promise<Harness> => {
  const clock = new FixedClock('2026-06-06T15:00:00.000Z')
  const identity = new FakeIdentity()
  const ledger = new FakeLedger()
  const approvals = new FakeApprovals()
  const core = await makeCoreSigner()
  const agentKeys = await generateKeyPair()
  const peerKeys = await generateKeyPair()
  identity.register(AGENT, agentKeys.publicKey)
  identity.register(PEER, peerKeys.publicKey)
  identity.register(core.did, core.publicKey)

  const stakeChanges: { did: string; total: string }[] = []
  const module = buildSettlement({
    clock,
    nonces: new FakeNonces(),
    idempotency: new MemoryIdempotencyStore(),
    identity,
    keystore: { register: async () => {}, getSigningKey: async () => null },
    policy: { evaluate: () => ({ result: 'allow' }) },
    signer,
    ledger,
    reputation: new FakeReputation(),
    approvals,
    coreSigner: core,
    registrySignerDid: 'did:praxis:core:registry',
    onStakeChanged: (did, total) => stakeChanges.push({ did, total }),
    config: TEST_CONFIG,
  })

  await module.faucet(AGENT, { amount: '500.00', currency: 'USDC' })
  return { module, ledger, approvals, stakeChanges, agentKeys, peerKeys }
}

const stake = async (h: Harness, amount: string) =>
  h.module.stakeService.stake(
    (await signEnvelope(
      { agent: AGENT, amount: { amount, currency: 'USDC' }, listing_ref: 'lst_x', nonce: `s-${Math.random()}`, iat: '2026-06-06T15:00:00.000Z', exp: '2026-06-06T15:10:00.000Z' },
      AGENT,
      h.agentKeys,
    )) as unknown as StakeInput,
  )

const tip = async (h: Harness, amount: string, from = AGENT, keys?: KeyPair) =>
  h.module.stakeService.tip(
    (await signEnvelope(
      { from, to: PEER, amount: { amount, currency: 'USDC' }, nonce: `t-${Math.random()}`, iat: '2026-06-06T15:00:00.000Z', exp: '2026-06-06T15:10:00.000Z' },
      from,
      keys ?? h.agentKeys,
    )) as unknown as TipInput,
  )

describe('StakeService.stake (§4.3)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('bonds funds available → held and reflects the running total via onStakeChanged', async () => {
    const out = await stake(h, '50.00')
    expect(out.kind).toBe('staked')

    const bal = await h.module.walletQuery.balances(AGENT)
    expect(bal[0]?.held.amount).toBe('50')
    expect(bal[0]?.available.amount).toBe('450')
    expect(h.stakeChanges.at(-1)).toEqual({ did: AGENT, total: '50' })

    // A second stake accumulates the bonded total.
    await stake(h, '25.00')
    expect(h.stakeChanges.at(-1)).toEqual({ did: AGENT, total: '75' })
    expect(h.ledger.entries.filter((e) => e.kind === 'stake_bonded')).toHaveLength(2)
  })

  it('parks a stake the signer flags for approval — no funds bonded', async () => {
    h = await newHarness(capSigner('10', 'needs_approval'))
    const out = await stake(h, '50.00')

    expect(out.kind).toBe('needs_approval')
    expect(h.approvals.enqueued).toHaveLength(1)
    expect((await h.module.walletQuery.balances(AGENT))[0]?.held.amount ?? '0').toBe('0')
  })

  it('denies a stake the signer refuses', async () => {
    h = await newHarness(capSigner('10', 'deny'))
    await expect(stake(h, '50.00')).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe('StakeService.tip (§4.3)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('transfers value agent→agent and records it as a settled spend', async () => {
    const out = await tip(h, '5.00')
    expect(out.kind).toBe('tipped')

    expect((await h.module.valueTransfer.balanceOf(AGENT, 'USDC')).amount).toBe('495')
    expect((await h.module.valueTransfer.balanceOf(PEER, 'USDC')).amount).toBe('5')
    expect((await h.module.usage.usage(AGENT)).totalSpent.amount).toBe('5')
    expect(h.ledger.entries.some((e) => e.kind === 'tip')).toBe(true)
  })

  it('refuses a tip beyond the funded balance', async () => {
    await expect(tip(h, '9999.00')).rejects.toBeInstanceOf(PaymentRequiredError)
  })

  it('parks a tip over policy — no transfer', async () => {
    h = await newHarness(capSigner('1', 'needs_approval'))
    const out = await tip(h, '5.00')

    expect(out.kind).toBe('needs_approval')
    expect((await h.module.valueTransfer.balanceOf(PEER, 'USDC')).amount).toBe('0')
  })
})
