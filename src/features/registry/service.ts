import type {
  CapabilityQuery,
  Listing,
  Quote,
  RankedMatch,
  Money,
} from '../../domain/index'
import {
  newListingId,
  newQuoteId,
  stripForSigning,
  computeTrust,
  emptyMetrics,
} from '../../domain/index'
import { canonicalize, signDetached, verifyDetached, sha256Tagged } from '../../shared/crypto/index'
import type { Clock, IdentityResolver, NonceStore, ReputationPort } from '../../shared/ports/index'
import type { Config } from '../../shared/config/index'
import { verifySignedObject } from '../../shared/http/index'
import { AuthError, ConflictError, NotFoundError, ValidationError } from '../../shared/errors'
import type { ListingRepo, QuoteRepo } from './repo'
import {
  hardFilter,
  rankSurvivors,
  type FilterContext,
  type ProviderReputation,
} from './ranking'
import type { ListingPublishInput } from './schema'

// CoreSigner: the registry's signing identity. The container registers its public key under
// `did` (so verifiers can check registry-signed quotes/dry-runs) and the private key in the
// keystore under `kid`.
export interface CoreSigner {
  readonly did: string
  readonly kid: string
  readonly privateKey: Uint8Array
  readonly publicKey: Uint8Array
}

export interface RegistryDeps {
  readonly clock: Clock
  readonly nonces: NonceStore
  readonly identity: IdentityResolver
  readonly reputation: ReputationPort
  readonly coreSigner: CoreSigner
  readonly config: Config
  readonly listings: ListingRepo
  readonly quotes: QuoteRepo
}

// Bind window for a quote (§5.2). Five minutes mirrors the spec's example expiry.
const QUOTE_TTL_MS = 5 * 60 * 1000

// Parse a metrics last_settled (RFC 3339 or null) to epoch ms for the freshness signal. An absent or
// unparseable value yields null → the ranker treats the provider as never-settled (freshness 0).
const parseLastSettled = (iso: string | null): number | null => {
  if (iso === null) return null
  const ms = new Date(iso).getTime()
  return Number.isNaN(ms) ? null : ms
}

export class RegistryService {
  private readonly envDeps: { identity: IdentityResolver; nonces: NonceStore; clock: Clock; skewMs: number }

  constructor(private readonly deps: RegistryDeps) {
    this.envDeps = {
      identity: deps.identity,
      nonces: deps.nonces,
      clock: deps.clock,
      skewMs: deps.config.SIGNATURE_SKEW_MS,
    }
  }

  // POST /registry/listings — publish or update a provider-signed listing (§3, §14.2).
  // The provider signs the WHOLE listing; provenance.sig is the detached JWS over the listing
  // with provenance.sig stripped (created/updated/expires stay in the signed payload). The
  // provenance has no nonce/exp envelope of its own — freshness is provenance.expires — so we
  // verify the signature directly and independently guard against a stale/expired listing.
  async publishListing(input: ListingPublishInput): Promise<Listing> {
    const nowMs = this.deps.clock.nowMs()

    const expiresMs = new Date(input.provenance.expires).getTime()
    if (Number.isNaN(expiresMs)) throw new ValidationError('invalid provenance.expires')
    if (expiresMs <= nowMs) throw new ValidationError('listing is already expired')

    const updatedMs = new Date(input.provenance.updated).getTime()
    const createdMs = new Date(input.provenance.created).getTime()
    if (Number.isNaN(updatedMs) || Number.isNaN(createdMs)) throw new ValidationError('invalid provenance timestamps')

    // Verify the provider's signature over the listing EXACTLY as submitted, minus
    // provenance.sig (created/updated/expires stay in the signed payload). The provider signs
    // what it sends: on create it omits listing_id (the registry assigns it afterward), on
    // update it includes the listing_id it is replacing. Signing-then-assigning would let the
    // registry mint an id the provider never attested to, so the id is assigned only AFTER the
    // signature checks out.
    const signingPayload = {
      ...input,
      provenance: stripForSigning(input.provenance as unknown as Record<string, unknown>, ['sig']),
    }
    const providerKey = await this.deps.identity.publicKeyFor(input.provider)
    if (!providerKey) throw new AuthError(`no public key for provider ${input.provider}`)
    const valid = await verifyDetached(signingPayload, input.provenance.sig, providerKey)
    if (!valid) throw new AuthError('listing provenance signature verification failed')

    // Assign on create; on update the listing_id must already exist and stay with its provider.
    // The provider owns the version string — the registry bumps nothing (§3, "quotes bind to
    // version").
    let listingId = input.listing_id
    if (listingId !== undefined) {
      const existing = await this.deps.listings.get(listingId)
      if (!existing) throw new NotFoundError(`listing not found for update: ${listingId}`)
      if (existing.provider !== input.provider) {
        throw new ConflictError('listing provider cannot change on update')
      }
    } else {
      listingId = newListingId()
    }

    // Normalize `sample` so both keys are present (Zod infers z.unknown() keys as optional,
    // but the domain Listing requires them present even when their value is undefined).
    const sample =
      input.sample !== undefined
        ? { request: input.sample.request, response: input.sample.response }
        : undefined
    const listing: Listing = { ...input, listing_id: listingId, sample }
    await this.deps.listings.put(listing)
    return listing
  }

