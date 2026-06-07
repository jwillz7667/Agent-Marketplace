import {
  signDetached,
  generateKeyPair,
  bytesToB64u,
  type KeyPair,
} from '../../shared/crypto/index'
import type {
  CapabilityQuery,
  DelegationCredential,
  Listing,
  Passport,
  Receipt,
  ReputationMetrics,
  ReputationSnapshot,
} from '../../domain/index'
import type { IdentityResolver, NonceStore, ReputationPort } from '../../shared/ports/index'
import type { Config } from '../../shared/config/index'
import type { CoreSigner } from './service'
import type { ListingPublishInput } from './schema'

// Test fakes for the consumed ports. These are deliberately minimal: just enough of each
// port's contract for the registry to verify signatures, resolve reputation, and dedupe nonces.

export const TEST_CONFIG: Config = {
  PORT: 8080,
  NODE_ENV: 'test',
  PERSISTENCE: 'memory',
  GOV_API_KEY: 'test-gov-key',
  LOG_LEVEL: 'silent',
  SIGNATURE_SKEW_MS: 2000,
}

// FakeIdentity resolves Ed25519 public keys by DID. Register a key per DID; verification uses
// the first (and only) key. Unknown DIDs resolve null so verification fails closed.
export class FakeIdentity implements IdentityResolver {
  private readonly keys = new Map<string, Uint8Array>()

  register(did: string, publicKey: Uint8Array): void {
    this.keys.set(did, publicKey)
  }

  async resolvePassport(did: string): Promise<Passport | null> {
    const pub = this.keys.get(did)
    if (!pub) return null
    return {
      did,
      controller: 'did:praxis:org:test',
      keys: [{ id: '#sign-1', type: 'Ed25519', pub: bytesToB64u(pub) }],
      services: {},
      delegation_ref: null,
      kyc_level: 'principal-verified',
      sig: 'test',
    }
  }

  async publicKeyFor(did: string): Promise<Uint8Array | null> {
    return this.keys.get(did) ?? null
  }

  async activeDelegation(_did: string): Promise<DelegationCredential | null> {
    return null
  }

  async isRevoked(_did: string): Promise<boolean> {
    return false
  }
}

// FakeReputation returns whatever snapshot/raw metrics the test seeds per DID.
export class FakeReputation implements ReputationPort {
  private readonly snapshots = new Map<string, ReputationSnapshot>()
  private readonly raw = new Map<string, ReputationMetrics>()

  setSnapshot(did: string, snapshot: ReputationSnapshot): void {
    this.snapshots.set(did, snapshot)
  }

  setRaw(did: string, metrics: ReputationMetrics): void {
    this.raw.set(did, metrics)
  }

  async getSnapshot(did: string): Promise<ReputationSnapshot | null> {
    return this.snapshots.get(did) ?? null
  }

  async getRaw(did: string): Promise<ReputationMetrics | null> {
    return this.raw.get(did) ?? null
  }

  async ingestReceipt(_receipt: Receipt): Promise<void> {}
  async ingestSignal(_did: string, _kind: string, _weight: number): Promise<void> {}
}

// FakeNonces: single-use, no expiry pruning needed for a deterministic test clock.
export class FakeNonces implements NonceStore {
  private readonly seen = new Set<string>()
  async checkAndConsume(nonce: string): Promise<boolean> {
    if (this.seen.has(nonce)) return false
    this.seen.add(nonce)
    return true
  }
}

export const makeCoreSigner = async (): Promise<CoreSigner> => {
  const kp = await generateKeyPair()
  return {
    did: 'did:praxis:core:registry',
    kid: 'registry#sign-1',
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
  }
}

export interface SnapshotOpts {
  readonly trust: number
  readonly jobs: number
  // Override the metrics.last_settled timestamp (RFC 3339) the freshness signal reads. null models a
  // provider that has registered/posted but never settled a receipt.
  readonly lastSettled?: string | null
}

