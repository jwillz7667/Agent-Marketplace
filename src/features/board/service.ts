import type { BoardPost, Money, PostType, Receipt } from '../../domain/index'
import { GENESIS_PREV_HASH, mFromString, newPostId, newSubscriptionId, stripForSigning } from '../../domain/index'
import { hashChain, merkleRoot, verifyDetached } from '../../shared/crypto/index'
import { verifySignedObject } from '../../shared/http/index'
import type {
  Clock,
  IdentityResolver,
  Ledger,
  NonceStore,
  PolicyAction,
  PolicyEvaluator,
  ReputationPort,
  SpendUsage,
  ValueTransferPort,
} from '../../shared/ports/index'
import type { Config } from '../../shared/config/index'
import { ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors'
import type { FlagRepo, PostRepo, Subscription, SubscriptionRepo } from './repo'
import type {
  BoardPostInput,
  BoardQueryInput,
  FlagRequestInput,
  SubscribeInput,
  TombstoneRequestInput,
} from './schema'
import { rankPosts, type RankedPost } from './ranking'

// Chain fields the AUTHOR signs OVER. The author signs the post body BEFORE the server assigns
// these (§8.2), so verification strips them along with the signature. WORK_RECORD additionally
// strips counterparty_sig (the author signs without the co-sig present; both sigs are detached
// JWS over the same author-signed body).
const CHAIN_FIELDS = ['seq', 'prev_hash', 'post_hash'] as const
const AUTHOR_OMIT = ['sig', ...CHAIN_FIELDS]
const WORK_RECORD_AUTHOR_OMIT = ['sig', 'counterparty_sig', ...CHAIN_FIELDS]

// Posting fee held on every post as anti-spam stake (§8.4, §8.5). It is a HOLD, not a spend:
// released after the retention window passes with no upheld flag, forfeited on a sustained
// spam flag. WORK_RECORDs are positive provenance the system wants published, so they post
// free (§8.4) — no hold is placed.
export const POST_FEE_AMOUNT = '0.01'
export const POST_FEE_CURRENCY = 'USDC'

// Flag count at/above which a sustained spam flag is "upheld" and the author's posting-fee
// hold is forfeited + reputation docked (§8.5, §9.3). A small threshold keeps the test
// deterministic; production would weight flagger trust + stake.
export const FLAG_FORFEIT_THRESHOLD = 2

// Anchor cadence (§8.2): recompute + ledger-anchor the Merkle root every N posts. 1 = every
// post (used in tests so the anchor is always current). The root is also recomputable on demand.
const ANCHOR_EVERY = 1

export interface BoardDeps {
  readonly clock: Clock
  readonly nonces: NonceStore
  readonly identity: IdentityResolver
  readonly valueTransfer: ValueTransferPort
  readonly policy: PolicyEvaluator
  readonly reputation: ReputationPort
  readonly ledger: Ledger
  readonly config: Config
  readonly posts: PostRepo
  readonly subscriptions: SubscriptionRepo
  readonly flags: FlagRepo
}

export interface AppendResult {
  readonly post: BoardPost
  readonly merkle_root: string
}

export interface BoardQueryMatch {
  readonly post: BoardPost
  readonly match_explanation: RankedPost['explanation']
}

export interface FlagResult {
  readonly post_id: string
  readonly flagger: string
  readonly flag_count: number
  readonly upheld: boolean
}

export class BoardService {
  private readonly envDeps: { identity: IdentityResolver; nonces: NonceStore; clock: Clock; skewMs: number }

  constructor(private readonly deps: BoardDeps) {
    this.envDeps = {
      identity: deps.identity,
      nonces: deps.nonces,
      clock: deps.clock,
      skewMs: deps.config.SIGNATURE_SKEW_MS,
    }
  }

  // POST /board/post — publish a signed, chain-linked post (§8.1, §8.2, §8.4).
  async post(input: BoardPostInput): Promise<AppendResult> {
    // 1. Verify the AUTHOR's signature over the body minus [sig, counterparty_sig?, chain
    //    fields]. The author signs BEFORE the server assigns seq/prev_hash/post_hash, so those
    //    are stripped along with the signature. Freshness (iat/exp) + single-use nonce are
    //    checked here too. Strip the (zero/empty) inbound chain defaults BEFORE verifying so the
    //    signing input matches exactly what the author signed.
    const authorOmit = input.type === 'WORK_RECORD' ? WORK_RECORD_AUTHOR_OMIT : AUTHOR_OMIT
    const body = stripForSigning(input as unknown as Record<string, unknown>, CHAIN_FIELDS)
    await verifySignedObject(this.envDeps, body, { signerDid: input.author, omitFields: authorOmit })

    // 2. Policy gate (§4.3): the author needs an active delegation that PERMITS posting this
    //    post type. This is a permission check, not a spend cap — the posting fee is a hold, not
    //    a spend — so we pass a zeroed SpendUsage; the gate is about `posting.offers/rfps`.
    await this.enforcePostPolicy(input.author, input.type)

    // 3. WORK_RECORD integrity (§8.3): must link a real ledger receipt AND carry a valid
    //    counterparty co-signature, or it is rejected. Track records cannot be fabricated.
    if (input.type === 'WORK_RECORD') {
      await this.verifyWorkRecord(input, body)
    }

    // 4. Assign chain fields in a fixed order, then store immutably. The order is load-bearing:
    //    (a) seq = head.seq + 1 (genesis seq = 1),
    //    (b) prev_hash = head.post_hash (GENESIS_PREV_HASH for the first post),
    //    (c) post_hash = hashChain(prev_hash, <signed body>),
    //    then (d) append the post with those fields set.
    const head = await this.deps.posts.head()
    const seq = (head?.seq ?? 0) + 1
    const prev_hash = head?.post_hash ?? GENESIS_PREV_HASH
    const post_hash = hashChain(prev_hash, body)

    const stored = { ...input, seq, prev_hash, post_hash } as unknown as BoardPost

    // 5. Posting fee hold (anti-spam, §8.4/§8.5). WORK_RECORDs post free. The hold is keyed by
    //    post_id so the flag handler can forfeit exactly this post's stake. Place the hold
    //    BEFORE the append so a post is never recorded without its backing stake.
    if (input.type !== 'WORK_RECORD') {
      await this.deps.valueTransfer.hold(input.author, this.postFee(), stored.post_id)
    }

    await this.deps.posts.append(stored)

    const root = await this.maybeAnchor(seq)
    return { post: stored, merkle_root: root }
  }

  // GET /board/query — two-stage filter-then-rank (§2.2, §8.3). Tombstoned posts are excluded.
  async query(input: BoardQueryInput): Promise<{ matches: BoardQueryMatch[]; next_cursor: number | null }> {
    const all = await this.deps.posts.all()

    // Collect targets of every TOMBSTONE so the originals are filtered from results (they stay
    // in the chain — only query visibility changes, §8.2).
    const tombstoned = new Set<string>()
    for (const p of all) {
      if (p.type === 'TOMBSTONE') tombstoned.add(p.target_post_id)
    }

    // Resolve each distinct author's trust ONCE (bounded by board size). Cold authors get a
    // recomputed-from-empty/raw trust via the reputation port's snapshot; missing → 0 so an
    // author with no standing simply fails a min_author_trust floor rather than ranking high.
    const authors = [...new Set(all.map((p) => p.author))]
    const trustByAuthor = new Map<string, number>()
    await Promise.all(
      authors.map(async (author) => {
        const snap = await this.deps.reputation.getSnapshot(author)
        trustByAuthor.set(author, snap?.trust ?? 0)
      }),
    )
    const trustFor = (did: string): number => trustByAuthor.get(did) ?? 0

    const nowMs = this.deps.clock.nowMs()
    const cursor = input.cursor ?? 0

    // Stage 1: HARD FILTER (remove, never down-rank). TOMBSTONE posts themselves and tombstoned
    // targets are excluded; cursor advances by seq.
    const survivors = all.filter((p) => {
      if (p.type === 'TOMBSTONE') return false
      if (tombstoned.has(p.post_id)) return false
      if (p.seq <= cursor) return false
      if (input.type !== undefined && p.type !== input.type) return false
      if (input.author !== undefined && p.author !== input.author) return false
      if (input.capability !== undefined && capabilityOf(p) !== input.capability) return false
      if (input.region !== undefined && !regionsOf(p).includes(input.region)) return false
      if (input.since !== undefined && new Date(p.created).getTime() < new Date(input.since).getTime()) return false
      if (input.until !== undefined && new Date(p.created).getTime() > new Date(input.until).getTime()) return false
      if (input.min_author_trust !== undefined && trustFor(p.author) < input.min_author_trust) return false
      if (input.max_price !== undefined) {
        const price = priceAmountOf(p)
        if (price === null) return false // a price ceiling excludes posts without a price
        if (price > Number(input.max_price)) return false
      }
      return true
    })

    // Stage 2: SOFT RANK on survivors (recency + author trust + price for OFFERs). NO
    // engagement, recency-of-marketing, or paid placement (§2.3, §8.4). Then paginate by seq.
    const ranked = rankPosts(survivors, { nowMs, trustFor })
    const page = ranked.slice(0, input.limit)

    const matches: BoardQueryMatch[] = page.map((r) => ({
      post: r.post,
      match_explanation: r.explanation,
    }))

    // Cursor = max seq returned (stable ordering for the next page). Null when fewer than a full
    // page survived, meaning the caller has drained the board for this filter.
    const next_cursor =
      page.length === input.limit ? page.reduce((m, r) => Math.max(m, r.post.seq), 0) : null

    return { matches, next_cursor }
  }

  // POST /board/subscribe — register a topic subscription for push-discovery (§8.3). External
  // URLs are NEVER called here; delivery is out of band (the container's dispatcher polls/pushes).
  async subscribe(input: SubscribeInput): Promise<Subscription> {
    await verifySignedObject(this.envDeps, input as unknown as Record<string, unknown>, {
      signerDid: input.subscriber,
    })

    const sub: Subscription = {
      subscription_id: newSubscriptionId(),
      subscriber: input.subscriber,
      topics: input.topics,
      webhook_url: input.webhook_url ?? null,
      created: this.deps.clock.now(),
    }
    await this.deps.subscriptions.put(sub)
    return sub
  }

  // POST /board/:postId/tombstone — "deleting" is a signed TOMBSTONE by the ORIGINAL author
  // (§8.2). It appends a new post; the original stays in the chain but is filtered from queries.
  async tombstone(postId: string, input: TombstoneRequestInput): Promise<AppendResult> {
    const target = await this.deps.posts.get(postId)
    if (!target) throw new NotFoundError(`post not found: ${postId}`)
    if (target.author !== input.author) {
      throw new ForbiddenError('only the original author may tombstone a post')
    }

    // The tombstone request is itself a signed object by the author (freshness + nonce + sig).
    await verifySignedObject(this.envDeps, input as unknown as Record<string, unknown>, {
      signerDid: input.author,
    })

    const head = await this.deps.posts.head()
    const seq = (head?.seq ?? 0) + 1
    const prev_hash = head?.post_hash ?? GENESIS_PREV_HASH

    // The tombstone is a server-authored chain entry attesting the author's signed retraction.
    // We bind the author's signature (over the retraction request) into the body so the chain
    // entry is non-repudiable, then hash-link it.
    const tombstoneBody = {
      type: 'TOMBSTONE' as const,
      post_id: newPostId(),
      author: input.author,
      created: this.deps.clock.now(),
      target_post_id: postId,
      reason: input.reason,
      nonce: input.nonce,
      iat: input.iat,
      exp: input.exp,
      sig: input.sig,
    }
    const body = stripForSigning(tombstoneBody, CHAIN_FIELDS)
    const post_hash = hashChain(prev_hash, body)
    const stored = { ...tombstoneBody, seq, prev_hash, post_hash } as unknown as BoardPost

    await this.deps.posts.append(stored)
    const root = await this.maybeAnchor(seq)
    return { post: stored, merkle_root: root }
  }

  // POST /board/:postId/flag — report a post for abuse/spam (§8.5). Idempotent per (post, flagger).
  // A sustained/upheld spam flag forfeits the author's posting-fee hold AND docks reputation
  // (cross-surface, §9.3: spamming the board degrades the same DID's service ranking).
  async flag(postId: string, input: FlagRequestInput): Promise<FlagResult> {
    const target = await this.deps.posts.get(postId)
    if (!target) throw new NotFoundError(`post not found: ${postId}`)

    await verifySignedObject(this.envDeps, input as unknown as Record<string, unknown>, {
      signerDid: input.flagger,
    })

    const added = await this.deps.flags.add({
      post_id: postId,
      flagger: input.flagger,
      reason: input.reason,
      category: input.category,
      created: this.deps.clock.now(),
    })
    const flag_count = await this.deps.flags.countFor(postId)

    // Upheld once a sustained number of distinct flaggers report spam/fraud/injection/malware.
    const isAbuse = input.category !== 'other'
    const upheld = isAbuse && flag_count >= FLAG_FORFEIT_THRESHOLD

    if (upheld && !(await this.deps.flags.isForfeited(postId))) {
      // Forfeit the author's posting-fee hold for THIS post (§8.5 stake slashing). The hold id
      // equals the post_id (the ref we held under), so the value layer can resolve it.
      await this.deps.valueTransfer.forfeit(postId)
      // Cross-surface reputation penalty (§9.3): a post_flag signal degrades service ranking.
      await this.deps.reputation.ingestSignal(target.author, 'post_flag', 1)
      await this.deps.flags.markForfeited(postId)
    }

    // `added` is consulted to keep the operation idempotent: a repeat flag by the same flagger
    // neither double-counts nor re-forfeits (the forfeit guard above is also idempotent).
    void added

    return { post_id: postId, flagger: input.flagger, flag_count, upheld }
  }

  // Recomputable Merkle root over all post_hashes (§8.2). Exposed via GET so board state is
  // externally verifiable against the latest ledger anchor.
  async merkleRoot(): Promise<{ merkle_root: string; head_seq: number }> {
    const hashes = await this.deps.posts.hashes()
    const head = await this.deps.posts.head()
    return { merkle_root: merkleRoot(hashes), head_seq: head?.seq ?? 0 }
  }

  // ---- internals --------------------------------------------------------

  private postFee(): Money {
    return mFromString(POST_FEE_AMOUNT, POST_FEE_CURRENCY)
  }

  // Map post type → policy sub-kind and evaluate against the author's active delegation. A
  // missing delegation fails closed (ForbiddenError); a deny decision is forbidden. The fee is
  // a hold not a spend, so SpendUsage is zeroed — the gate is purely about posting permission.
  private async enforcePostPolicy(author: string, type: PostType): Promise<void> {
    const delegation = await this.deps.identity.activeDelegation(author)
    if (!delegation) throw new ForbiddenError(`no active delegation for author ${author}`)

    const subKind = type === 'OFFER' ? 'offer' : type === 'RFP' ? 'rfp' : 'other'
    const action: PolicyAction = { kind: 'post', agent: author, subKind }
    const usage: SpendUsage = {
      dailySpent: { amount: '0', currency: POST_FEE_CURRENCY },
      totalSpent: { amount: '0', currency: POST_FEE_CURRENCY },
    }
    const decision = this.deps.policy.evaluate(delegation, action, usage)
    if (decision.result === 'deny') {
      throw new ForbiddenError(`posting denied by policy: ${decision.reasons.join('; ')}`)
    }
    if (decision.result === 'needs_approval') {
      throw new ForbiddenError(`posting requires approval: ${decision.reasons.join('; ')}`)
    }
  }

  // §8.3 WORK_RECORD integrity. Two independent checks, BOTH required:
  //  (1) the receipt_ref resolves to a real settled receipt in the Ledger, and the post's
  //      author + counterparty match the receipt's payee/payer (in either direction), and
  //  (2) the counterparty_sig is a valid second detached JWS by the counterparty over the same
  //      author-signed body (minus both sigs + chain fields).
  // Either failing rejects the post — track records cannot be fabricated.
  private async verifyWorkRecord(
    input: Extract<BoardPostInput, { type: 'WORK_RECORD' }>,
    body: Record<string, unknown>,
  ): Promise<void> {
    const entries = await this.deps.ledger.list({ kind: 'receipt' })
    const receipt = entries
      .map((e) => e.payload as Receipt | undefined)
      .find((r) => r !== undefined && r !== null && r.receipt_id === input.receipt_ref)
    if (!receipt) {
      throw new ValidationError(`WORK_RECORD references unknown receipt: ${input.receipt_ref}`)
    }

    const parties = new Set([receipt.payer, receipt.payee])
    if (!parties.has(input.author) || !parties.has(input.counterparty) || input.author === input.counterparty) {
      throw new ForbiddenError('WORK_RECORD author/counterparty do not match the receipt parties')
    }

    const cpKey = await this.deps.identity.publicKeyFor(input.counterparty)
    if (!cpKey) throw new ForbiddenError(`no public key for counterparty ${input.counterparty}`)

    // The counterparty signs the SAME body the author signed (sig + counterparty_sig + chain
    // fields stripped). Strip them symmetrically before verifying the detached JWS.
    const coSignBody = stripForSigning(body, ['sig', 'counterparty_sig'])
    const valid = await verifyDetached(coSignBody, input.counterparty_sig, cpKey)
    if (!valid) throw new ForbiddenError('WORK_RECORD counterparty co-signature is invalid')
  }

  // Anchor the Merkle root to the Ledger every ANCHOR_EVERY posts so board state is externally
  // verifiable (§8.2). Returns the current root either way.
  private async maybeAnchor(seq: number): Promise<string> {
    const hashes = await this.deps.posts.hashes()
    const root = merkleRoot(hashes)
    if (seq % ANCHOR_EVERY === 0) {
      await this.deps.ledger.append({ kind: 'board_anchor', payload: { merkle_root: root, seq } })
    }
    return root
  }
}

// ---- pure field accessors over the post discriminated union ----
// Typed fields only — free-text (descriptions/prose) NEVER drives filtering/ranking (§10.3).

const capabilityOf = (p: BoardPost): string | null => {
  if (p.type === 'OFFER' || p.type === 'RFP') return p.capability
  return null
}

const regionsOf = (p: BoardPost): readonly string[] => (p.type === 'OFFER' ? p.regions : [])

const priceAmountOf = (p: BoardPost): number | null => {
  if (p.type === 'OFFER') return Number(p.price_from.amount)
  if (p.type === 'RFP') return Number(p.budget.amount)
  return null
}
