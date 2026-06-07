import { describe, it, expect, beforeEach } from 'vitest'
import { generateKeyPair, verifyDetached, pubToB64u } from '../../shared/crypto/index'
import { FixedClock } from '../../shared/time/clock'
import type { PolicyAction } from '../../shared/ports/index'
import { buildPolicy } from './index'
import {
  FakeApprovals,
  FakeIdentity,
  FakeKeystore,
  FakeUsage,
  makeDelegation,
  makePassport,
  makeKeylessPassport,
  noUsage,
  usageOf,
  usd,
  AGENT_DID,
  KID,
} from './_fixtures'

const spendAction = (over: Partial<PolicyAction> = {}): PolicyAction => ({
  kind: 'spend',
  agent: AGENT_DID,
  amount: usd('0.02'),
  category: 'doc.extract.tables',
  ...over,
})

// Wire a signer with a freshly generated, registered key and a resolvable passport.
const wireSigner = async (opts?: {
  revoked?: boolean
  expires?: string
  registerKey?: boolean
  passport?: boolean
  delegation?: ReturnType<typeof makeDelegation> | null
  usage?: ReturnType<typeof noUsage>
}) => {
  const keys = await generateKeyPair()
  const keystore = new FakeKeystore()
  if (opts?.registerKey !== false) await keystore.register(KID, keys.privateKey)

  const identity = new FakeIdentity({
    delegation: opts?.delegation === undefined ? makeDelegation({ expires: opts?.expires }) : opts.delegation,
    revoked: opts?.revoked ?? false,
    passport: opts?.passport === false ? null : makePassport(pubToB64u(keys.publicKey)),
    publicKey: keys.publicKey,
  })
  const usage = new FakeUsage(opts?.usage ?? noUsage())
  const approvals = new FakeApprovals()
  const clock = new FixedClock('2026-06-06T15:00:00.000Z')

  const { signer, policyEvaluator, routes } = buildPolicy({ clock, identity, keystore, usage, approvals })
  return { signer, policyEvaluator, routes, publicKey: keys.publicKey, clock, approvals }
}

describe('WalletSigner — happy path produces a verifiable JWS', () => {
  it('signs an in-policy payload and the signature verifies against the agent public key', async () => {
    const { signer, publicKey } = await wireSigner()
    const payload = { quote_id: 'qt_01J9', amount: usd('0.02'), category: 'doc.extract.tables' }

    const res = await signer.signWithinPolicy({ did: AGENT_DID, payload, action: spendAction() })

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(await verifyDetached(payload, res.sig, publicKey)).toBe(true)
  })

  it('the signature does not verify against a different public key (binding is real)', async () => {
    const { signer } = await wireSigner()
    const other = await generateKeyPair()
    const payload = { quote_id: 'qt_02', amount: usd('0.02') }
    const res = await signer.signWithinPolicy({ did: AGENT_DID, payload, action: spendAction() })
    if (!res.ok) throw new Error('expected ok')
    expect(await verifyDetached(payload, res.sig, other.publicKey)).toBe(false)
  })

  it('the signature does not verify against a tampered payload', async () => {
    const { signer, publicKey } = await wireSigner()
    const payload = { quote_id: 'qt_03', amount: usd('0.02') }
    const res = await signer.signWithinPolicy({ did: AGENT_DID, payload, action: spendAction() })
    if (!res.ok) throw new Error('expected ok')
    expect(await verifyDetached({ ...payload, amount: usd('99.00') }, res.sig, publicKey)).toBe(false)
  })

  it('buildPolicy exposes routes: null (no HTTP surface)', async () => {
    const { routes } = await wireSigner()
    expect(routes).toBeNull()
  })
})