export const makeSnapshot = (subject: string, opts: SnapshotOpts): ReputationSnapshot => ({
  snapshot_id: `rep_${subject}`,
  subject,
  window: '30d',
  metrics: {
    success_rate: 0.99,
    dispute_rate: 0.004,
    refund_rate: 0.006,
    latency_ms: { p50: 870, p95: 3100 },
    uptime: 0.997,
    jobs: opts.jobs,
    settled_value: '421.55',
    stake: '250.00',
    first_seen: '2025-12-02T00:00:00Z',
    last_settled: opts.lastSettled === undefined ? '2026-06-05T00:00:00Z' : opts.lastSettled,
    counterparty_diversity: 0.9,
    spam_flags: 0,
    post_flags: 0,
  },
  trust: opts.trust,
  issued: '2026-06-06T00:00:00Z',
  expires: '2026-06-07T00:00:00Z',
  issuer: 'did:praxis:core:reputation',
  sig: 'test',
})

// Build a fully-formed §3 listing and sign provenance with the provider's key. Overrides let
// each test tweak one field (price, latency, status, taxonomy, description, stake, sample, …).
export interface ListingOverrides {
  listing_id?: string
  provider?: string
  version?: string
  status?: Listing['status']
  taxonomy?: string
  description?: string
  inputRef?: string
  outputRef?: string
  priceAmount?: string
  currency?: string
  rails?: string[]
  p50?: number
  p95?: number
  resultRetention?: string
  stakeAmount?: string
  stakeSlashable?: boolean
  updated?: string
  expires?: string
  dryRunSupported?: boolean
  sampleResponse?: unknown
}

type UnsignedListing = Omit<Listing, 'provenance' | 'listing_id'> & {
  listing_id?: string
  provenance: { created: string; updated: string; expires: string }
}

const baseListing = (provider: string, o: ListingOverrides): UnsignedListing => ({
  // listing_id is included ONLY when the test supplies one (the update case). On create the
  // provider signs an object without listing_id; the registry assigns the id after verifying.
  ...(o.listing_id !== undefined ? { listing_id: o.listing_id } : {}),
  schema_version: 'praxis.listing/1.0',
  provider,
  version: o.version ?? '3.2.0',
  status: o.status ?? 'active',
  capability: {
    taxonomy: o.taxonomy ?? 'doc.extract.tables',
    title: 'PDF table extraction',
    description: o.description ?? 'Extract tables from PDF (scanned or digital) to typed JSON rows.',
    tags: ['ocr', 'pdf', 'tabular'],
  },
  io: {
    input_schema: { $ref: o.inputRef ?? 'praxis:schema:pdf-bytes-v1' },
    output_schema: { $ref: o.outputRef ?? 'praxis:schema:table-rows-v2' },
    limits: { max_input_bytes: 26214400, max_pages: 100 },
  },
  pricing: {
    model: 'per_call',
    unit: 'call',
    amount: o.priceAmount ?? '0.02',
    currency: o.currency ?? 'USDC',
    quote_required: true,
    rails: o.rails ?? ['x402-usdc-base', 'ap2-card'],
  },
  sla: {
    latency_ms: { p50: o.p50 ?? 900, p95: o.p95 ?? 3200 },
    uptime_target: 0.995,
    max_timeout_ms: 8000,
    throughput_rps: 25,
  },
  auth: { scheme: 'did-jws', audience: provider, required_claims: [] },
  endpoint: {
    protocol: 'praxis-call/1.0',
    url: 'https://api.provider.example/v3/extract',
    method: 'POST',
    mcp_tool: 'extract_tables',
  },
  dry_run: {
    supported: o.dryRunSupported ?? true,
    price: '0.0000',
    fixture_ref: 'praxis:fixture:tables-canon-01',
    returns: 'signed-result+checksum',
  },
  terms: {
    refund_policy: 'auto-refund-on-schema-fail',
    dispute_window_ms: 86400000,
    result_retention: o.resultRetention ?? 'none',
    acceptance: { type: 'schema+checksum' },
  },
  attestations: {
    reputation_snapshot_ref: 'rep_seed',
    stake: { amount: o.stakeAmount ?? '250.00', currency: 'USDC', slashable: o.stakeSlashable ?? true },
  },
  sample:
    o.sampleResponse !== undefined
      ? { request: { pdf_b64: 'JVBERi0xLj' }, response: o.sampleResponse }
      : { request: { pdf_b64: 'JVBERi0xLj' }, response: { rows: [{ page: 1, table: 1, cells: [['Q1', 'Q2']] }] } },
  provenance: {
    created: '2026-05-01T10:00:00Z',
    updated: o.updated ?? '2026-06-02T09:00:00Z',
    expires: o.expires ?? '2026-09-02T09:00:00Z',
  },
})

