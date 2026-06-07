import { beforeEach, describe, expect, it } from 'vitest'
import { stripForSigning } from '../../domain/index'
import {
  didFromPublicKey,
  generateKeyPair,
  pubToB64u,
  signDetached,
  type KeyPair,
} from '../../shared/crypto/index'
import { FixedClock } from '../../shared/time/clock'
import { MemoryNonceStore } from '../../infrastructure/persistence/memory/nonce-store'
import type { Config } from '../../shared/config/index'
import { buildIdentity, signingKid, type IdentityModule } from './index'
import type { PassportInput } from './schema'

const CONFIG: Config = {
  PORT: 8080,
  NODE_ENV: 'test',
  PERSISTENCE: 'memory',
  GOV_API_KEY: 'test',
  LOG_LEVEL: 'silent',
  SIGNATURE_SKEW_MS: 2000,
}

const SEED_ISO = '2026-06-06T15:00:00.000Z'

// Builds the unsigned passport body, signs it with `signer` under kid, returns the full body.
const signPassport = async (
  body: Omit<PassportInput, 'sig'>,
  privateKey: Uint8Array,
  kid: string,
): Promise<PassportInput> => {
  const payload = stripForSigning({ ...body, sig: '' }, ['sig'])
  const sig = await signDetached(payload, privateKey, kid)
  return { ...body, sig }
}

const orgBody = (orgDid: string, orgKey: KeyPair, overrides: Partial<PassportInput> = {}): Omit<PassportInput, 'sig'> => ({
  did: orgDid,
  controller: orgDid, // self-signed bootstrap
  keys: [{ id: '#sign-1', type: 'Ed25519', pub: pubToB64u(orgKey.publicKey) }],
  services: {},
  delegation_ref: null,
  kyc_level: 'enhanced',
  nonce: `n-org-${Math.random().toString(36).slice(2)}`,
  iat: SEED_ISO,
  exp: '2026-06-06T15:05:00.000Z',
  ...overrides,
})

const agentBody = (
  agentDid: string,
  orgDid: string,
  agentKey: KeyPair,
  overrides: Partial<PassportInput> = {},
): Omit<PassportInput, 'sig'> => ({
  did: agentDid,
  controller: orgDid,
  keys: [{ id: '#sign-1', type: 'Ed25519', pub: pubToB64u(agentKey.publicKey) }],
  services: { mailbox: 'praxis:mail/agent' },
  delegation_ref: null,
  kyc_level: 'principal-verified',
  nonce: `n-agent-${Math.random().toString(36).slice(2)}`,
  iat: SEED_ISO,
  exp: '2026-06-06T15:05:00.000Z',
  ...overrides,
})

const validPolicy = () => ({
  spend: {
    per_tx_max: { amount: '1.00', currency: 'USDC' },
    daily_max: { amount: '25.00', currency: 'USDC' },
    total_max: { amount: '500.00', currency: 'USDC' },
  },
  categories_allow: ['doc.*'],
  categories_deny: ['payments.*'],
  counterparties_allow: ['*'],
  counterparties_deny: [],
  require_human_approval_over: { amount: '10.00', currency: 'USDC' },
  messaging: { send: true, max_postage_per_day: '2.00' },
  posting: { offers: true, rfps: true, max_post_spend_per_day: '1.00' },
  escrow: { may_commit: true, max_escrow: { amount: '100.00', currency: 'USDC' } },
  may_stake: true,
})

interface Fixture {
  mod: IdentityModule
  clock: FixedClock
  orgKey: KeyPair
  orgDid: string
  agentKey: KeyPair
  agentDid: string
}

const setup = async (): Promise<Fixture> => {
  const clock = new FixedClock(SEED_ISO)
  const nonces = new MemoryNonceStore(clock)
  const mod = buildIdentity({ clock, nonces, config: CONFIG })

  const orgKey = await generateKeyPair()
  const orgDid = didFromPublicKey(orgKey.publicKey, 'org')
  const agentKey = await generateKeyPair()
  const agentDid = didFromPublicKey(agentKey.publicKey, 'agent')

  return { mod, clock, orgKey, orgDid, agentKey, agentDid }
}

// Registers a self-signed org passport (the bootstrap path) so it can then control agents.
const registerOrg = async (f: Fixture): Promise<void> => {
  const body = await signPassport(orgBody(f.orgDid, f.orgKey), f.orgKey.privateKey, signingKid(f.orgDid, '#sign-1'))
  await f.mod.service.register(body)
}