describe('WalletSigner — the §4.3 hard stop refuses out-of-policy signatures', () => {
  it('refuses to sign when no active delegation exists', async () => {
    const { signer } = await wireSigner({ delegation: null })
    const res = await signer.signWithinPolicy({ did: AGENT_DID, payload: {}, action: spendAction() })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.decision.result).toBe('deny')
      if (res.decision.result === 'deny') expect(res.decision.reasons[0]).toContain('no active delegation')
    }
  })

  it('refuses to sign for a revoked / kill-switched agent', async () => {
    const { signer } = await wireSigner({ revoked: true })
    const res = await signer.signWithinPolicy({ did: AGENT_DID, payload: {}, action: spendAction() })
    expect(res.ok).toBe(false)
    if (!res.ok && res.decision.result === 'deny') {
      expect(res.decision.reasons[0]).toContain('revoked / kill-switch')
    }
  })

  it('refuses to sign for an expired delegation (signer owns the clock check)', async () => {
    // Clock seeded at 2026-06-06; delegation already expired the day before.
    const { signer } = await wireSigner({ expires: '2026-06-05T00:00:00Z' })
    const res = await signer.signWithinPolicy({ did: AGENT_DID, payload: {}, action: spendAction() })
    expect(res.ok).toBe(false)
    if (!res.ok && res.decision.result === 'deny') {
      expect(res.decision.reasons[0]).toContain('delegation expired')
    }
  })

  it('refuses to sign when the signing key is missing from the keystore', async () => {
    const { signer } = await wireSigner({ registerKey: false })
    const res = await signer.signWithinPolicy({ did: AGENT_DID, payload: {}, action: spendAction() })
    expect(res.ok).toBe(false)
    if (!res.ok && res.decision.result === 'deny') {
      expect(res.decision.reasons[0]).toContain('no signing key')
    }
  })

  it('refuses to sign when the passport cannot be resolved', async () => {
    const { signer } = await wireSigner({ passport: false })
    const res = await signer.signWithinPolicy({ did: AGENT_DID, payload: {}, action: spendAction() })
    expect(res.ok).toBe(false)
    if (!res.ok && res.decision.result === 'deny') {
      expect(res.decision.reasons[0]).toContain('passport')
    }
  })

  it('refuses to sign when the passport resolves but carries no keys', async () => {
    const keys = await generateKeyPair()
    const keystore = new FakeKeystore()
    await keystore.register(KID, keys.privateKey)
    const identity = new FakeIdentity({
      delegation: makeDelegation(),
      revoked: false,
      passport: makeKeylessPassport(),
      publicKey: keys.publicKey,
    })
    const clock = new FixedClock('2026-06-06T15:00:00.000Z')
    const { signer } = buildPolicy({
      clock,
      identity,
      keystore,
      usage: new FakeUsage(noUsage()),
      approvals: new FakeApprovals(),
    })
    const res = await signer.signWithinPolicy({ did: AGENT_DID, payload: {}, action: spendAction() })
    expect(res.ok).toBe(false)
    if (!res.ok && res.decision.result === 'deny') {
      expect(res.decision.reasons[0]).toContain('no signing key')
    }
  })

  it('independently enforces caps even though no pre-flight check ran (per_tx)', async () => {
    const { signer } = await wireSigner()
    const res = await signer.signWithinPolicy({
      did: AGENT_DID,
      payload: { amount: usd('5.00') },
      action: spendAction({ amount: usd('5.00') }),
    })
    expect(res.ok).toBe(false)
    if (!res.ok && res.decision.result === 'deny') {
      expect(res.decision.reasons[0]).toContain('per_tx_max exceeded')
    }
  })

  it('does not sign when usage pushes the charge over the daily cap', async () => {
    const { signer } = await wireSigner({ usage: usageOf('24.99', '24.99') })
    const res = await signer.signWithinPolicy({
      did: AGENT_DID,
      payload: {},
      action: spendAction({ amount: usd('0.50') }),
    })
    expect(res.ok).toBe(false)
    if (!res.ok && res.decision.result === 'deny') {
      expect(res.decision.reasons[0]).toContain('daily_max exceeded')
    }
  })

  it('propagates needs_approval as ok:false without signing', async () => {
    const deleg = makeDelegation({
      policy: { spend: { per_tx_max: usd('100.00'), daily_max: usd('1000.00'), total_max: usd('100000.00') } },
    })
    const { signer } = await wireSigner({ delegation: deleg })
    const res = await signer.signWithinPolicy({
      did: AGENT_DID,
      payload: {},
      action: spendAction({ amount: usd('50.00') }),
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.decision.result).toBe('needs_approval')
  })

  it('refuses a denied counterparty even on an otherwise-signable message', async () => {
    const { signer } = await wireSigner()
    const res = await signer.signWithinPolicy({
      did: AGENT_DID,
      payload: {},
      action: { kind: 'message', agent: AGENT_DID, counterparty: 'did:praxis:agent:badactor' },
    })
    expect(res.ok).toBe(false)
    if (!res.ok && res.decision.result === 'deny') {
      expect(res.decision.reasons[0]).toContain('counterparty denied')
    }
  })
})

