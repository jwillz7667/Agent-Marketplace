import { describe, it, expect, beforeEach } from 'vitest'
import { FixedClock } from '../../shared/time/clock'
import { generateKeyPair, verifyDetached, canonicalize, sha256Tagged, type KeyPair } from '../../shared/crypto/index'
import { stripForSigning } from '../../domain/index'
import { buildRegistry, type RegistryModule } from './index'
import {
  FakeIdentity,
  FakeNonces,
  FakeReputation,
  TEST_CONFIG,
  makeCoreSigner,
  makeSnapshot,
  signListing,
  signQuery,
} from './test-helpers'
import type { CoreSigner } from './service'

// Two distinct providers + one requester, each with its own keypair registered in identity.
const PROVIDER_A = 'did:praxis:agent:providerA'
const PROVIDER_B = 'did:praxis:agent:providerB'
const REQUESTER = 'did:praxis:agent:requester'

interface Harness {
  module: RegistryModule
  identity: FakeIdentity
  reputation: FakeReputation
  clock: FixedClock
  coreSigner: CoreSigner
  keysA: KeyPair
  keysB: KeyPair
  keysR: KeyPair
}

const newHarness = async (): Promise<Harness> => {
  const clock = new FixedClock('2026-06-06T15:00:00.000Z')
  const identity = new FakeIdentity()
  const reputation = new FakeReputation()
  const nonces = new FakeNonces()
  const coreSigner = await makeCoreSigner()

  const keysA = await generateKeyPair()
  const keysB = await generateKeyPair()
  const keysR = await generateKeyPair()
  identity.register(PROVIDER_A, keysA.publicKey)
  identity.register(PROVIDER_B, keysB.publicKey)
  identity.register(REQUESTER, keysR.publicKey)
  // The registry's core signer key must resolve so quote/dry-run signatures verify.
  identity.register(coreSigner.did, coreSigner.publicKey)

  const module = buildRegistry({ clock, nonces, identity, reputation, coreSigner, config: TEST_CONFIG })
  return { module, identity, reputation, clock, coreSigner, keysA, keysB, keysR }
}

describe('RegistryService.publishListing', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('publishes a provider-signed listing and assigns a listing_id on create', async () => {
    const listing = await signListing(PROVIDER_A, h.keysA)

    const stored = await h.module.registryService.publishListing(listing)

    expect(stored.listing_id).toMatch(/^lst_/)
    expect(stored.provider).toBe(PROVIDER_A)
    expect(stored.version).toBe('3.2.0')
    const fetched = await h.module.registryService.getListing(stored.listing_id)
    expect(fetched.listing_id).toBe(stored.listing_id)
  })

  it('rejects a listing whose provenance signature does not verify', async () => {
    const listing = await signListing(PROVIDER_A, h.keysA)
    // Tamper with a signed field after signing.
    const tampered = { ...listing, pricing: { ...listing.pricing, amount: '0.001' } }

    await expect(h.module.registryService.publishListing(tampered)).rejects.toThrow(/signature verification failed/)
  })

  it('404s on an update for an unknown listing_id', async () => {
    const listing = await signListing(PROVIDER_A, h.keysA, { listing_id: 'lst_DOESNOTEXIST' })

    await expect(h.module.registryService.publishListing(listing)).rejects.toThrow(/not found for update/)
  })

  it('rejects an already-expired listing', async () => {
    const listing = await signListing(PROVIDER_A, h.keysA, { expires: '2026-01-01T00:00:00Z' })

    await expect(h.module.registryService.publishListing(listing)).rejects.toThrow(/already expired/)
  })
})

