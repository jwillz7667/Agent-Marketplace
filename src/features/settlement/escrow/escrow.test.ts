import { describe, it, expect, beforeEach } from 'vitest'
import { FixedClock } from '../../../shared/time/clock'
import { MemoryIdempotencyStore } from '../../../infrastructure/persistence/memory/idempotency-store'
import { ConflictError, ForbiddenError } from '../../../shared/errors'
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
  signEscrowOpen,
  TEST_CONFIG,
  generateKeyPair,
  type KeyPair,
} from '../test-helpers'
import type { CoreSigner } from '../core-signer'
import type {
  OpenEscrowInput,
  DeliverInput,
  AcceptInput,
  DisputeInput,
  ResolveEscalationInput,
} from './schema'

const PAYER = 'did:praxis:agent:requester'
const PAYEE = 'did:praxis:agent:provider'
const GOOD_HASH = 'sha256:goodresult'
const BAD_HASH = 'sha256:badresult'

interface Harness {
  module: SettlementModule
  ledger: FakeLedger
  reputation: FakeReputation
  approvals: FakeApprovals
  clock: FixedClock
  core: CoreSigner
  payerKeys: KeyPair
  payeeKeys: KeyPair
}

const newHarness = async (signer = new FakeSigner()): Promise<Harness> => {
  const clock = new FixedClock('2026-06-06T15:00:00.000Z')
  const identity = new FakeIdentity()
  const ledger = new FakeLedger()
  const reputation = new FakeReputation()
  const approvals = new FakeApprovals()
  const core = await makeCoreSigner()
  const payerKeys = await generateKeyPair()
  const payeeKeys = await generateKeyPair()
  identity.register(PAYER, payerKeys.publicKey)
  identity.register(PAYEE, payeeKeys.publicKey)
  identity.register(core.did, core.publicKey)

  const module = buildSettlement({
    clock,
    nonces: new FakeNonces(),
    idempotency: new MemoryIdempotencyStore(),
    identity,
    keystore: { register: async () => {}, getSigningKey: async () => null },
    policy: { evaluate: () => ({ result: 'allow' }) },
    signer,
    ledger,
    reputation,
    approvals,
    coreSigner: core,
    registrySignerDid: 'did:praxis:core:registry',
    config: TEST_CONFIG,
  })

  await module.faucet(PAYER, { amount: '1000.00', currency: 'USDC' })
  await module.faucet(PAYEE, { amount: '1000.00', currency: 'USDC' })
  return { module, ledger, reputation, approvals, clock, core, payerKeys, payeeKeys }
}

type AcceptanceType = 'schema' | 'checksum' | 'schema+checksum' | 'oracle'

const open = async (
  h: Harness,
  escrowId: string,
  acceptanceType: AcceptanceType,
  opts: { stakeAmount?: string } = {},
) =>
  h.module.escrowService.open(
    (await signEscrowOpen({
      escrowId,
      jobRef: `job_${escrowId}`,
      payer: PAYER,
      payee: PAYEE,
      payerKeys: h.payerKeys,
      payeeKeys: h.payeeKeys,
      total: '120.00',
      milestones: [{ id: 'm1', amount: '120.00', acceptance: { type: acceptanceType, expected: GOOD_HASH } }],
      stakeAmount: opts.stakeAmount ?? '20.00',
    })) as unknown as OpenEscrowInput,
  )

const deliver = async (h: Harness, escrowId: string, resultHash: string) =>
  h.module.escrowService.deliver(
    escrowId,
    (await signEnvelope(
      { milestone_id: 'm1', result_hash: resultHash, provider: PAYEE, nonce: `d-${Math.random()}`, iat: '2026-06-06T15:00:00.000Z', exp: '2026-06-06T15:10:00.000Z' },
      PAYEE,
      h.payeeKeys,
    )) as unknown as DeliverInput,
  )

