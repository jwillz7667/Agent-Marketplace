import { describe, it, expect, beforeEach } from 'vitest'
import { FixedClock } from '../../shared/time/clock'
import { generateKeyPair, hashChain, merkleRoot, type KeyPair } from '../../shared/crypto/index'
import { GENESIS_PREV_HASH, stripForSigning, type BoardPost } from '../../domain/index'
import { buildBoard, type BoardModule } from './index'
import {
  FakeIdentity,
  FakeLedger,
  FakeNonces,
  FakePolicy,
  FakeReputation,
  FakeValueTransfer,
  TEST_CONFIG,
  makeReceipt,
  makeSnapshot,
  signAnnouncement,
  signFlagReq,
  signOffer,
  signRfp,
  signSubscribe,
  signTombstoneReq,
  signWorkRecord,
} from './test-helpers'

const AUTHOR = 'did:praxis:agent:author'
const OTHER = 'did:praxis:agent:other'
const COUNTERPARTY = 'did:praxis:agent:counterparty'
const FLAGGER1 = 'did:praxis:agent:flagger1'
const FLAGGER2 = 'did:praxis:agent:flagger2'

interface Harness {
  module: BoardModule
  identity: FakeIdentity
  valueTransfer: FakeValueTransfer
  policy: FakePolicy
  reputation: FakeReputation
  ledger: FakeLedger
  clock: FixedClock
  keys: Record<string, KeyPair>
}

const newHarness = async (): Promise<Harness> => {
  const clock = new FixedClock('2026-06-06T15:00:00.000Z')
  const identity = new FakeIdentity()
  const valueTransfer = new FakeValueTransfer()
  const policy = new FakePolicy()
  const reputation = new FakeReputation()
  const ledger = new FakeLedger()
  const nonces = new FakeNonces()

  const keys: Record<string, KeyPair> = {}
  for (const did of [AUTHOR, OTHER, COUNTERPARTY, FLAGGER1, FLAGGER2]) {
    keys[did] = await generateKeyPair()
  }
  // Authors that POST need an active delegation; flaggers/subscribers only need a resolvable key.
  identity.registerWithDelegation(AUTHOR, keys[AUTHOR]!.publicKey)
  identity.registerWithDelegation(OTHER, keys[OTHER]!.publicKey)
  identity.registerWithDelegation(COUNTERPARTY, keys[COUNTERPARTY]!.publicKey)
  identity.register(FLAGGER1, keys[FLAGGER1]!.publicKey)
  identity.register(FLAGGER2, keys[FLAGGER2]!.publicKey)

  const module = buildBoard({
    clock,
    nonces,
    idempotency: { execute: async (_scope, _key, fn) => fn() },
    identity,
    valueTransfer,
    policy,
    reputation,
    ledger,
    config: TEST_CONFIG,
  })

  return { module, identity, valueTransfer, policy, reputation, ledger, clock, keys }
}