describe('RegistryService.query — stage 1 hard filter', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
    h.reputation.setSnapshot(PROVIDER_A, makeSnapshot(PROVIDER_A, { trust: 0.95, jobs: 18000 }))
    h.reputation.setSnapshot(PROVIDER_B, makeSnapshot(PROVIDER_B, { trust: 0.6, jobs: 10 }))
  })

  it('removes a listing priced over the ceiling (not down-ranked)', async () => {
    await h.module.registryService.publishListing(await signListing(PROVIDER_A, h.keysA, { priceAmount: '0.02' }))
    await h.module.registryService.publishListing(await signListing(PROVIDER_B, h.keysB, { priceAmount: '0.50' }))

    const q = await signQuery(REQUESTER, h.keysR, { priceCeiling: '0.05' })
    const { matches } = await h.module.registryService.query(q)

    expect(matches.map((m) => m.provider)).toEqual([PROVIDER_A])
  })

  it('removes a provider below min_trust', async () => {
    await h.module.registryService.publishListing(await signListing(PROVIDER_A, h.keysA))
    await h.module.registryService.publishListing(await signListing(PROVIDER_B, h.keysB))

    const q = await signQuery(REQUESTER, h.keysR, { minTrust: 0.82 })
    const { matches } = await h.module.registryService.query(q)

    expect(matches.map((m) => m.provider)).toEqual([PROVIDER_A])
  })

  it('removes a provider below min_completed_jobs', async () => {
    await h.module.registryService.publishListing(await signListing(PROVIDER_A, h.keysA))
    await h.module.registryService.publishListing(await signListing(PROVIDER_B, h.keysB))

    const q = await signQuery(REQUESTER, h.keysR, { minJobs: 50 })
    const { matches } = await h.module.registryService.query(q)

    expect(matches.map((m) => m.provider)).toEqual([PROVIDER_A])
  })

  it('removes an inactive (suspended) listing', async () => {
    await h.module.registryService.publishListing(await signListing(PROVIDER_A, h.keysA, { status: 'active' }))
    await h.module.registryService.publishListing(await signListing(PROVIDER_B, h.keysB, { status: 'suspended' }))

    const q = await signQuery(REQUESTER, h.keysR)
    const { matches } = await h.module.registryService.query(q)

    expect(matches.map((m) => m.provider)).toEqual([PROVIDER_A])
  })

  it('removes a listing whose p95 exceeds the latency target', async () => {
    await h.module.registryService.publishListing(await signListing(PROVIDER_A, h.keysA, { p95: 3000 }))
    await h.module.registryService.publishListing(await signListing(PROVIDER_B, h.keysB, { p95: 9000 }))

    const q = await signQuery(REQUESTER, h.keysR, { latencyP95: 4000 })
    const { matches } = await h.module.registryService.query(q)

    expect(matches.map((m) => m.provider)).toEqual([PROVIDER_A])
  })

  it('enforces no-pii-retention compliance against terms.result_retention', async () => {
    await h.module.registryService.publishListing(await signListing(PROVIDER_A, h.keysA, { resultRetention: 'none' }))
    await h.module.registryService.publishListing(await signListing(PROVIDER_B, h.keysB, { resultRetention: '30d' }))

    const q = await signQuery(REQUESTER, h.keysR, { complianceTags: ['no-pii-retention'] })
    const { matches } = await h.module.registryService.query(q)

    expect(matches.map((m) => m.provider)).toEqual([PROVIDER_A])
  })

  it('removes a listing whose declared output schema ref mismatches when must_validate', async () => {
    await h.module.registryService.publishListing(await signListing(PROVIDER_A, h.keysA, { outputRef: 'praxis:schema:table-rows-v2' }))
    await h.module.registryService.publishListing(await signListing(PROVIDER_B, h.keysB, { outputRef: 'praxis:schema:other-v9' }))

    const q = await signQuery(REQUESTER, h.keysR, {
      outputRef: 'praxis:schema:table-rows-v2',
      mustValidate: true,
    })
    const { matches } = await h.module.registryService.query(q)

    expect(matches.map((m) => m.provider)).toEqual([PROVIDER_A])
  })

  it('rejects a query whose signature does not verify', async () => {
    await h.module.registryService.publishListing(await signListing(PROVIDER_A, h.keysA))
    const q = await signQuery(REQUESTER, h.keysR)
    const tampered = { ...q, max_results: 99 } // changed a signed field

    await expect(h.module.registryService.query(tampered)).rejects.toThrow()
  })

  it('rejects a replayed nonce', async () => {
    await h.module.registryService.publishListing(await signListing(PROVIDER_A, h.keysA))
    const q = await signQuery(REQUESTER, h.keysR, { nonce: 'fixed-nonce' })

    await h.module.registryService.query(q)
    await expect(h.module.registryService.query(q)).rejects.toThrow(/replay|nonce/i)
  })
})