const accept = async (h: Harness, escrowId: string) =>
  h.module.escrowService.accept(
    escrowId,
    (await signEnvelope(
      { milestone_id: 'm1', payer: PAYER, nonce: `a-${Math.random()}`, iat: '2026-06-06T15:00:00.000Z', exp: '2026-06-06T15:10:00.000Z' },
      PAYER,
      h.payerKeys,
    )) as unknown as AcceptInput,
  )

const dispute = async (
  h: Harness,
  escrowId: string,
  disputer: string,
  keys: KeyPair,
  bond?: { amount: string; currency: string },
) =>
  h.module.escrowService.dispute(
    escrowId,
    (await signEnvelope(
      { milestone_id: 'm1', disputer, reason_code: 'checksum', ...(bond ? { bond } : {}), nonce: `dp-${Math.random()}`, iat: '2026-06-06T15:00:00.000Z', exp: '2026-06-06T15:10:00.000Z' },
      disputer,
      keys,
    )) as unknown as DisputeInput,
  )

describe('EscrowService.open (§6.2)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('holds the payer funds + provider stake on open', async () => {
    const out = await open(h, 'esc_1', 'checksum')
    expect(out.kind).toBe('state')

    expect((await h.module.valueTransfer.balanceOf(PAYER, 'USDC')).amount).toBe('880')
    expect((await h.module.walletQuery.balances(PAYER))[0]?.held.amount).toBe('120')
    expect((await h.module.walletQuery.balances(PAYEE))[0]?.held.amount).toBe('20')
    expect(h.ledger.entries.some((e) => e.kind === 'escrow_open')).toBe(true)
  })

  it('rejects milestones that do not sum to the total', async () => {
    const bad = (await signEscrowOpen({
      escrowId: 'esc_bad',
      jobRef: 'job_x',
      payer: PAYER,
      payee: PAYEE,
      payerKeys: h.payerKeys,
      payeeKeys: h.payeeKeys,
      total: '120.00',
      milestones: [{ id: 'm1', amount: '50.00', acceptance: { type: 'checksum', expected: GOOD_HASH } }],
    })) as unknown as OpenEscrowInput
    await expect(h.module.escrowService.open(bad)).rejects.toThrow(/sum exactly/)
  })

  it('parks open for approval over the commit cap — no funds locked', async () => {
    h = await newHarness(capSigner('100', 'needs_approval'))
    const out = await open(h, 'esc_p', 'checksum')

    expect(out.kind).toBe('needs_approval')
    expect(h.approvals.enqueued).toHaveLength(1)
    expect((await h.module.valueTransfer.balanceOf(PAYER, 'USDC')).amount).toBe('1000')
  })

  it('denies open over the commit cap before any funds lock', async () => {
    h = await newHarness(capSigner('100', 'deny'))
    await expect(open(h, 'esc_d', 'checksum')).rejects.toBeInstanceOf(ForbiddenError)
    expect((await h.module.valueTransfer.balanceOf(PAYER, 'USDC')).amount).toBe('1000')
  })
})