describe('BoardService.post — append-only hash chain (§8.2)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('appends three posts that link correctly across seq + prev_hash + post_hash', async () => {
    const svc = h.module.boardService

    const p1 = await svc.post(await signOffer(AUTHOR, h.keys[AUTHOR]!))
    const p2 = await svc.post(await signRfp(AUTHOR, h.keys[AUTHOR]!))
    const p3 = await svc.post(await signAnnouncement(AUTHOR, h.keys[AUTHOR]!))

    // seq is monotonic starting at 1 (genesis seq convention).
    expect(p1.post.seq).toBe(1)
    expect(p2.post.seq).toBe(2)
    expect(p3.post.seq).toBe(3)

    // The first post links to GENESIS_PREV_HASH; each subsequent prev_hash equals the prior
    // post_hash — the hash chain is intact.
    expect(p1.post.prev_hash).toBe(GENESIS_PREV_HASH)
    expect(p2.post.prev_hash).toBe(p1.post.post_hash)
    expect(p3.post.prev_hash).toBe(p2.post.post_hash)

    // Each post_hash recomputes from (prev_hash, signed body) — externally verifiable.
    const bodyOf = (post: BoardPost): Record<string, unknown> =>
      stripForSigning(post as unknown as Record<string, unknown>, ['seq', 'prev_hash', 'post_hash'])
    expect(p1.post.post_hash).toBe(hashChain(GENESIS_PREV_HASH, bodyOf(p1.post)))
    expect(p2.post.post_hash).toBe(hashChain(p1.post.post_hash, bodyOf(p2.post)))
    expect(p3.post.post_hash).toBe(hashChain(p2.post.post_hash, bodyOf(p3.post)))
  })

  it('is append-only: the repo exposes no update path, so a new post supersedes (no edit)', async () => {
    const svc = h.module.boardService
    const posted = await svc.post(await signOffer(AUTHOR, h.keys[AUTHOR]!, { price: '0.02' }))

    // The PostRepo interface has no update/delete — superseding is a NEW post with a new id.
    const repo = h.module.boardService as unknown as { deps: { posts: { append: unknown; get: unknown } } }
    expect('update' in repo.deps.posts).toBe(false)

    const replacement = await svc.post(await signOffer(AUTHOR, h.keys[AUTHOR]!, { price: '0.05' }))
    expect(replacement.post.post_id).not.toBe(posted.post.post_id)
    expect(replacement.post.seq).toBe(posted.post.seq + 1)
  })

  it('rejects a replayed nonce (§ everything-is-signed)', async () => {
    const svc = h.module.boardService
    const offer = await signOffer(AUTHOR, h.keys[AUTHOR]!, { nonce: 'reused-nonce' })
    await svc.post(offer)

    const replay = await signOffer(AUTHOR, h.keys[AUTHOR]!, { nonce: 'reused-nonce' })
    await expect(svc.post(replay)).rejects.toThrow(/replayed/)
  })

  it('rejects a post whose author signature does not verify (tampered typed field)', async () => {
    const svc = h.module.boardService
    const offer = await signOffer(AUTHOR, h.keys[AUTHOR]!)
    const tampered = { ...offer, price_from: { amount: '99.99', currency: 'USDC', per: 'call' } }
    await expect(svc.post(tampered as typeof offer)).rejects.toThrow(/signature verification failed/)
  })

  it('denies a post when policy denies the post type (§4.3 gate)', async () => {
    const svc = h.module.boardService
    h.policy.deny(AUTHOR)
    await expect(svc.post(await signOffer(AUTHOR, h.keys[AUTHOR]!))).rejects.toThrow(/denied by policy/)
  })

  it('forbids a post from an author with no active delegation', async () => {
    const svc = h.module.boardService
    // FLAGGER1 has a key but no delegation registered.
    const offer = await signOffer(FLAGGER1, h.keys[FLAGGER1]!)
    await expect(svc.post(offer)).rejects.toThrow(/no active delegation/)
  })
})

describe('BoardService.post — posting-fee hold (§8.4/§8.5)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('holds a posting fee for an OFFER but posts a WORK_RECORD free', async () => {
    const svc = h.module.boardService

    const offer = await svc.post(await signOffer(AUTHOR, h.keys[AUTHOR]!))
    const heldOffer = h.valueTransfer.holdsByRef.get(offer.post.post_id)
    expect(heldOffer?.status).toBe('held')
    expect(heldOffer?.amount).toEqual({ amount: '0.01', currency: 'USDC' })

    // Seed a receipt so the WORK_RECORD validates, then assert NO hold was placed.
    const receipt = makeReceipt({ receipt_id: 'rcp_WR', payer: COUNTERPARTY, payee: AUTHOR })
    h.ledger.seedReceipt(receipt)
    const wr = await svc.post(
      await signWorkRecord(AUTHOR, h.keys[AUTHOR]!, COUNTERPARTY, h.keys[COUNTERPARTY]!, 'rcp_WR'),
    )
    expect(h.valueTransfer.holdsByRef.has(wr.post.post_id)).toBe(false)
  })
})

describe('BoardService.tombstone (§8.2)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('hides a tombstoned post from query but keeps it in the chain', async () => {
    const svc = h.module.boardService
    const posted = await svc.post(await signOffer(AUTHOR, h.keys[AUTHOR]!))

    const tomb = await svc.tombstone(posted.post.post_id, await signTombstoneReq(AUTHOR, h.keys[AUTHOR]!))

    // The tombstone is a NEW chain entry appended after the original — the original is not removed.
    expect(tomb.post.type).toBe('TOMBSTONE')
    expect(tomb.post.seq).toBe(2)
    expect(tomb.post.prev_hash).toBe(posted.post.post_hash)

    const stored = await h.module.boardService.merkleRoot()
    expect(stored.head_seq).toBe(2) // both posts still in the chain

    // Query excludes the tombstoned original AND the tombstone post itself.
    const { matches } = await svc.query({ limit: 50 })
    expect(matches.find((m) => m.post.post_id === posted.post.post_id)).toBeUndefined()
    expect(matches.every((m) => m.post.type !== 'TOMBSTONE')).toBe(true)
  })

  it('forbids a tombstone from a non-author', async () => {
    const svc = h.module.boardService
    const posted = await svc.post(await signOffer(AUTHOR, h.keys[AUTHOR]!))
    await expect(
      svc.tombstone(posted.post.post_id, await signTombstoneReq(OTHER, h.keys[OTHER]!)),
    ).rejects.toThrow(/only the original author/)
  })
})