describe('RegistryService.query — stage 2 ranking', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('orders survivors by weighted signals and attaches a match_explanation to each', async () => {
    // A: cheaper, faster, higher trust. B: pricier, slower, lower trust. A must outrank B.
    h.reputation.setSnapshot(PROVIDER_A, makeSnapshot(PROVIDER_A, { trust: 0.97, jobs: 18000 }))
    h.reputation.setSnapshot(PROVIDER_B, makeSnapshot(PROVIDER_B, { trust: 0.84, jobs: 18000 }))
    await h.module.registryService.publishListing(await signListing(PROVIDER_A, h.keysA, { priceAmount: '0.01', p95: 1000 }))
    await h.module.registryService.publishListing(await signListing(PROVIDER_B, h.keysB, { priceAmount: '0.04', p95: 3800 }))

    const q = await signQuery(REQUESTER, h.keysR, { priceCeiling: '0.05', latencyP95: 4000, minTrust: 0.8 })
    const { matches } = await h.module.registryService.query(q)

    expect(matches.length).toBe(2)
    expect(matches[0]!.provider).toBe(PROVIDER_A)
    expect(matches[1]!.provider).toBe(PROVIDER_B)
    expect(matches[0]!.match_explanation.score).toBeGreaterThan(matches[1]!.match_explanation.score)
    for (const m of matches) {
      expect(m.match_explanation.listing_id).toBe(m.listing_id)
      expect(m.match_explanation.signals).toHaveProperty('schema_match')
      expect(m.match_explanation.signals).toHaveProperty('price_headroom')
      expect(m.match_explanation.signals).toHaveProperty('trust')
      expect(m.match_explanation.signals).toHaveProperty('stake')
      expect(m.match_explanation.notes.length).toBeGreaterThan(0)
    }
  })

  it('honors ranking_prefs: heavy price weight flips order toward the cheaper listing', async () => {
    // Equal trust; B is cheaper but slower. With price-dominant weights, the cheaper B wins.
    h.reputation.setSnapshot(PROVIDER_A, makeSnapshot(PROVIDER_A, { trust: 0.9, jobs: 18000 }))
    h.reputation.setSnapshot(PROVIDER_B, makeSnapshot(PROVIDER_B, { trust: 0.9, jobs: 18000 }))
    await h.module.registryService.publishListing(await signListing(PROVIDER_A, h.keysA, { priceAmount: '0.045', p95: 1000 }))
    await h.module.registryService.publishListing(await signListing(PROVIDER_B, h.keysB, { priceAmount: '0.005', p95: 3900 }))

    const q = await signQuery(REQUESTER, h.keysR, {
      priceCeiling: '0.05',
      latencyP95: 4000,
      weights: { weight_price: 1, weight_latency: 0, weight_trust: 0 },
    })
    const { matches } = await h.module.registryService.query(q)

    expect(matches[0]!.provider).toBe(PROVIDER_B)
  })

  it('truncates to max_results', async () => {
    h.reputation.setSnapshot(PROVIDER_A, makeSnapshot(PROVIDER_A, { trust: 0.9, jobs: 18000 }))
    h.reputation.setSnapshot(PROVIDER_B, makeSnapshot(PROVIDER_B, { trust: 0.9, jobs: 18000 }))
    await h.module.registryService.publishListing(await signListing(PROVIDER_A, h.keysA, { priceAmount: '0.01' }))
    await h.module.registryService.publishListing(await signListing(PROVIDER_B, h.keysB, { priceAmount: '0.02' }))

    const q = await signQuery(REQUESTER, h.keysR, { maxResults: 1 })
    const { matches } = await h.module.registryService.query(q)

    expect(matches.length).toBe(1)
  })

  it('measures freshness from the last SETTLED receipt, not provider-bumped provenance.updated (D4)', async () => {
    // Everything tied (trust, jobs, price, latency) so freshness is the sole differentiator.
    //  A: settled 3h ago, but its listing provenance.updated is 35 days stale.
    //  B: NEVER settled (last_settled null), but provenance.updated was bumped 1h ago.
    // Old code read provenance.updated → B would out-rank A. The §2.3-correct signal is settlement
    // recency, so A (real recent activity) must win and B's freshness must be 0.
    h.reputation.setSnapshot(
      PROVIDER_A,
      makeSnapshot(PROVIDER_A, { trust: 0.9, jobs: 18000, lastSettled: '2026-06-06T12:00:00.000Z' }),
    )
    h.reputation.setSnapshot(
      PROVIDER_B,
      makeSnapshot(PROVIDER_B, { trust: 0.9, jobs: 18000, lastSettled: null }),
    )
    await h.module.registryService.publishListing(
      await signListing(PROVIDER_A, h.keysA, { priceAmount: '0.02', updated: '2026-05-02T00:00:00.000Z' }),
    )
    await h.module.registryService.publishListing(
      await signListing(PROVIDER_B, h.keysB, { priceAmount: '0.02', updated: '2026-06-06T14:00:00.000Z' }),
    )

    const q = await signQuery(REQUESTER, h.keysR, { priceCeiling: '0.05' })
    const { matches } = await h.module.registryService.query(q)

    const a = matches.find((m) => m.provider === PROVIDER_A)
    const b = matches.find((m) => m.provider === PROVIDER_B)
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    // Freshness is measured, not advertised: recently-settled A is fresh; never-settled B is 0
    // despite its freshly-bumped provenance.
    expect(a!.match_explanation.signals.freshness).toBeGreaterThan(0.9)
    expect(b!.match_explanation.signals.freshness).toBe(0)
    expect(matches[0]!.provider).toBe(PROVIDER_A)
  })
})