describe('EscrowService deterministic acceptance (§9.5)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('objective (checksum) deliver with a matching hash AUTO-ACCEPTS, pays the provider + releases stake', async () => {
    await open(h, 'esc_1', 'checksum')

    const out = await deliver(h, 'esc_1', GOOD_HASH)
    expect(out.kind).toBe('state')

    // Provider: 1000 + 120 milestone; stake (20) released → held back to 0.
    expect((await h.module.valueTransfer.balanceOf(PAYEE, 'USDC')).amount).toBe('1120')
    expect((await h.module.walletQuery.balances(PAYEE))[0]?.held.amount).toBe('0')
    expect(h.reputation.receipts.some((r) => r.outcome === 'delivered')).toBe(true)
    if (out.kind === 'state') expect(out.record.state).toBe('released')
  })

  it('objective (checksum) deliver with a mismatching hash AUTO-REFUNDS the payer + returns the un-slashed stake (B8)', async () => {
    await open(h, 'esc_2', 'checksum')

    await deliver(h, 'esc_2', BAD_HASH)

    // Payer milestone funds returned in full.
    expect((await h.module.valueTransfer.balanceOf(PAYER, 'USDC')).amount).toBe('1000')
    expect((await h.module.walletQuery.balances(PAYER))[0]?.held.amount).toBe('0')
    expect(h.reputation.receipts.some((r) => r.outcome === 'refunded')).toBe(true)
    // A benign refund with NO dispute proves no misdelivery, so the provider's stake is NOT slashed
    // — and (B8) it must not be stranded either: the escrow has fully settled, so the 20 stake is
    // released back to the provider (held → 0, available restored to 1000).
    const payee = await h.module.walletQuery.balances(PAYEE)
    expect(payee[0]?.held.amount).toBe('0')
    expect(payee[0]?.available.amount).toBe('1000')
  })

  it('subjective-component (schema+checksum) deliver waits for an explicit accept', async () => {
    await open(h, 'esc_3', 'schema+checksum')

    await deliver(h, 'esc_3', GOOD_HASH)
    // Not yet captured (milestone funds still held by payer); provider's 20 stake is held so its
    // available reads 980, not 1000.
    expect((await h.module.valueTransfer.balanceOf(PAYEE, 'USDC')).amount).toBe('980')
    expect((await h.module.walletQuery.balances(PAYER))[0]?.held.amount).toBe('120')

    await accept(h, 'esc_3')
    // Now captured + stake released.
    expect((await h.module.valueTransfer.balanceOf(PAYEE, 'USDC')).amount).toBe('1120')
    expect((await h.module.walletQuery.balances(PAYEE))[0]?.held.amount).toBe('0')
  })
})

describe('EscrowService dispute — both-direction slashing (§9.5)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('dispute on a BAD delivery resolves FOR the requester: refund payer + slash provider stake', async () => {
    await open(h, 'esc_bad', 'schema+checksum')
    await deliver(h, 'esc_bad', BAD_HASH) // subjective component → stays delivered

    const out = await dispute(h, 'esc_bad', PAYER, h.payerKeys)
    expect(out.kind).toBe('state')

    // Milestone funds refunded to payer (back to 1000) AND provider stake (20) forfeited to payer.
    expect((await h.module.valueTransfer.balanceOf(PAYER, 'USDC')).amount).toBe('1020')
    const payee = await h.module.walletQuery.balances(PAYEE)
    expect(payee[0]?.held.amount).toBe('0')
    expect(payee[0]?.available.amount).toBe('980') // lost the 20 stake
    expect(h.reputation.receipts.some((r) => r.outcome === 'disputed')).toBe(true)
  })

  it('griefing: dispute on a GOOD delivery resolves FOR the provider + slashes the disputer bond', async () => {
    await open(h, 'esc_grief', 'schema+checksum')
    await deliver(h, 'esc_grief', GOOD_HASH) // good hash, subjective component → stays delivered

    const out = await dispute(h, 'esc_grief', PAYER, h.payerKeys, { amount: '5.00', currency: 'USDC' })
    expect(out.kind).toBe('state')

    // Provider paid the milestone (1000 + 120) and compensated with the disputer's 5 bond → 1125.
    expect((await h.module.valueTransfer.balanceOf(PAYEE, 'USDC')).amount).toBe('1125')
    // Disputer (payer) lost the 5 bond: started 1000, held 120 on open, bonded 5 (held), then
    // milestone captured (held→provider), bond forfeited (held→provider). Available = 875.
    const payer = await h.module.walletQuery.balances(PAYER)
    expect(payer[0]?.available.amount).toBe('875')
    expect(payer[0]?.held.amount).toBe('0')
    // Griefing penalty signal recorded against the disputer.
    expect(h.reputation.signals.some((s) => s.did === PAYER && s.kind === 'frivolous_dispute')).toBe(true)
  })

  it('escalates a purely-subjective (schema) dispute to governance — funds stay locked', async () => {
    await open(h, 'esc_subj', 'schema')
    await deliver(h, 'esc_subj', GOOD_HASH)

    const out = await dispute(h, 'esc_subj', PAYER, h.payerKeys)
    expect(out.kind).toBe('needs_approval')
    expect(h.approvals.enqueued).toHaveLength(1)
    // Nothing settled: milestone funds still held by the payer.
    expect((await h.module.walletQuery.balances(PAYER))[0]?.held.amount).toBe('120')
    expect(h.ledger.entries.some((e) => e.kind === 'escrow_dispute_escalated')).toBe(true)
  })

  it('rejects a dispute after the dispute window has closed', async () => {
    await open(h, 'esc_late', 'schema+checksum')
    await deliver(h, 'esc_late', BAD_HASH)
    h.clock.advance(86400000 + 1) // past dispute_window_ms (delivered at open clock)

    // The dispute envelope itself stays fresh (far-future exp) so we exercise the WINDOW guard, not
    // envelope expiry.
    const late = (await signEnvelope(
      { milestone_id: 'm1', disputer: PAYER, reason_code: 'checksum', nonce: 'dp-late', iat: '2026-06-07T15:00:00.000Z', exp: '2026-06-07T15:10:00.000Z' },
      PAYER,
      h.payerKeys,
    )) as unknown as DisputeInput
    await expect(h.module.escrowService.dispute('esc_late', late)).rejects.toBeInstanceOf(ConflictError)
  })
})