describe('BoardService.post — WORK_RECORD integrity (§8.3)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('rejects a WORK_RECORD with no matching ledger receipt', async () => {
    const svc = h.module.boardService
    const wr = await signWorkRecord(AUTHOR, h.keys[AUTHOR]!, COUNTERPARTY, h.keys[COUNTERPARTY]!, 'rcp_MISSING')
    await expect(svc.post(wr)).rejects.toThrow(/unknown receipt/)
  })

  it('rejects a WORK_RECORD whose parties do not match the receipt', async () => {
    const svc = h.module.boardService
    // Receipt is between AUTHOR and OTHER, but the post names COUNTERPARTY.
    h.ledger.seedReceipt(makeReceipt({ receipt_id: 'rcp_X', payer: OTHER, payee: AUTHOR }))
    const wr = await signWorkRecord(AUTHOR, h.keys[AUTHOR]!, COUNTERPARTY, h.keys[COUNTERPARTY]!, 'rcp_X')
    await expect(svc.post(wr)).rejects.toThrow(/do not match the receipt parties/)
  })

  it('rejects a WORK_RECORD with an invalid counterparty co-signature', async () => {
    const svc = h.module.boardService
    h.ledger.seedReceipt(makeReceipt({ receipt_id: 'rcp_Y', payer: COUNTERPARTY, payee: AUTHOR }))
    const wr = await signWorkRecord(
      AUTHOR,
      h.keys[AUTHOR]!,
      COUNTERPARTY,
      h.keys[COUNTERPARTY]!,
      'rcp_Y',
      { withCounterpartySig: false },
    )
    await expect(svc.post(wr)).rejects.toThrow(/co-signature is invalid/)
  })

  it('accepts a valid WORK_RECORD (receipt seeded + both sigs valid)', async () => {
    const svc = h.module.boardService
    h.ledger.seedReceipt(makeReceipt({ receipt_id: 'rcp_OK', payer: COUNTERPARTY, payee: AUTHOR }))
    const wr = await signWorkRecord(AUTHOR, h.keys[AUTHOR]!, COUNTERPARTY, h.keys[COUNTERPARTY]!, 'rcp_OK')

    const result = await svc.post(wr)
    expect(result.post.type).toBe('WORK_RECORD')
    expect(result.post.seq).toBe(1)
  })
})

describe('BoardService.flag (§8.5, cross-surface §9.3)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('forfeits the posting-fee hold and ingests a post_flag signal on sustained spam', async () => {
    const svc = h.module.boardService
    const posted = await svc.post(await signOffer(AUTHOR, h.keys[AUTHOR]!))

    // First flag: below threshold, not upheld, no forfeit/penalty yet.
    const f1 = await svc.flag(posted.post.post_id, await signFlagReq(FLAGGER1, h.keys[FLAGGER1]!))
    expect(f1.upheld).toBe(false)
    expect(h.valueTransfer.holdsByRef.get(posted.post.post_id)?.status).toBe('held')
    expect(h.reputation.signals.length).toBe(0)

    // Second distinct flagger: threshold reached → forfeit + post_flag signal.
    const f2 = await svc.flag(posted.post.post_id, await signFlagReq(FLAGGER2, h.keys[FLAGGER2]!))
    expect(f2.upheld).toBe(true)
    expect(f2.flag_count).toBe(2)
    expect(h.valueTransfer.holdsByRef.get(posted.post.post_id)?.status).toBe('forfeited')
    expect(h.reputation.signals).toContainEqual({ did: AUTHOR, kind: 'post_flag', weight: 1 })
  })

  it('is idempotent per (post, flagger): a repeat flag does not double-count or re-forfeit', async () => {
    const svc = h.module.boardService
    const posted = await svc.post(await signOffer(AUTHOR, h.keys[AUTHOR]!))

    await svc.flag(posted.post.post_id, await signFlagReq(FLAGGER1, h.keys[FLAGGER1]!))
    await svc.flag(posted.post.post_id, await signFlagReq(FLAGGER2, h.keys[FLAGGER2]!))
    const before = h.reputation.signals.length

    // FLAGGER1 flags again (fresh nonce/sig, same flagger): no new count, no new penalty.
    const again = await svc.flag(posted.post.post_id, await signFlagReq(FLAGGER1, h.keys[FLAGGER1]!))
    expect(again.flag_count).toBe(2)
    expect(h.reputation.signals.length).toBe(before)
  })
})