describe('RegistryService.query — bound + signed quotes', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
    h.reputation.setSnapshot(PROVIDER_A, makeSnapshot(PROVIDER_A, { trust: 0.95, jobs: 18000 }))
  })

  it('binds the quote to the listing version, rail, and price and signs it with the core key', async () => {
    const published = await h.module.registryService.publishListing(
      await signListing(PROVIDER_A, h.keysA, { version: '4.1.0', priceAmount: '0.03' }),
    )

    const q = await signQuery(REQUESTER, h.keysR)
    const { matches } = await h.module.registryService.query(q)
    const quote = matches[0]!.quote

    expect(quote.listing_id).toBe(published.listing_id)
    expect(quote.listing_version).toBe('4.1.0')
    expect(quote.price.amount).toBe('0.03')
    expect(quote.rail).toBe('x402-usdc-base') // first declared rail
    expect(quote.requester).toBe(REQUESTER)
    expect(new Date(quote.expires).getTime()).toBeGreaterThan(new Date(quote.issued).getTime())

    // The quote's detached JWS must verify against the registry core public key, over the
    // quote minus its `sig` field (symmetric with how the service signs it).
    const payload = stripForSigning(quote as unknown as Record<string, unknown>, ['sig'])
    const valid = await verifyDetached(payload, quote.sig, h.coreSigner.publicKey)
    expect(valid).toBe(true)
  })
})

