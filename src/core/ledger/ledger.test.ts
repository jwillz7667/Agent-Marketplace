import { describe, it, expect } from 'vitest'
import { hashChain, merkleRoot } from '../../shared/crypto/index'
import type { LedgerEntry } from '../../shared/ports/index'
import { FixedClock } from '../../shared/time/clock'
import { buildLedger, GENESIS_PREV_HASH, LedgerService } from './index'
import { MemoryLedgerRepo } from './memory'
import type { LedgerRepo } from './repo'

const content = (e: LedgerEntry) => ({
  seq: e.seq,
  ts: e.ts,
  kind: e.kind,
  subject: e.subject,
  payload: e.payload,
})

// A repo that lets a test seed an arbitrary (possibly broken) chain state, to exercise
// verifyChain against tampering without needing a mutate/delete method on the real repo.
class SeedableLedgerRepo implements LedgerRepo {
  constructor(private entries: LedgerEntry[] = []) {}
  async appendEntry(entry: LedgerEntry): Promise<void> {
    this.entries.push(entry)
  }
  async last(): Promise<LedgerEntry | null> {
    return this.entries[this.entries.length - 1] ?? null
  }
  async all(): Promise<LedgerEntry[]> {
    return [...this.entries]
  }
}

describe('LedgerService.append', () => {
  it('builds a valid 1-based hash chain from genesis', async () => {
    const { ledger } = buildLedger({ clock: new FixedClock() })

    const a = await ledger.append({ kind: 'receipt', subject: 'lst_1', payload: { payer: 'did:a', amount: '1' } })
    const b = await ledger.append({ kind: 'receipt', subject: 'lst_2', payload: { payer: 'did:b', amount: '2' } })
    const c = await ledger.append({ kind: 'key_event', payload: { rotated: 'did:c' } })

    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(c.seq).toBe(3)

    expect(a.prevHash).toBe(GENESIS_PREV_HASH)
    expect(b.prevHash).toBe(a.hash)
    expect(c.prevHash).toBe(b.hash)

    // hash binds {seq, ts, kind, subject, payload}.
    expect(a.hash).toBe(hashChain(GENESIS_PREV_HASH, content(a)))
    expect(b.hash).toBe(hashChain(a.hash, content(b)))

    // omitted subject is absent on the entry, not undefined-keyed noise.
    expect('subject' in c).toBe(false)

    expect(await ledger.verifyChain()).toBe(true)
  })

  it('stamps ts from the injected clock', async () => {
    const clock = new FixedClock('2026-01-02T03:04:05.000Z')
    const { ledger } = buildLedger({ clock })
    const e = await ledger.append({ kind: 'receipt', payload: {} })
    expect(e.ts).toBe('2026-01-02T03:04:05.000Z')
  })

  it('has no update or delete surface (truly append-only)', () => {
    const svc = new LedgerService(new MemoryLedgerRepo(), new FixedClock()) as unknown as Record<string, unknown>
    expect(svc['update']).toBeUndefined()
    expect(svc['delete']).toBeUndefined()
    expect(svc['remove']).toBeUndefined()
  })
})

describe('LedgerService.verifyChain', () => {
  it('returns true for an untampered chain', async () => {
    const { ledger } = buildLedger({ clock: new FixedClock() })
    for (let i = 0; i < 5; i++) await ledger.append({ kind: 'receipt', payload: { i } })
    expect(await ledger.verifyChain()).toBe(true)
  })

  it('returns false when an entry payload is tampered (hash no longer recomputes)', async () => {
    const clock = new FixedClock()
    const seed = new SeedableLedgerRepo()
    const good = new LedgerService(seed, clock)
    await good.append({ kind: 'receipt', subject: 'lst_1', payload: { payer: 'did:a', amount: '1' } })
    await good.append({ kind: 'receipt', subject: 'lst_2', payload: { payer: 'did:b', amount: '2' } })

    const entries = await seed.all()
    const target = entries[1]!
    // Mutate the payload in place while leaving the stored hash untouched: classic
    // tamper. verifyChain recomputes hashChain(prevHash, content) and disagrees.
    const tampered: LedgerEntry[] = [
      entries[0]!,
      { ...target, payload: { payer: 'did:b', amount: '999999' } },
    ]
    const broken = new LedgerService(new SeedableLedgerRepo(tampered), clock)
    expect(await broken.verifyChain()).toBe(false)
  })

  it('returns false when the chain link (prevHash) is broken', async () => {
    const clock = new FixedClock()
    const seed = new SeedableLedgerRepo()
    const svc = new LedgerService(seed, clock)
    await svc.append({ kind: 'receipt', payload: { a: 1 } })
    await svc.append({ kind: 'receipt', payload: { a: 2 } })

    const entries = await seed.all()
    const broken: LedgerEntry[] = [entries[0]!, { ...entries[1]!, prevHash: GENESIS_PREV_HASH }]
    const svc2 = new LedgerService(new SeedableLedgerRepo(broken), clock)
    expect(await svc2.verifyChain()).toBe(false)
  })

  it('returns false when seq is non-monotonic (reordered)', async () => {
    const clock = new FixedClock()
    const seed = new SeedableLedgerRepo()
    const svc = new LedgerService(seed, clock)
    await svc.append({ kind: 'receipt', payload: { a: 1 } })
    await svc.append({ kind: 'receipt', payload: { a: 2 } })

    const entries = await seed.all()
    // Physically swap the two entries: seqs now read 2,1 — non-monotonic.
    const reordered: LedgerEntry[] = [entries[1]!, entries[0]!]
    const svc2 = new LedgerService(new SeedableLedgerRepo(reordered), clock)
    expect(await svc2.verifyChain()).toBe(false)
  })
})

