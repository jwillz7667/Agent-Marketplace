import type { Clock } from '../ports/index'

export type { Clock }

// Production clock, backed by the runtime wall clock.
export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString()
  }
  nowMs(): number {
    return Date.now()
  }
}

// Deterministic clock for tests; advanceable so freshness/expiry windows can be exercised.
export class FixedClock implements Clock {
  private current: number

  constructor(seedIso: string = '2026-06-06T15:00:00.000Z') {
    this.current = new Date(seedIso).getTime()
  }

  now(): string {
    return new Date(this.current).toISOString()
  }
  nowMs(): number {
    return this.current
  }
  advance(ms: number): void {
    this.current += ms
  }
  set(iso: string): void {
    this.current = new Date(iso).getTime()
  }
}