describe('RegistryService.dryRun', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('returns a signed dry-run whose checksum recomputes over the canonical output', async () => {
    const published = await h.module.registryService.publishListing(
      await signListing(PROVIDER_A, h.keysA, { sampleResponse: { rows: [{ page: 1, cells: [['a', 'b']] }] } }),
    )

    const result = await h.module.registryService.dryRun(published.listing_id)

    expect(result.listing_id).toBe(published.listing_id)
    expect(result.fixture_ref).toBe('praxis:fixture:tables-canon-01')
    expect(result.output_schema_ref).toBe('praxis:schema:table-rows-v2')
    expect(result.output).toBeTruthy()

    // Caller-side cheap verification (§9.4): recompute checksum + verify the registry sig.
    expect(sha256Tagged(canonicalize(result.output))).toBe(result.checksum)
    const payload = stripForSigning(result as unknown as Record<string, unknown>, ['sig'])
    const valid = await verifyDetached(payload, result.sig, h.coreSigner.publicKey)
    expect(valid).toBe(true)
  })

  it('rejects a dry-run on a listing that does not support it', async () => {
    const published = await h.module.registryService.publishListing(
      await signListing(PROVIDER_A, h.keysA, { dryRunSupported: false }),
    )

    await expect(h.module.registryService.dryRun(published.listing_id)).rejects.toThrow(/does not support dry-run/)
  })

  it('404s on a dry-run for an unknown listing', async () => {
    await expect(h.module.registryService.dryRun('lst_NOPE')).rejects.toThrow(/not found/)
  })
})

describe('RegistryService.query — semantic widen (§2.2)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
    h.reputation.setSnapshot(PROVIDER_A, makeSnapshot(PROVIDER_A, { trust: 0.95, jobs: 18000 }))
    h.reputation.setSnapshot(PROVIDER_B, makeSnapshot(PROVIDER_B, { trust: 0.95, jobs: 18000 }))
  })

  it('adds a description-similar listing whose taxonomy does not exactly match', async () => {
    // A: exact taxonomy match. B: different taxonomy but a near-identical description.
    await h.module.registryService.publishListing(
      await signListing(PROVIDER_A, h.keysA, {
        taxonomy: 'doc.extract.tables',
        description: 'extract tabular data from a scanned pdf into json rows',
      }),
    )
    await h.module.registryService.publishListing(
      await signListing(PROVIDER_B, h.keysB, {
        taxonomy: 'doc.parse.spreadsheet',
        description: 'extract tabular data from a scanned pdf into json rows quickly',
      }),
    )

    // semantic=false: only the exact taxonomy match survives.
    const lexicalOff = await signQuery(REQUESTER, h.keysR, {
      taxonomy: 'doc.extract.tables',
      description: 'extract tabular data from a scanned pdf into json rows',
      semantic: false,
    })
    const exactOnly = await h.module.registryService.query(lexicalOff)
    expect(exactOnly.matches.map((m) => m.provider)).toEqual([PROVIDER_A])

    // semantic=true: the description-similar B is widened into the candidate set too.
    const lexicalOn = await signQuery(REQUESTER, h.keysR, {
      taxonomy: 'doc.extract.tables',
      description: 'extract tabular data from a scanned pdf into json rows',
      semantic: true,
    })
    const widened = await h.module.registryService.query(lexicalOn)
    expect(widened.matches.map((m) => m.provider).sort()).toEqual([PROVIDER_A, PROVIDER_B].sort())
  })

  it('semantic widen never overrides a hard price filter', async () => {
    await h.module.registryService.publishListing(
      await signListing(PROVIDER_A, h.keysA, { taxonomy: 'doc.extract.tables', priceAmount: '0.02' }),
    )
    // B is description-similar but priced over the ceiling — must stay removed despite widen.
    await h.module.registryService.publishListing(
      await signListing(PROVIDER_B, h.keysB, {
        taxonomy: 'doc.parse.spreadsheet',
        description: 'extract tabular data from a scanned pdf into json rows quickly',
        priceAmount: '0.50',
      }),
    )

    const q = await signQuery(REQUESTER, h.keysR, {
      taxonomy: 'doc.extract.tables',
      description: 'extract tabular data from a scanned pdf into json rows',
      semantic: true,
      priceCeiling: '0.05',
    })
    const { matches } = await h.module.registryService.query(q)

    expect(matches.map((m) => m.provider)).toEqual([PROVIDER_A])
  })
})
