import type { IdempotencyStore } from '../../../shared/ports/index'

// In-memory single-flight idempotency store. Within one process this is fully correct: a settled
// (scope,key) returns its cached response, a concurrent duplicate joins the one in-flight execution
// (so a captured request replayed under a fresh Idempotency-Key cannot run the side effect twice),
// and a thrown execution releases the key so a later retry re-runs rather than caching the failure.
//
// PRODUCTION NOTE: a distributed (Redis/Postgres) adapter must reproduce these three guarantees
// across processes — the `done` cache becomes a shared row keyed by (scope,key), and the in-flight
// join becomes a distributed lock (e.g. SET NX PX with a fencing token) so a duplicate landing on
// another node also waits instead of double-executing. The in-process Map below only gates one node.
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly done = new Map<string, unknown>()
  private readonly inFlight = new Map<string, Promise<unknown>>()

  private composite(scope: string, key: string): string {
    return `${scope}::${key}`
  }

  async execute<T>(scope: string, key: string, fn: () => Promise<T>): Promise<T> {
    const id = this.composite(scope, key)

    // (1) Already settled → return the cached response without re-running the side effect.
    if (this.done.has(id)) {
      return this.done.get(id) as T
    }

    // (2) Already running → join the single in-flight execution. A concurrent retry (even under a
    // different transport key that resolved to the same scope/key) observes the same outcome and
    // never invokes fn a second time.
    const pending = this.inFlight.get(id)
    if (pending) {
      return (await pending) as T
    }

    // First caller for this key: run fn exactly once, caching the result only on success.
    const run = (async () => {
      const result = await fn()
      this.done.set(id, result)
      return result
    })()
    this.inFlight.set(id, run)
    try {
      return (await run) as T
    } finally {
      // (3) Release the in-flight slot. On success the `done` cache now serves future calls; on
      // failure nothing was cached, so the key is free for a legitimate retry.
      this.inFlight.delete(id)
    }
  }
}