describe('LedgerService.merkleRoot', () => {
  it('is deterministic and equals merkleRoot over entry hashes in seq order', async () => {
    const buildSame = async () => {
      const { ledger } = buildLedger({ clock: new FixedClock() })
      const hashes: string[] = []
      for (let i = 0; i < 4; i++) {
        const e = await ledger.append({ kind: 'receipt', payload: { i } })
        hashes.push(e.hash)
      }
      return { root: await ledger.merkleRoot(), hashes }
    }

    const a = await buildSame()
    const b = await buildSame()

    expect(a.root).toBe(b.root)
    expect(a.root).toBe(merkleRoot(a.hashes))
  })

  it('roots differ once an additional entry is anchored', async () => {
    const { ledger } = buildLedger({ clock: new FixedClock() })
    await ledger.append({ kind: 'receipt', payload: { i: 0 } })
    const r1 = await ledger.merkleRoot()
    await ledger.append({ kind: 'receipt', payload: { i: 1 } })
    const r2 = await ledger.merkleRoot()
    expect(r1).not.toBe(r2)
  })
})

describe('LedgerService.list', () => {
  const seedLedger = async () => {
    const clock = new FixedClock('2026-06-06T15:00:00.000Z')
    const { ledger } = buildLedger({ clock })
    await ledger.append({ kind: 'receipt', subject: 'lst_a', payload: { payer: 'did:alice', amount: '1' } })
    clock.advance(1000)
    await ledger.append({ kind: 'receipt', subject: 'lst_b', payload: { payer: 'did:bob', amount: '2' } })
    clock.advance(1000)
    await ledger.append({ kind: 'key_event', subject: 'lst_a', payload: { from: 'did:alice', rotated: true } })
    return ledger
  }

  it('filters by kind', async () => {
    const ledger = await seedLedger()
    const out = await ledger.list({ kind: 'receipt' })
    expect(out.map((e) => e.seq)).toEqual([1, 2])
  })

  it('filters by subject', async () => {
    const ledger = await seedLedger()
    const out = await ledger.list({ subject: 'lst_a' })
    expect(out.map((e) => e.seq)).toEqual([1, 3])
  })

  it('filters by since (seq >=) and returns seq order', async () => {
    const ledger = await seedLedger()
    const out = await ledger.list({ since: 2 })
    expect(out.map((e) => e.seq)).toEqual([2, 3])
  })

  it('filters by until (ts <=, inclusive)', async () => {
    const ledger = await seedLedger()
    const out = await ledger.list({ until: '2026-06-06T15:00:01.000Z' })
    expect(out.map((e) => e.seq)).toEqual([1, 2])
  })

  it('filters by from (payload.payer or payload.from)', async () => {
    const ledger = await seedLedger()
    const out = await ledger.list({ from: 'did:alice' })
    // seq 1 matches via payer, seq 3 matches via from.
    expect(out.map((e) => e.seq)).toEqual([1, 3])
  })

  it('returns all entries in seq order with no filter', async () => {
    const ledger = await seedLedger()
    const out = await ledger.list()
    expect(out.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('combines filters (AND semantics)', async () => {
    const ledger = await seedLedger()
    const out = await ledger.list({ kind: 'receipt', subject: 'lst_a' })
    expect(out.map((e) => e.seq)).toEqual([1])
  })
})