// Returns a publish-ready listing object whose provenance.sig is a valid provider signature
// over the listing minus provenance.sig (matching the service's verification). The shape is
// the §3 publish input: listing_id is present only when the test is exercising an update.
export const signListing = async (
  provider: string,
  providerKeys: KeyPair,
  o: ListingOverrides = {},
): Promise<ListingPublishInput> => {
  const draft = baseListing(provider, o)
  const sig = await signDetached(draft, providerKeys.privateKey, `${provider}#sign-1`)
  return { ...draft, provenance: { ...draft.provenance, sig } } as ListingPublishInput
}

export interface QueryOverrides {
  requester?: string
  taxonomy?: string
  description?: string
  semantic?: boolean
  inputRef?: string
  outputRef?: string
  mustValidate?: boolean
  priceCeiling?: string
  latencyP95?: number
  minTrust?: number
  minJobs?: number
  complianceTags?: string[]
  weights?: CapabilityQuery['ranking_prefs']
  maxResults?: number
  iat?: string
  exp?: string
  nonce?: string
}

// Build + sign a §2.1 CapabilityQuery with the requester's key, omitting only `sig` (matching
// verifySignedObject's default omit list).
export const signQuery = async (
  requester: string,
  requesterKeys: KeyPair,
  o: QueryOverrides = {},
): Promise<CapabilityQuery> => {
  const draft = {
    query_id: 'q_TEST',
    requester,
    capability: {
      taxonomy: o.taxonomy ?? 'doc.extract.tables',
      ...(o.description !== undefined ? { description: o.description } : {}),
      ...(o.semantic !== undefined ? { semantic: o.semantic } : {}),
    },
    io_requirements: {
      ...(o.inputRef !== undefined ? { input_schema_ref: o.inputRef } : {}),
      ...(o.outputRef !== undefined ? { output_schema_ref: o.outputRef } : {}),
      ...(o.mustValidate !== undefined ? { must_validate: o.mustValidate } : {}),
    },
    constraints: {
      ...(o.priceCeiling !== undefined ? { price_ceiling: { amount: o.priceCeiling, currency: 'USDC', per: 'call' } } : {}),
      ...(o.latencyP95 !== undefined ? { latency_target_ms: { p95: o.latencyP95 } } : {}),
      ...(o.minTrust !== undefined ? { min_trust: o.minTrust } : {}),
      ...(o.minJobs !== undefined ? { min_completed_jobs: o.minJobs } : {}),
      ...(o.complianceTags !== undefined ? { compliance_tags: o.complianceTags } : {}),
    },
    ...(o.weights !== undefined ? { ranking_prefs: o.weights } : {}),
    max_results: o.maxResults ?? 5,
    nonce: o.nonce ?? `nonce-${Math.random()}`,
    iat: o.iat ?? '2026-06-06T15:00:00Z',
    exp: o.exp ?? '2026-06-06T15:00:30Z',
  }
  const sig = await signDetached(draft, requesterKeys.privateKey, `${requester}#sign-1`)
  return { ...draft, sig } as CapabilityQuery
}