describe('BoardService.query — two-stage filter-then-rank (§2.2)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('hard-filters by typed fields then soft-ranks with a match_explanation', async () => {
    const svc = h.module.boardService
    // AUTHOR is high-trust; OTHER is cold (no snapshot → trust 0).
    h.reputation.setSnapshot(AUTHOR, makeSnapshot(AUTHOR, 0.95))

    // Two OFFERs in the target capability + one in a different capability (hard-filtered out).
    const target = await svc.post(await signOffer(AUTHOR, h.keys[AUTHOR]!, { capability: 'doc.extract.tables', price: '0.01' }))
    await svc.post(await signOffer(OTHER, h.keys[OTHER]!, { capability: 'doc.extract.tables', price: '0.02' }))
    await svc.post(await signOffer(AUTHOR, h.keys[AUTHOR]!, { capability: 'image.ocr', price: '0.01' }))

    const { matches } = await svc.query({ type: 'OFFER', capability: 'doc.extract.tables', limit: 50 })

    // Hard filter removed the image.ocr offer entirely.
    expect(matches.length).toBe(2)
    expect(matches.every((m) => m.post.type === 'OFFER')).toBe(true)

    // Soft rank: the high-trust author's offer ranks first; every match carries an explanation.
    expect(matches[0]!.post.post_id).toBe(target.post.post_id)
    expect(matches[0]!.match_explanation.signals.author_trust).toBeGreaterThan(
      matches[1]!.match_explanation.signals.author_trust,
    )
    expect(matches[0]!.match_explanation.score).toBeGreaterThan(matches[1]!.match_explanation.score)
    expect(matches[0]!.match_explanation.post_id).toBe(target.post.post_id)
  })

  it('enforces a min_author_trust floor as a hard filter (removes, not down-ranks)', async () => {
    const svc = h.module.boardService
    h.reputation.setSnapshot(AUTHOR, makeSnapshot(AUTHOR, 0.95))
    // OTHER has no snapshot → trust 0, below the floor.
    await svc.post(await signOffer(AUTHOR, h.keys[AUTHOR]!))
    await svc.post(await signOffer(OTHER, h.keys[OTHER]!))

    const { matches } = await svc.query({ type: 'OFFER', min_author_trust: 0.5, limit: 50 })
    expect(matches.length).toBe(1)
    expect(matches[0]!.post.author).toBe(AUTHOR)
  })
})

describe('BoardService — Merkle anchor (§8.2)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('computes a recomputable Merkle root and anchors it to the ledger', async () => {
    const svc = h.module.boardService
    const p1 = await svc.post(await signOffer(AUTHOR, h.keys[AUTHOR]!))
    const p2 = await svc.post(await signRfp(AUTHOR, h.keys[AUTHOR]!))

    const { merkle_root, head_seq } = await svc.merkleRoot()
    expect(head_seq).toBe(2)
    // Recomputable from the ordered post_hashes by anyone.
    expect(merkle_root).toBe(merkleRoot([p1.post.post_hash, p2.post.post_hash]))

    // The latest anchor was appended to the ledger and matches the current root + head seq.
    const anchors = await h.ledger.list({ kind: 'board_anchor' })
    expect(anchors.length).toBe(2)
    const latest = anchors[anchors.length - 1]!.payload as { merkle_root: string; seq: number }
    expect(latest.merkle_root).toBe(merkle_root)
    expect(latest.seq).toBe(2)
  })
})

describe('BoardService.subscribe (§8.3)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })

  it('registers a topic subscription without calling external URLs', async () => {
    const svc = h.module.boardService
    const sub = await svc.subscribe(
      await signSubscribe(FLAGGER1, h.keys[FLAGGER1]!, ['capability:doc.*', 'type:RFP']),
    )
    expect(sub.subscription_id).toMatch(/^sub_/)
    expect(sub.subscriber).toBe(FLAGGER1)
    expect(sub.topics).toEqual(['capability:doc.*', 'type:RFP'])
    expect(sub.webhook_url).toBeNull()
  })

  it('rejects a subscribe with an unverifiable signature', async () => {
    const svc = h.module.boardService
    const sub = await signSubscribe(FLAGGER1, h.keys[FLAGGER1]!, ['type:OFFER'])
    const tampered = { ...sub, topics: ['type:RFP'] }
    await expect(svc.subscribe(tampered)).rejects.toThrow(/signature verification failed/)
  })
})
