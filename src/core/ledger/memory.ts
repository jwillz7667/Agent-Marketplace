import type { LedgerEntry } from '../../shared/ports/index'
import type { LedgerRepo } from './repo'

// In-memory append-only adapter for LedgerRepo. Entries live in a single array, pushed
// in seq order and never mutated or removed — the data structure itself models the
// "truly append-only" invariant (§11). Single-process only; the container swaps this
// for an INSERT-only persistent table in production.
//
// Each appended entry is frozen so a caller holding a reference cannot retroactively
// edit a record's payload after it has been chained.

export class MemoryLedgerRepo implements LedgerRepo {
  private readonly entries: LedgerEntry[] = []

  async appendEntry(entry: LedgerEntry): Promise<void> {
    this.entries.push(Object.freeze({ ...entry }))
  }

  async last(): Promise<LedgerEntry | null> {
    return this.entries[this.entries.length - 1] ?? null
  }

  async all(): Promise<LedgerEntry[]> {
    return [...this.entries]
  }
}
