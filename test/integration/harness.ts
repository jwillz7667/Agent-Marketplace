import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { loadConfig, type Config } from '../../src/shared/config/index'
import { buildContainer, type Container } from '../../src/container'
import { buildApp } from '../../src/app'
import {
  generateKeyPair,
  didFromPublicKey,
  pubToB64u,
  signDetached,
  type DidRole,
  type KeyPair,
} from '../../src/shared/crypto/index'
import { signingKid } from '../../src/core/identity/index'
import type { DelegationCredential, DelegationPolicy, Money } from '../../src/domain/index'

// End-to-end integration harness. Boots the SAME composition root + Fastify app the production
// process uses (real SystemClock, in-memory persistence), and drives it over HTTP via app.inject.
// The container surfaces are used ONLY for test SETUP (seeding identities/keys/delegations,
// funding wallets) and for white-box ASSERTIONS (balances, ledger.verifyChain, reputation) —
// never to bypass a flow the test is meant to exercise through HTTP.

export interface Harness {
  readonly app: FastifyInstance
  readonly container: Container
  readonly config: Config
  close(): Promise<void>
}

// In production the app uses the real SystemClock, so every signed object must be freshly
// timestamped. iat = now, exp = now + 60s keeps each object inside SIGNATURE_SKEW_MS + TTL.
const FRESH_TTL_MS = 60_000

export const nowIso = (): string => new Date().toISOString()
export const futureIso = (ms = FRESH_TTL_MS): string => new Date(Date.now() + ms).toISOString()
// Far-future expiry for credentials/listings that must outlive the test run.
export const farFutureIso = (): string => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()

// A unique, single-use nonce per signed object (nonces are consumed exactly once server-side).
export const freshNonce = (): string => randomBytes(16).toString('hex')

export const buildHarness = async (overrides: Partial<NodeJS.ProcessEnv> = {}): Promise<Harness> => {
  const config = loadConfig({
    GOV_API_KEY: 'dev-supervisor-key',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PERSISTENCE: 'memory',
    ...overrides,
  })
  const container = await buildContainer(config)
  const app = await buildApp(container)
  await app.ready()
  return {
    app,
    container,
    config,
    async close() {
      await app.close()
    },
  }
}

export interface TestAgent {
  readonly did: string
  readonly kid: string
  readonly keys: KeyPair
  readonly publicKeyB64u: string
}

// Generate a fresh keypair + deterministic DID + signing kid for a role.
export const makeAgent = async (role: DidRole): Promise<TestAgent> => {
  const keys = await generateKeyPair()
  const did = didFromPublicKey(keys.publicKey, role)
  return {
    did,
    kid: signingKid(did, '#sign-1'),
    keys,
    publicKeyB64u: pubToB64u(keys.publicKey),
  }
}

// Attach a detached JWS (over the object minus `sig`) plus the freshness/replay envelope. This is
// the canonical "build a signed object" recipe verifiers expect: sig = signDetached({...payload,
// nonce, iat, exp}). Returns a NEW object so the caller's input is never mutated.
export const signEnvelope = async <T extends Record<string, unknown>>(
  payload: T,
  keys: KeyPair,
  kid: string,
  opts: { nonce?: string; iat?: string; exp?: string } = {},
): Promise<T & { nonce: string; iat: string; exp: string; sig: string }> => {
  const enveloped = {
    ...payload,
    nonce: opts.nonce ?? freshNonce(),
    iat: opts.iat ?? nowIso(),
    exp: opts.exp ?? futureIso(),
  }
  const sig = await signDetached(enveloped, keys.privateKey, kid)
  return { ...enveloped, sig }
}

// Sign an object that already carries its own freshness fields (or needs none, like the quote /
// payment payload whose freshness is `expires` / `iat`). Omits only `sig`, matching the default
// verifier omit list.
export const signDetachedField = async (
  payload: Record<string, unknown>,
  keys: KeyPair,
  kid: string,
): Promise<string> => signDetached(payload, keys.privateKey, kid)

