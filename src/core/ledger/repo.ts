import type { LedgerEntry } from '../../shared/ports/index'

// Persistence port for the append-only Receipt Ledger (§11). The store is strictly
// append-only: it exposes appendEntry/all/last but NO update or delete. The service
// owns hash-chain construction; the repo only persists fully-formed entries in seq
// order. A Prisma adapter can replace memory.ts without touching the service, as long
// as it preserves the no-mutation contract (e.g. an INSERT-only table, no UPDATE/DELETE).

export interface LedgerRepo {
  // Persist a fully-formed entry. The service guarantees seq is the next in sequence
  // and the hash chain links to the prior entry; the repo just stores it.
  appendEntry(entry: LedgerEntry): Promise<void>
  // The single most recent entry, or null if the ledger is empty (genesis state).
  last(): Promise<LedgerEntry | null>
  // All entries in ascending seq order. Used for chain verification and Merkle anchoring.
  all(): Promise<LedgerEntry[]>
}
