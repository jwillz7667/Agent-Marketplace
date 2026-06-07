import type { Clock, NonceStore } from '../../../shared/ports/index'

// In-memory single-use nonce store with lazy expiry pruning.
export class MemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>() // nonce -> exp epoch ms

  constructor(private readonly clock: Clock) {}

  async checkAndConsume(nonce: string, expISO: string): Promise<boolean> {
    const nowMs = this.clock.nowMs()
    this.prune(nowMs)

    const expMs = new Date(expISO).getTime()
    if (Number.isNaN(expMs) || expMs <= nowMs) return false // already expired
    if (this.seen.has(nonce)) return false // replay
    this.seen.set(nonce, expMs)
    return true
  }

  private prune(nowMs: number): void {
    for (const [nonce, exp] of this.seen) {
      if (exp <= nowMs) this.seen.delete(nonce)
    }
  }
}