describe('EscrowService timeout (§6.2 on_timeout)', () => {
  it('refunds pending milestones + releases stake when deliver_by elapses (on_timeout=refund)', async () => {
    const h = await newHarness()
    await open(h, 'esc_to', 'schema+checksum')
    h.clock.set('2026-06-09T00:00:00.000Z') // past deliver_by

    const out = await h.module.escrowService.onTimeout('esc_to')
    expect(out.kind).toBe('state')

    expect((await h.module.valueTransfer.balanceOf(PAYER, 'USDC')).amount).toBe('1000')
    expect((await h.module.walletQuery.balances(PAYEE))[0]?.held.amount).toBe('0') // stake released
  })

  it('releases the stake on a release-outcome timeout too (on_timeout=release captures + returns stake)', async () => {
    const h = await newHarness()
    // schema+checksum milestone is NOT auto-settled on deliver, so it is still pending at timeout.
    const input = (await signEscrowOpen({
      escrowId: 'esc_to_rel',
      jobRef: 'job_to_rel',
      payer: PAYER,
      payee: PAYEE,
      payerKeys: h.payerKeys,
      payeeKeys: h.payeeKeys,
      total: '120.00',
      milestones: [{ id: 'm1', amount: '120.00', acceptance: { type: 'schema+checksum', expected: GOOD_HASH } }],
      onTimeout: 'release',
      stakeAmount: '20.00',
    })) as unknown as OpenEscrowInput
    await h.module.escrowService.open(input)
    h.clock.set('2026-06-09T00:00:00.000Z') // past deliver_by

    await h.module.escrowService.onTimeout('esc_to_rel')

    // Provider captured the milestone (1000 + 120) AND got its 20 stake back: held → 0, avail 1120.
    const payee = await h.module.walletQuery.balances(PAYEE)
    expect(payee[0]?.held.amount).toBe('0')
    expect(payee[0]?.available.amount).toBe('1120')
  })
})