// A generous default delegation policy: high caps, all categories, both counterparties open,
// messaging/posting/escrow/stake all enabled. Tests narrow individual fields via the override.
export const generousPolicy = (override: Partial<DelegationPolicy> = {}): DelegationPolicy => ({
  spend: {
    per_tx_max: { amount: '1000', currency: 'USDC' },
    daily_max: { amount: '10000', currency: 'USDC' },
    total_max: { amount: '100000', currency: 'USDC' },
  },
  categories_allow: ['*'],
  categories_deny: [],
  counterparties_allow: ['*'],
  counterparties_deny: [],
  require_human_approval_over: { amount: '1000000', currency: 'USDC' },
  messaging: { send: true, max_postage_per_day: '100' },
  posting: { offers: true, rfps: true, max_post_spend_per_day: '100' },
  escrow: { may_commit: true, max_escrow: { amount: '100000', currency: 'USDC' } },
  may_stake: true,
  ...override,
})

// Build a DelegationCredential for a subject agent issued by its controller principal. The signer
// (the §4.3 below-the-agent backstop) reads policy from this credential via activeDelegation; it
// does NOT verify the credential's own `sig`, so a seeded credential carries an empty sig
// (out-of-band issuance, mirroring how the container seeds core identities). `expires` must be in
// the future or the signer denies on expiry.
export const makeDelegation = (
  issuerPrincipalDid: string,
  subjectAgentDid: string,
  policy: DelegationPolicy,
): DelegationCredential => ({
  type: ['VerifiableCredential', 'PraxisDelegation'],
  issuer: issuerPrincipalDid,
  subject: subjectAgentDid,
  policy,
  issued: nowIso(),
  expires: farFutureIso(),
  revocation: `https://praxis.test/identity/${subjectAgentDid}/revoke`,
  sig: '',
})

// Register a principal (self-signed org passport) over HTTP, returning the agent handle. A
// principal is the KYC'd human/org root of the delegation chain (§4).
export const registerPrincipal = async (h: Harness): Promise<TestAgent> => {
  const principal = await makeAgent('org')
  const passport = await signEnvelope(
    {
      did: principal.did,
      controller: principal.did, // self-signed bootstrap
      keys: [{ id: '#sign-1', type: 'Ed25519' as const, pub: principal.publicKeyB64u }],
      services: {},
      delegation_ref: null,
      kyc_level: 'enhanced' as const,
    },
    principal.keys,
    principal.kid,
  )
  const res = await h.app.inject({ method: 'POST', url: '/identity/register', payload: passport })
  if (res.statusCode !== 200) {
    throw new Error(`registerPrincipal failed: ${res.statusCode} ${res.body}`)
  }
  return principal
}

export interface ProvisionOpts {
  // Spendable funds to credit the agent's wallet (so it can pay / lock escrow / stake).
  readonly fund?: Money
  // Delegation policy; when provided the agent is given an active delegation + signing key so the
  // below-the-agent signer can act for it.
  readonly policy?: DelegationPolicy
}

// Register an agent passport (signed by its controller principal) over HTTP, then provision it for
// settlement: seed its signing key into the Keystore (so the WalletSigner can sign on its behalf —
// the HTTP register flow never uploads private keys), seed an active delegation, and fund its
// wallet. Returns the agent handle.
export const registerAndProvision = async (
  h: Harness,
  controller: TestAgent,
  opts: ProvisionOpts = {},
): Promise<TestAgent> => {
  const agent = await makeAgent('agent')

  const passport = await signEnvelope(
    {
      did: agent.did,
      controller: controller.did,
      keys: [{ id: '#sign-1', type: 'Ed25519' as const, pub: agent.publicKeyB64u }],
      services: {},
      delegation_ref: null,
      kyc_level: 'principal-verified' as const,
    },
    controller.keys, // an agent passport is signed by its controller principal
    controller.kid,
  )
  const res = await h.app.inject({ method: 'POST', url: '/identity/register', payload: passport })
  if (res.statusCode !== 200) {
    throw new Error(`registerAndProvision failed for ${agent.did}: ${res.statusCode} ${res.body}`)
  }

  // The WalletSigner fetches the agent private key from the Keystore under `${did}#sign-1`. The
  // HTTP flow does not upload it, so seed it here — this models the agent entrusting its key to the
  // policy-enforcing MPC/TEE signer service (§4.3).
  await h.container.identity.admin.seedSigningKey(agent.kid, agent.keys.privateKey)

  if (opts.policy) {
    await h.container.identity.admin.seedDelegation(
      agent.did,
      makeDelegation(controller.did, agent.did, opts.policy),
    )
  }
  if (opts.fund) {
    await h.container.settlement.faucet(agent.did, opts.fund)
  }

  return agent
}