  // GET /registry/listings/:id (§14.2).
  async getListing(listingId: string): Promise<Listing> {
    const listing = await this.deps.listings.get(listingId)
    if (!listing) throw new NotFoundError(`listing not found: ${listingId}`)
    return listing
  }

  // POST /registry/query — capability query → ranked matches + signed quotes (§2.1–§2.3, §14.3).
  async query(query: CapabilityQuery): Promise<{ query_id: string; matches: RankedMatch[] }> {
    // Verify the requester's signature + freshness + single-use nonce (§2.1).
    await verifySignedObject(this.envDeps, query as unknown as Record<string, unknown>, {
      signerDid: query.requester,
    })

    const nowIso = this.deps.clock.now()
    const all = await this.deps.listings.all()

    // Resolve each distinct provider's reputation ONCE (bounded by index size), then hand the
    // synchronous ranker a pure accessor over the resolved map. resolveReputation prefers a
    // signed snapshot's trust, falls back to raw metrics → computeTrust (identical formula,
    // §9.2), else a cold-start default so a provider with no history simply ranks low / fails
    // min_trust rather than being treated as trusted.
    const providers = [...new Set(all.map((l) => l.provider))]
    const resolved = new Map<string, ProviderReputation>()
    await Promise.all(
      providers.map(async (provider) => {
        resolved.set(provider, await this.resolveReputation(provider))
      }),
    )
    const reputationFor = (provider: string): ProviderReputation =>
      resolved.get(provider) ?? { trust: 0, jobs: 0, counterpartyHistory: 0, lastSettledMs: null }

    const ctx: FilterContext = { nowIso, reputationFor }

    // Stage 1: hard filter (remove, never down-rank).
    const { survivors } = hardFilter(query, all, ctx)
    // Stage 2: soft rank on survivors, then truncate to max_results.
    const ranked = rankSurvivors(query, survivors, ctx).slice(0, query.max_results)

    const matches: RankedMatch[] = []
    for (const { listing, explanation } of ranked) {
      const quote = await this.issueQuote(listing, query.requester)
      const price: Money = { amount: listing.pricing.amount, currency: listing.pricing.currency }
      matches.push({
        listing_id: listing.listing_id,
        provider: listing.provider,
        price,
        quote,
        match_explanation: explanation,
      })
    }

    return { query_id: query.query_id, matches }
  }