describe('EscrowService.resolveEscalation — escalated escrow settlement (B2, §9.5)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  // Trigger a §6.2 resolve: the caller's signature only authenticates the trigger; the OUTCOME is
  // fixed by the governance ruling already redeemed from the ApprovalPort. `env` lets timeout tests
  // (clock advanced past deliver_by) sign a fresh, non-expired envelope.
  const resolve = async (
    escrowId: string,
    caller: string,
    keys: KeyPair,
    env: { iat?: string; exp?: string } = {},
  ) =>
    h.module.escrowService.resolveEscalation(
      escrowId,
      (await signEnvelope(
        {
          caller,
          nonce: `rs-${Math.random()}`,
          iat: env.iat ?? '2026-06-06T15:00:00.000Z',
          exp: env.exp ?? '2026-06-06T15:10:00.000Z',
        },
        caller,
        keys,
      )) as unknown as ResolveEscalationInput,
    )

  const openArbitrate = async (escrowId: string) =>
    h.module.escrowService.open(
      (await signEscrowOpen({
        escrowId,
        jobRef: `job_${escrowId}`,
        payer: PAYER,
        payee: PAYEE,
        payerKeys: h.payerKeys,
        payeeKeys: h.payeeKeys,
        total: '120.00',
        milestones: [{ id: 'm1', amount: '120.00', acceptance: { type: 'checksum', expected: GOOD_HASH } }],
        onTimeout: 'arbitrate',
        stakeAmount: '20.00',
      })) as unknown as OpenEscrowInput,
    )

  it('subjective dispute UPHELD: refunds the payer, slashes the provider stake, returns the bond', async () => {
    await open(h, 'esc_up', 'schema')
    await deliver(h, 'esc_up', GOOD_HASH)
    const parked = await dispute(h, 'esc_up', PAYER, h.payerKeys, { amount: '5.00', currency: 'USDC' })
    expect(parked.kind).toBe('needs_approval')
    const approvalId = h.approvals.enqueued[0]!.approvalId

    // Governance rules FOR the disputer (payer), then either party triggers settlement.
    h.approvals.resolve(approvalId, 'approved')
    const out = await resolve('esc_up', PAYEE, h.payeeKeys)
    expect(out.kind === 'state' && out.record.state).toBe('resolved')

    // Payer made whole: milestone refunded (+120), provider stake forfeited to payer (+20), bond
    // returned (+5) → 1000 - 120 - 5 held on open/bond, all released → 1020 available, 0 held.
    const payer = await h.module.walletQuery.balances(PAYER)
    expect(payer[0]?.available.amount).toBe('1020')
    expect(payer[0]?.held.amount).toBe('0')
    // Provider lost the 20 stake.
    const payee = await h.module.walletQuery.balances(PAYEE)
    expect(payee[0]?.available.amount).toBe('980')
    expect(payee[0]?.held.amount).toBe('0')
    expect(h.reputation.receipts.some((r) => r.outcome === 'disputed')).toBe(true)
    expect(h.ledger.entries.some((e) => e.kind === 'escrow_escalation_resolved')).toBe(true)
  })

  it('subjective dispute REJECTED: pays the provider, returns its stake, forfeits the disputer bond + penalty', async () => {
    await open(h, 'esc_rej', 'schema')
    await deliver(h, 'esc_rej', GOOD_HASH)
    const parked = await dispute(h, 'esc_rej', PAYER, h.payerKeys, { amount: '5.00', currency: 'USDC' })
    expect(parked.kind).toBe('needs_approval')
    const approvalId = h.approvals.enqueued[0]!.approvalId

    // Governance rules AGAINST the disputer (frivolous): the provider wins the milestone.
    h.approvals.resolve(approvalId, 'denied')
    const out = await resolve('esc_rej', PAYER, h.payerKeys)
    expect(out.kind === 'state' && out.record.state).toBe('resolved')

    // Provider: milestone captured (+120), stake returned (+20), disputer bond forfeited as
    // compensation (+5) → 1125 available, 0 held.
    const payee = await h.module.walletQuery.balances(PAYEE)
    expect(payee[0]?.available.amount).toBe('1125')
    expect(payee[0]?.held.amount).toBe('0')
    // Disputer (payer): lost the milestone payment (120) and the 5 bond → 875 available, 0 held.
    const payer = await h.module.walletQuery.balances(PAYER)
    expect(payer[0]?.available.amount).toBe('875')
    expect(payer[0]?.held.amount).toBe('0')
    // Griefing penalty recorded against the disputer.
    expect(h.reputation.signals.some((s) => s.did === PAYER && s.kind === 'frivolous_dispute')).toBe(true)
  })

  it('arbitrate-timeout APPROVED: captures the pending milestone to the provider + returns its stake', async () => {
    await openArbitrate('esc_to_up')
    h.clock.set('2026-06-09T00:00:00.000Z') // past deliver_by
    const parked = await h.module.escrowService.onTimeout('esc_to_up')
    expect(parked.kind).toBe('needs_approval')
    const approvalId = h.approvals.enqueued[0]!.approvalId

    h.approvals.resolve(approvalId, 'approved')
    const out = await resolve('esc_to_up', PAYEE, h.payeeKeys, {
      iat: '2026-06-09T00:00:00.000Z',
      exp: '2026-06-09T00:10:00.000Z',
    })
    expect(out.kind === 'state' && out.record.state).toBe('timed_out')

    // Provider captured the pending milestone (+120) and got its 20 stake back → 1120, 0 held.
    const payee = await h.module.walletQuery.balances(PAYEE)
    expect(payee[0]?.available.amount).toBe('1120')
    expect(payee[0]?.held.amount).toBe('0')
    // Payer paid the milestone: 880 available, 0 held.
    const payer = await h.module.walletQuery.balances(PAYER)
    expect(payer[0]?.available.amount).toBe('880')
    expect(payer[0]?.held.amount).toBe('0')
  })

  it('arbitrate-timeout DENIED: refunds the pending milestone to the payer + returns the un-slashed stake', async () => {
    await openArbitrate('esc_to_dn')
    h.clock.set('2026-06-09T00:00:00.000Z') // past deliver_by
    const parked = await h.module.escrowService.onTimeout('esc_to_dn')
    expect(parked.kind).toBe('needs_approval')
    const approvalId = h.approvals.enqueued[0]!.approvalId

    h.approvals.resolve(approvalId, 'denied')
    const out = await resolve('esc_to_dn', PAYER, h.payerKeys, {
      iat: '2026-06-09T00:00:00.000Z',
      exp: '2026-06-09T00:10:00.000Z',
    })
    expect(out.kind === 'state' && out.record.state).toBe('timed_out')

    // Payer refunded in full (1000) and provider stake — never slashed on timeout — returned (1000).
    expect((await h.module.valueTransfer.balanceOf(PAYER, 'USDC')).amount).toBe('1000')
    const payee = await h.module.walletQuery.balances(PAYEE)
    expect(payee[0]?.available.amount).toBe('1000')
    expect(payee[0]?.held.amount).toBe('0')
  })

  it('refuses to resolve before governance has ruled (approval still pending → 409)', async () => {
    await open(h, 'esc_early', 'schema')
    await deliver(h, 'esc_early', GOOD_HASH)
    await dispute(h, 'esc_early', PAYER, h.payerKeys)

    // No resolve(approvalId) call → the redeem at the signing boundary refuses the still-pending
    // clearance and the funds stay locked rather than settling on an un-ruled escalation.
    await expect(resolve('esc_early', PAYER, h.payerKeys)).rejects.toThrow(/not yet resolved/)
    expect((await h.module.walletQuery.balances(PAYER))[0]?.held.amount).toBe('120')
  })

  it('is single-use: a second resolve on a settled escalation 409s (no open escalation)', async () => {
    await open(h, 'esc_twice', 'schema')
    await deliver(h, 'esc_twice', GOOD_HASH)
    const parked = await dispute(h, 'esc_twice', PAYER, h.payerKeys)
    const approvalId = (parked as { approvalId: string }).approvalId

    h.approvals.resolve(approvalId, 'approved')
    await resolve('esc_twice', PAYER, h.payerKeys) // settles → state 'resolved', escalation cleared

    await expect(resolve('esc_twice', PAYER, h.payerKeys)).rejects.toBeInstanceOf(ConflictError)
  })

  it('rejects a resolve trigger from a non-party before any signature check', async () => {
    await open(h, 'esc_str', 'schema')
    await deliver(h, 'esc_str', GOOD_HASH)
    const parked = await dispute(h, 'esc_str', PAYER, h.payerKeys)
    h.approvals.resolve((parked as { approvalId: string }).approvalId, 'approved')

    await expect(
      resolve('esc_str', 'did:praxis:agent:stranger', h.payerKeys),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe('EscrowService terminal-state guard (B3) + mixed-settlement stake (B8)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('rejects any further action once the escrow is terminal (B3)', async () => {
    await open(h, 'esc_done', 'checksum')
    const settled = await deliver(h, 'esc_done', GOOD_HASH) // auto-accepts → state 'released'
    expect(settled.kind === 'state' && settled.record.state).toBe('released')

    // A terminal escrow admits NO further deliver / accept / dispute / timeout: each must 409 at the
    // requireOpenish guard rather than re-acting on already-captured holds.
    await expect(deliver(h, 'esc_done', GOOD_HASH)).rejects.toBeInstanceOf(ConflictError)
    await expect(accept(h, 'esc_done')).rejects.toBeInstanceOf(ConflictError)
    await expect(dispute(h, 'esc_done', PAYER, h.payerKeys)).rejects.toBeInstanceOf(ConflictError)
    h.clock.set('2026-06-09T00:00:00.000Z')
    await expect(h.module.escrowService.onTimeout('esc_done')).rejects.toBeInstanceOf(ConflictError)
  })

  it('returns the un-slashed stake when a multi-milestone escrow settles with a mix of release + refund (B8)', async () => {
    const input = (await signEscrowOpen({
      escrowId: 'esc_mix',
      jobRef: 'job_mix',
      payer: PAYER,
      payee: PAYEE,
      payerKeys: h.payerKeys,
      payeeKeys: h.payeeKeys,
      total: '120.00',
      milestones: [
        { id: 'm1', amount: '70.00', acceptance: { type: 'checksum', expected: GOOD_HASH } },
        { id: 'm2', amount: '50.00', acceptance: { type: 'checksum', expected: GOOD_HASH } },
      ],
      stakeAmount: '20.00',
    })) as unknown as OpenEscrowInput
    await h.module.escrowService.open(input)

    const deliverM = async (milestoneId: string, hash: string) =>
      h.module.escrowService.deliver(
        'esc_mix',
        (await signEnvelope(
          { milestone_id: milestoneId, result_hash: hash, provider: PAYEE, nonce: `d-${milestoneId}-${Math.random()}`, iat: '2026-06-06T15:00:00.000Z', exp: '2026-06-06T15:10:00.000Z' },
          PAYEE,
          h.payeeKeys,
        )) as unknown as DeliverInput,
      )

    await deliverM('m1', GOOD_HASH) // objective pass → captured to provider
    const last = await deliverM('m2', BAD_HASH) // objective fail → auto-refunded to payer

    // Both milestones settled (one released, one refunded) with NO dispute → escrow 'resolved',
    // and the provider stake — never slashed — is returned rather than stranded by the prior
    // `!anyRefunded` guard. Provider: -20 stake +70 m1 +20 stake back = 1070, held 0.
    expect(last.kind === 'state' && last.record.state).toBe('resolved')
    const payee = await h.module.walletQuery.balances(PAYEE)
    expect(payee[0]?.held.amount).toBe('0')
    expect(payee[0]?.available.amount).toBe('1070')
    // Payer paid 70 for m1, got 50 back on m2 refund → 930.
    expect((await h.module.valueTransfer.balanceOf(PAYER, 'USDC')).amount).toBe('930')
  })
})