describe('identity: register', () => {
  let f: Fixture
  beforeEach(async () => {
    f = await setup()
  })

  it('registers a self-signed org passport (bootstrap)', async () => {
    const body = await signPassport(orgBody(f.orgDid, f.orgKey), f.orgKey.privateKey, signingKid(f.orgDid, '#sign-1'))
    await f.mod.service.register(body)

    const resolved = await f.mod.identityResolver.resolvePassport(f.orgDid)
    expect(resolved?.did).toBe(f.orgDid)
    expect(await f.mod.identityResolver.publicKeyFor(f.orgDid)).toEqual(f.orgKey.publicKey)
  })

  it('registers an agent passport signed by its controller principal', async () => {
    await registerOrg(f)
    const body = await signPassport(
      agentBody(f.agentDid, f.orgDid, f.agentKey),
      f.orgKey.privateKey,
      signingKid(f.orgDid, '#sign-1'),
    )
    await f.mod.service.register(body)

    const resolved = await f.mod.identityResolver.resolvePassport(f.agentDid)
    expect(resolved?.controller).toBe(f.orgDid)
  })

  it('rejects an agent passport signed by the wrong (non-controller) key', async () => {
    await registerOrg(f)
    const attacker = await generateKeyPair()
    const body = await signPassport(
      agentBody(f.agentDid, f.orgDid, f.agentKey),
      attacker.privateKey, // wrong key, but claims to be controller-signed
      signingKid(f.orgDid, '#sign-1'),
    )
    await expect(f.mod.service.register(body)).rejects.toMatchObject({ code: 'auth_error' })
  })

  it('rejects when passport.did does not match the DID derived from keys[0].pub', async () => {
    await registerOrg(f)
    const otherKey = await generateKeyPair()
    // Keep the claimed agentDid, but publish a different public key.
    const tampered = agentBody(f.agentDid, f.orgDid, f.agentKey, {
      keys: [{ id: '#sign-1', type: 'Ed25519', pub: pubToB64u(otherKey.publicKey) }],
    })
    const body = await signPassport(tampered, f.orgKey.privateKey, signingKid(f.orgDid, '#sign-1'))
    await expect(f.mod.service.register(body)).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('rejects a tampered body whose signature no longer matches', async () => {
    await registerOrg(f)
    const body = await signPassport(
      agentBody(f.agentDid, f.orgDid, f.agentKey),
      f.orgKey.privateKey,
      signingKid(f.orgDid, '#sign-1'),
    )
    const tampered: PassportInput = { ...body, kyc_level: 'enhanced' }
    await expect(f.mod.service.register(tampered)).rejects.toMatchObject({ code: 'auth_error' })
  })

  it('rejects registering an agent whose controller is unknown', async () => {
    const body = await signPassport(
      agentBody(f.agentDid, f.orgDid, f.agentKey),
      f.orgKey.privateKey,
      signingKid(f.orgDid, '#sign-1'),
    )
    await expect(f.mod.service.register(body)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('rejects a self-signed agent passport (must be controller-signed)', async () => {
    const body = await signPassport(
      agentBody(f.agentDid, f.agentDid, f.agentKey),
      f.agentKey.privateKey,
      signingKid(f.agentDid, '#sign-1'),
    )
    await expect(f.mod.service.register(body)).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('rejects a replayed nonce', async () => {
    const body = await signPassport(orgBody(f.orgDid, f.orgKey), f.orgKey.privateKey, signingKid(f.orgDid, '#sign-1'))
    await f.mod.service.register(body)
    // A different org reusing the same nonce should be rejected as a replay.
    const org2 = await generateKeyPair()
    const org2Did = didFromPublicKey(org2.publicKey, 'org')
    const body2base = orgBody(org2Did, org2, { nonce: body.nonce })
    const body2 = await signPassport(body2base, org2.privateKey, signingKid(org2Did, '#sign-1'))
    await expect(f.mod.service.register(body2)).rejects.toMatchObject({ code: 'replay_detected' })
  })

  it('rejects an expired passport', async () => {
    const expired = orgBody(f.orgDid, f.orgKey, { exp: '2026-06-06T14:00:00.000Z' })
    const body = await signPassport(expired, f.orgKey.privateKey, signingKid(f.orgDid, '#sign-1'))
    await expect(f.mod.service.register(body)).rejects.toMatchObject({ code: 'auth_error' })
  })

  it('rejects a duplicate registration', async () => {
    await registerOrg(f)
    const body = await signPassport(
      orgBody(f.orgDid, f.orgKey, { nonce: 'n-dup' }),
      f.orgKey.privateKey,
      signingKid(f.orgDid, '#sign-1'),
    )
    await expect(f.mod.service.register(body)).rejects.toMatchObject({ code: 'conflict' })
  })
})

describe('identity: rotate', () => {
  let f: Fixture
  beforeEach(async () => {
    f = await setup()
    await registerOrg(f)
    const body = await signPassport(
      agentBody(f.agentDid, f.orgDid, f.agentKey),
      f.orgKey.privateKey,
      signingKid(f.orgDid, '#sign-1'),
    )
    await f.mod.service.register(body)
  })

  it('appends a new key, deprecates the old, controller-signed', async () => {
    const newKey = await generateKeyPair()
    const base = {
      new_key: { id: '#sign-2', type: 'Ed25519' as const, pub: pubToB64u(newKey.publicKey) },
      deprecate_key_id: '#sign-1',
      nonce: 'n-rot-1',
      iat: SEED_ISO,
      exp: '2026-06-06T15:05:00.000Z',
    }
    const sig = await signDetached(stripForSigning({ ...base, sig: '' }, ['sig']), f.orgKey.privateKey, signingKid(f.orgDid, '#sign-1'))

    const result = await f.mod.service.rotate(f.agentDid, { ...base, sig })
    expect(result.deprecatedKeyId).toBe('#sign-1')

    const resolved = await f.mod.identityResolver.resolvePassport(f.agentDid)
    expect(resolved?.keys.map((k) => k.id)).toEqual(['#sign-2'])
    // publicKeyFor now returns the new key (first remaining).
    expect(await f.mod.identityResolver.publicKeyFor(f.agentDid)).toEqual(newKey.publicKey)
  })

  it('rejects rotation signed by a non-controller', async () => {
    const newKey = await generateKeyPair()
    const attacker = await generateKeyPair()
    const base = {
      new_key: { id: '#sign-2', type: 'Ed25519' as const, pub: pubToB64u(newKey.publicKey) },
      deprecate_key_id: '#sign-1',
      nonce: 'n-rot-2',
      iat: SEED_ISO,
      exp: '2026-06-06T15:05:00.000Z',
    }
    const sig = await signDetached(stripForSigning({ ...base, sig: '' }, ['sig']), attacker.privateKey, signingKid(f.orgDid, '#sign-1'))
    await expect(f.mod.service.rotate(f.agentDid, { ...base, sig })).rejects.toMatchObject({ code: 'auth_error' })
  })
})

describe('identity: revoke (kill switch)', () => {
  let f: Fixture
  beforeEach(async () => {
    f = await setup()
    await registerOrg(f)
    const body = await signPassport(
      agentBody(f.agentDid, f.orgDid, f.agentKey),
      f.orgKey.privateKey,
      signingKid(f.orgDid, '#sign-1'),
    )
    await f.mod.service.register(body)
  })

  it('flips isRevoked to true and nulls activeDelegation, immediately', async () => {
    await f.mod.delegationAdmin.issue({
      issuer: f.orgDid,
      subject: f.agentDid,
      policy: validPolicy(),
      expires: '2026-07-01T00:00:00.000Z',
    })
    expect(await f.mod.identityResolver.isRevoked(f.agentDid)).toBe(false)
    expect(await f.mod.identityResolver.activeDelegation(f.agentDid)).not.toBeNull()

    const base = { reason: 'compromised', nonce: 'n-rev-1', iat: SEED_ISO, exp: '2026-06-06T15:05:00.000Z' }
    const sig = await signDetached(stripForSigning({ ...base, sig: '' }, ['sig']), f.orgKey.privateKey, signingKid(f.orgDid, '#sign-1'))

    await f.mod.service.revoke(f.agentDid, { ...base, sig })

    expect(await f.mod.identityResolver.isRevoked(f.agentDid)).toBe(true)
    expect(await f.mod.identityResolver.activeDelegation(f.agentDid)).toBeNull()
  })

  it('rejects revocation not signed by the controller', async () => {
    const attacker = await generateKeyPair()
    const base = { nonce: 'n-rev-2', iat: SEED_ISO, exp: '2026-06-06T15:05:00.000Z' }
    const sig = await signDetached(stripForSigning({ ...base, sig: '' }, ['sig']), attacker.privateKey, signingKid(f.orgDid, '#sign-1'))
    await expect(f.mod.service.revoke(f.agentDid, { ...base, sig })).rejects.toMatchObject({ code: 'auth_error' })
    expect(await f.mod.identityResolver.isRevoked(f.agentDid)).toBe(false)
  })

  it('nulls activeDelegation once the delegation expires, without any revocation (C6)', async () => {
    await f.mod.delegationAdmin.issue({
      issuer: f.orgDid,
      subject: f.agentDid,
      policy: validPolicy(),
      expires: '2026-07-01T00:00:00.000Z',
    })
    expect(await f.mod.identityResolver.activeDelegation(f.agentDid)).not.toBeNull()

    // Advance the clock past expiry. The delegation is still un-revoked, but no longer "active":
    // board posting / mailroom messaging authorize off activeDelegation and must now fail closed.
    f.clock.set('2026-07-02T00:00:00.000Z')

    expect(await f.mod.identityResolver.isRevoked(f.agentDid)).toBe(false)
    expect(await f.mod.identityResolver.activeDelegation(f.agentDid)).toBeNull()
  })
})

describe('identity: delegation admin', () => {
  let f: Fixture
  beforeEach(async () => {
    f = await setup()
    await registerOrg(f)
    const body = await signPassport(
      agentBody(f.agentDid, f.orgDid, f.agentKey),
      f.orgKey.privateKey,
      signingKid(f.orgDid, '#sign-1'),
    )
    await f.mod.service.register(body)
  })

  it('issues a delegation, signed by the issuer when its key is in the keystore', async () => {
    // Seed the org's signing key so the admin can sign on the issuer's behalf.
    await f.mod.admin.seedSigningKey(signingKid(f.orgDid, '#sign-1'), f.orgKey.privateKey)
    const cred = await f.mod.delegationAdmin.issue({
      issuer: f.orgDid,
      subject: f.agentDid,
      policy: validPolicy(),
      expires: '2026-07-01T00:00:00.000Z',
    })
    expect(cred.subject).toBe(f.agentDid)
    expect(cred.issuer).toBe(f.orgDid)
    expect(cred.sig.length).toBeGreaterThan(0)
  })

  it('issues with empty sig when the issuer key is not held (admin-plane path)', async () => {
    const cred = await f.mod.delegationAdmin.issue({
      issuer: f.orgDid,
      subject: f.agentDid,
      policy: validPolicy(),
      expires: '2026-07-01T00:00:00.000Z',
    })
    expect(cred.sig).toBe('')
  })

  it('rejects an invalid policy shape', async () => {
    await expect(
      f.mod.delegationAdmin.issue({
        issuer: f.orgDid,
        subject: f.agentDid,
        policy: { spend: { per_tx_max: { amount: '1.00' } } }, // missing required fields
        expires: '2026-07-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('updates a delegation by re-issuing with a new policy', async () => {
    await f.mod.delegationAdmin.issue({
      issuer: f.orgDid,
      subject: f.agentDid,
      policy: validPolicy(),
      expires: '2026-07-01T00:00:00.000Z',
    })
    const next = validPolicy()
    const updatedPolicy = { ...next, may_stake: false }
    const updated = await f.mod.delegationAdmin.update(f.agentDid, updatedPolicy)
    expect(updated.policy.may_stake).toBe(false)
  })

  it('lists agents by controlling principal with their delegation', async () => {
    await f.mod.delegationAdmin.issue({
      issuer: f.orgDid,
      subject: f.agentDid,
      policy: validPolicy(),
      expires: '2026-07-01T00:00:00.000Z',
    })
    const entries = await f.mod.delegationAdmin.listByPrincipal(f.orgDid)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.did).toBe(f.agentDid)
    expect(entries[0]?.delegation?.subject).toBe(f.agentDid)
  })
})

describe('identity: admin seedCoreIdentity', () => {
  it('makes a core DID resolvable and signable under its kid', async () => {
    const clock = new FixedClock(SEED_ISO)
    const nonces = new MemoryNonceStore(clock)
    const mod = buildIdentity({ clock, nonces, config: CONFIG })

    const key = await generateKeyPair()
    const did = didFromPublicKey(key.publicKey, 'core')
    const kid = signingKid(did, '#sign-1')
    await mod.admin.seedCoreIdentity({
      did,
      kid,
      privateKey: key.privateKey,
      publicKey: key.publicKey,
      controller: did,
    })

    expect(await mod.identityResolver.publicKeyFor(did)).toEqual(key.publicKey)
    expect(await mod.keystore.getSigningKey(kid)).toEqual(key.privateKey)
    const passport = await mod.identityResolver.resolvePassport(did)
    expect(passport?.keys[0]?.id).toBe('#sign-1')
  })
})
