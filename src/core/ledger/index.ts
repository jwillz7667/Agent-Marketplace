import type { Clock, Ledger } from '../../shared/ports/index'
import { LedgerService, GENESIS_PREV_HASH } from './ledger'
import { MemoryLedgerRepo } from './memory'
import type { LedgerRepo } from './repo'

// Public surface of the ledger module. The ledger has NO HTTP surface of its own
// (routes: null) — audit is exposed by the governance plane reading this `ledger` port
// (§11, §12). The container wires the returned `ledger` into other modules' deps.

export interface LedgerModule {
  ledger: Ledger
  routes: null
}

export interface LedgerDeps {
  clock: Clock
  // Optional pre-built repo (e.g. a Prisma-backed INSERT-only adapter). Defaults to the
  // in-memory append-only array.
  repo?: LedgerRepo
}

export const buildLedger = (deps: LedgerDeps): LedgerModule => {
  const repo = deps.repo ?? new MemoryLedgerRepo()
  const ledger = new LedgerService(repo, deps.clock)
  return { ledger, routes: null }
}

export { LedgerService, GENESIS_PREV_HASH } from './ledger'
export type { LedgerListFilter } from './ledger'
export { MemoryLedgerRepo } from './memory'
export type { LedgerRepo } from './repo'