  // POST /registry/dry-run/:id — the free/near-free probe (§9.4). The provider declares a
  // canonical fixture + "signed-result+checksum". We produce a deterministic, registry-signed
  // dry-run result: the listing's sample.response (or a schema-shaped echo when no sample is
  // declared), a sha256Tagged checksum over the canonical output, and the registry signature.
  // A caller confirms the checksum recomputes and that `output` validates the listing's output
  // schema ref — cheap verification before trust, with near-zero spend.
  async dryRun(listingId: string): Promise<SignedDryRun> {
    const listing = await this.deps.listings.get(listingId)
    if (!listing) throw new NotFoundError(`listing not found: ${listingId}`)
    if (!listing.dry_run.supported) {
      throw new ValidationError(`listing ${listingId} does not support dry-run`)
    }

    const output = this.dryRunOutput(listing)
    if (output === undefined || output === null || (Array.isArray(output) && output.length === 0)) {
      throw new ValidationError('dry-run produced an empty output')
    }

    // Checksum over the JCS-canonical output (§9.4). canonicalize throws on a non-serializable
    // value, so reaching this line guarantees the checksum is recomputable by any caller from
    // the returned `output` — that round-trip is exactly the cheap verification the dry-run
    // promises ("signed-result+checksum"). The output is also exposed alongside output_schema_ref
    // so the caller can validate the shape against the listing's output schema.
    const checksum = sha256Tagged(canonicalize(output))

    const issued = this.deps.clock.now()
    const unsigned = {
      listing_id: listing.listing_id,
      fixture_ref: listing.dry_run.fixture_ref,
      output_schema_ref: listing.io.output_schema.$ref,
      output,
      checksum,
      issued,
      issuer: this.deps.coreSigner.did,
    }
    const sig = await signDetached(unsigned, this.deps.coreSigner.privateKey, this.deps.coreSigner.kid)
    return { ...unsigned, sig }
  }

  // ---- internals --------------------------------------------------------

  private async resolveReputation(provider: string): Promise<ProviderReputation> {
    const snapshot = await this.deps.reputation.getSnapshot(provider)
    if (snapshot) {
      return {
        trust: snapshot.trust,
        jobs: snapshot.metrics.jobs,
        counterpartyHistory: 0,
        lastSettledMs: parseLastSettled(snapshot.metrics.last_settled),
      }
    }
    const raw = await this.deps.reputation.getRaw(provider)
    if (raw) {
      return {
        trust: computeTrust(raw),
        jobs: raw.jobs,
        counterpartyHistory: 0,
        lastSettledMs: parseLastSettled(raw.last_settled),
      }
    }
    // Cold start: no history. computeTrust(emptyMetrics()) is deterministic and low; never settled.
    return { trust: computeTrust(emptyMetrics()), jobs: 0, counterpartyHistory: 0, lastSettledMs: null }
  }

  // Build + sign a bound Quote (§5.2). The quote binds to the listing's CURRENT version, so a
  // later listing version change voids it; the rail is the listing's first accepted rail. The
  // registry signs on the provider's behalf with its core key (kid in the JWS header), and the
  // quote is stored so a subsequent bind/settle can resolve the exact signed object.
  private async issueQuote(listing: Listing, requester: string): Promise<Quote> {
    const issuedMs = this.deps.clock.nowMs()
    const firstRail = listing.pricing.rails[0]
    if (firstRail === undefined) throw new ValidationError(`listing ${listing.listing_id} declares no settlement rail`)

    const unsigned = {
      quote_id: newQuoteId(),
      listing_id: listing.listing_id,
      listing_version: listing.version,
      price: {
        amount: listing.pricing.amount,
        currency: listing.pricing.currency,
        per: listing.pricing.unit,
      },
      rail: firstRail,
      requester,
      issued: new Date(issuedMs).toISOString(),
      expires: new Date(issuedMs + QUOTE_TTL_MS).toISOString(),
    }
    const sig = await signDetached(unsigned, this.deps.coreSigner.privateKey, this.deps.coreSigner.kid)
    const quote: Quote = { ...unsigned, sig }
    await this.deps.quotes.put(quote)
    return quote
  }

  // Deterministic dry-run payload: the provider's declared sample.response if present (the
  // canonical fixture output), otherwise a minimal schema-shaped echo referencing the output
  // schema so the caller still gets a non-empty, validatable shape to checksum.
  private dryRunOutput(listing: Listing): unknown {
    if (listing.sample && listing.sample.response !== undefined && listing.sample.response !== null) {
      return listing.sample.response
    }
    return { schema: listing.io.output_schema.$ref, fixture_ref: listing.dry_run.fixture_ref, rows: [] }
  }
}

export interface SignedDryRun {
  readonly listing_id: string
  readonly fixture_ref: string
  readonly output_schema_ref: string
  readonly output: unknown
  readonly checksum: string
  readonly issued: string
  readonly issuer: string
  readonly sig: string
}
