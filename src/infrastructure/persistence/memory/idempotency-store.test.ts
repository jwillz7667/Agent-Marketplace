import { describe, expect, it } from 'vitest'
import { MemoryIdempotencyStore } from './idempotency-store'

// §6.1 single-flight idempotency gate. These cover the three guarantees the port promises, with the
// concurrency case being the B1 double-charge regression: two duplicates that interleave on the
// event loop must invoke the side effect exactly once.
describe('MemoryIdempotencyStore', () => {
  it('runs fn once and caches the result for a sequential retry', async () => {
    const store = new MemoryIdempotencyStore()
    let calls = 0
    const fn = async (): Promise<string> => {
      calls += 1
      return 'receipt-1'
    }

    const first = await store.execute('pay', 'k1', fn)
    const second = await store.execute('pay', 'k1', fn)

    expect(first).toBe('receipt-1')
    expect(second).toBe('receipt-1')
    expect(calls).toBe(1)
  })

  it('collapses CONCURRENT duplicates onto one execution (no double-charge)', async () => {
    const store = new MemoryIdempotencyStore()
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // fn yields at an await (modeling rail/settle I/O) so both callers are in-flight together —
    // exactly the interleaving the old begin()→'new' path double-executed.
    const fn = async (): Promise<number> => {
      calls += 1
      await gate
      return calls
    }

    const a = store.execute('pay', 'race', fn)
    const b = store.execute('pay', 'race', fn)
    release()
    const [ra, rb] = await Promise.all([a, b])

    expect(calls).toBe(1)
    expect(ra).toBe(1)
    expect(rb).toBe(1) // joined the same in-flight run, not a second execution
  })

  it('does NOT cache a failure — the key is released for a later retry', async () => {
    const store = new MemoryIdempotencyStore()
    let calls = 0
    const failing = async (): Promise<string> => {
      calls += 1
      throw new Error('transient rail error')
    }

    await expect(store.execute('pay', 'k2', failing)).rejects.toThrow('transient rail error')

    // A retry after the failure re-runs (the failed attempt was not cached as a permanent result).
    const ok = await store.execute('pay', 'k2', async () => 'recovered')
    expect(ok).toBe('recovered')
    expect(calls).toBe(1)
  })

  it('propagates the in-flight rejection to a joined concurrent caller, then releases', async () => {
    const store = new MemoryIdempotencyStore()
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const failing = async (): Promise<string> => {
      calls += 1
      await gate
      throw new Error('boom')
    }

    const a = store.execute('pay', 'k3', failing)
    const b = store.execute('pay', 'k3', failing)
    release()

    await expect(a).rejects.toThrow('boom')
    await expect(b).rejects.toThrow('boom')
    expect(calls).toBe(1) // both joined the single failing run

    // Released after failure: a fresh attempt runs.
    const ok = await store.execute('pay', 'k3', async () => 'ok')
    expect(ok).toBe('ok')
  })

  it('scopes keys independently', async () => {
    const store = new MemoryIdempotencyStore()
    const a = await store.execute('pay', 'same', async () => 'pay-result')
    const b = await store.execute('escrow', 'same', async () => 'escrow-result')
    expect(a).toBe('pay-result')
    expect(b).toBe('escrow-result')
  })
})