describe('WalletSigner — single-use supervisor approval redemption (C4)', () => {
  // A delegation whose caps clear a $50 spend, so the only gate left is require_human_approval_over.
  const overThresholdDelegation = () =>
    makeDelegation({
      policy: { spend: { per_tx_max: usd('100.00'), daily_max: usd('1000.00'), total_max: usd('100000.00') } },
    })

  it('signs an over-threshold action when a matching approved clearance is presented, and consumes it', async () => {
    const { signer, approvals, publicKey } = await wireSigner({ delegation: overThresholdDelegation() })
    const action = spendAction({ amount: usd('50.00') })
    const approvalId = approvals.seed({ agent: AGENT_DID, action, decision: 'approved' })

    const payload = { quote_id: 'qt_hi', amount: usd('50.00') }
    const res = await signer.signWithinPolicy({ did: AGENT_DID, payload, action, approvalId })

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(await verifyDetached(payload, res.sig, publicKey)).toBe(true)

    const after = await approvals.status(approvalId)
    expect(after?.status).toBe('consumed')
    expect(after?.decision).toBe('approved')
  })

  it('cannot replay a consumed clearance to authorize a second over-threshold signature', async () => {
    const { signer, approvals } = await wireSigner({ delegation: overThresholdDelegation() })
    const action = spendAction({ amount: usd('50.00') })
    const approvalId = approvals.seed({ agent: AGENT_DID, action, decision: 'approved' })

    const first = await signer.signWithinPolicy({ did: AGENT_DID, payload: {}, action, approvalId })
    expect(first.ok).toBe(true)

    // The supervisor cleared ONE action; redeeming the same id again must throw (single-use).
    await expect(
      signer.signWithinPolicy({ did: AGENT_DID, payload: {}, action, approvalId }),
    ).rejects.toThrow(/already consumed/)
  })

  it('declines (without signing) when the presented clearance was denied, and still consumes it', async () => {
    const { signer, approvals } = await wireSigner({ delegation: overThresholdDelegation() })
    const action = spendAction({ amount: usd('50.00') })
    const approvalId = approvals.seed({ agent: AGENT_DID, action, decision: 'denied' })

    const res = await signer.signWithinPolicy({ did: AGENT_DID, payload: {}, action, approvalId })

    expect(res.ok).toBe(false)
    if (!res.ok && res.decision.result === 'deny') {
      expect(res.decision.reasons[0]).toContain('denied')
    }
    expect((await approvals.status(approvalId))?.status).toBe('consumed')
  })

  it('rejects a clearance issued for a different action (amount mismatch) — binding is exact', async () => {
    const { signer, approvals } = await wireSigner({ delegation: overThresholdDelegation() })
    const approvedAction = spendAction({ amount: usd('50.00') })
    const approvalId = approvals.seed({ agent: AGENT_DID, action: approvedAction, decision: 'approved' })

    // Try to spend a DIFFERENT amount under the clearance issued for $50.
    await expect(
      signer.signWithinPolicy({
        did: AGENT_DID,
        payload: {},
        action: spendAction({ amount: usd('75.00') }),
        approvalId,
      }),
    ).rejects.toThrow(/does not authorize this action/)
  })

  it('parks (needs_approval, no signature) when an over-threshold action is presented with no clearance', async () => {
    const { signer } = await wireSigner({ delegation: overThresholdDelegation() })
    const res = await signer.signWithinPolicy({
      did: AGENT_DID,
      payload: {},
      action: spendAction({ amount: usd('50.00') }),
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.decision.result).toBe('needs_approval')
  })
})

describe('WalletSigner — enforcement ordering', () => {
  let now: FixedClock
  beforeEach(() => {
    now = new FixedClock('2026-06-06T15:00:00.000Z')
    expect(now.now()).toBe('2026-06-06T15:00:00.000Z')
  })

  it('checks revocation before expiry (revoked + expired => revoked reason)', async () => {
    const keys = await generateKeyPair()
    const keystore = new FakeKeystore()
    await keystore.register(KID, keys.privateKey)
    const identity = new FakeIdentity({
      delegation: makeDelegation({ expires: '2026-06-05T00:00:00Z' }),
      revoked: true,
      passport: makePassport(pubToB64u(keys.publicKey)),
      publicKey: keys.publicKey,
    })
    const { signer } = buildPolicy({
      clock: now,
      identity,
      keystore,
      usage: new FakeUsage(noUsage()),
      approvals: new FakeApprovals(),
    })
    const res = await signer.signWithinPolicy({ did: AGENT_DID, payload: {}, action: spendAction() })
    expect(res.ok).toBe(false)
    if (!res.ok && res.decision.result === 'deny') {
      expect(res.decision.reasons[0]).toContain('revoked / kill-switch')
    }
  })
})