export interface ListingOpts {
  readonly provider: TestAgent
  readonly rail: string // 'dev' | 'x402'
  readonly priceAmount: string
  readonly currency?: string
  readonly taxonomy?: string
  readonly acceptanceType?: 'schema' | 'checksum' | 'schema+checksum' | 'oracle'
  readonly acceptanceExpected?: string
  readonly stakeAmount?: string
}

// Build a §3 listing, sign provenance with the provider's key (over the listing minus
// provenance.sig, matching the registry's verification), publish it over HTTP, and return its
// assigned listing_id. The rail MUST be one the rail registry knows ('dev'|'x402') so the
// facilitator/escrow can resolve it.
export const publishListing = async (h: Harness, opts: ListingOpts): Promise<string> => {
  const currency = opts.currency ?? 'USDC'
  const acceptance: { type: string; expected?: string } = { type: opts.acceptanceType ?? 'schema+checksum' }
  if (opts.acceptanceExpected !== undefined) acceptance.expected = opts.acceptanceExpected

  // The draft is exactly what the provider signs (no listing_id on create — the registry assigns
  // it after the signature checks out).
  const draft = {
    schema_version: 'praxis.listing/1.0',
    provider: opts.provider.did,
    version: '1.0.0',
    status: 'active' as const,
    capability: {
      taxonomy: opts.taxonomy ?? 'doc.extract.tables',
      title: 'PDF table extraction',
      description: 'Extract tables from PDF to typed JSON rows.',
      tags: ['ocr', 'pdf', 'tabular'],
    },
    io: {
      input_schema: { $ref: 'praxis:schema:pdf-bytes-v1' },
      output_schema: { $ref: 'praxis:schema:table-rows-v2' },
      limits: { max_input_bytes: 26214400, max_pages: 100 },
    },
    pricing: {
      model: 'per_call' as const,
      unit: 'call',
      amount: opts.priceAmount,
      currency,
      quote_required: true,
      rails: [opts.rail],
    },
    sla: {
      latency_ms: { p50: 900, p95: 3200 },
      uptime_target: 0.995,
      max_timeout_ms: 8000,
      throughput_rps: 25,
    },
    auth: { scheme: 'did-jws' as const, audience: opts.provider.did, required_claims: [] },
    endpoint: {
      protocol: 'praxis-call/1.0',
      url: 'https://api.provider.example/v1/extract',
      method: 'POST',
      mcp_tool: 'extract_tables',
    },
    dry_run: {
      supported: true,
      price: '0.0000',
      fixture_ref: 'praxis:fixture:tables-canon-01',
      returns: 'signed-result+checksum' as const,
    },
    terms: {
      refund_policy: 'auto-refund-on-schema-fail',
      dispute_window_ms: 86400000,
      result_retention: 'none',
      acceptance,
    },
    attestations: {
      reputation_snapshot_ref: null,
      stake: { amount: opts.stakeAmount ?? '250.00', currency, slashable: true },
    },
    sample: {
      request: { pdf_b64: 'JVBERi0xLj' },
      response: { rows: [{ page: 1, table: 1, cells: [['Q1', 'Q2']] }] },
    },
    provenance: {
      created: nowIso(),
      updated: nowIso(),
      expires: farFutureIso(),
    },
  }

  const sig = await signDetached(draft, opts.provider.keys.privateKey, opts.provider.kid)
  const payload = { ...draft, provenance: { ...draft.provenance, sig } }

  const res = await h.app.inject({ method: 'POST', url: '/registry/listings', payload })
  if (res.statusCode !== 200) throw new Error(`publishListing failed: ${res.statusCode} ${res.body}`)
  return (res.json() as { listing_id: string }).listing_id
}

// White-box helper: the available (spendable) balance for a DID in a currency, read straight from
// the wallet query port. Used only for assertions, never to move value.
export const availableBalance = async (h: Harness, did: string, currency = 'USDC'): Promise<string> => {
  const rows = await h.container.settlement.walletQuery.balances(did)
  const row = rows.find((r) => r.currency === currency)
  return row?.available.amount ?? '0'
}

export const heldBalance = async (h: Harness, did: string, currency = 'USDC'): Promise<string> => {
  const rows = await h.container.settlement.walletQuery.balances(did)
  const row = rows.find((r) => r.currency === currency)
  return row?.held.amount ?? '0'
}
