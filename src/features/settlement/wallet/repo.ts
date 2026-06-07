import type { Money } from '../../../domain/index'

// Persistence ports owned by the wallet sub-feature. The factory constructs the in-memory
// adapters by default; the container can swap Prisma-backed pairs without touching the service.
//
// A wallet row is the per-(did, currency) balance split into available + held. A hold row
// is an earmark moved out of `available` into `held`, addressable by holdId, that later
// resolves to release (back to available), capture (to a recipient), or forfeit (slash).

export interface WalletRow {
  readonly did: string
  readonly currency: string
  available: string // big-decimal string
  held: string // big-decimal string
}

export type HoldState = 'active' | 'released' | 'captured' | 'forfeited'

export interface HoldRow {
  readonly holdId: string
  readonly did: string
  readonly amount: string
  readonly currency: string
  readonly ref: string
  state: HoldState
  readonly createdAt: string
}

export interface WalletRepo {
  get(did: string, currency: string): Promise<WalletRow | null>
  // Returns the row, creating a zeroed one if absent. Used under a per-key critical section.
  getOrCreate(did: string, currency: string): Promise<WalletRow>
  put(row: WalletRow): Promise<void>
  listByDid(did: string): Promise<WalletRow[]>
}

export interface HoldRepo {
  get(holdId: string): Promise<HoldRow | null>
  put(row: HoldRow): Promise<void>
}

// A per-payer spend accumulator. dailyKey is the UTC start-of-day bucket so dailySpent
// resets at the day boundary derived from the clock. This is the authoritative source the
// UsagePort reads — it reflects already-settled charges the instant a settle commits.
export interface SpendRow {
  readonly did: string
  readonly currency: string
  total: string // lifetime settled spend
  dailyBucket: string // YYYY-MM-DD (UTC) the dailyAmount belongs to
  dailyAmount: string // settled spend within dailyBucket
}

export interface SpendRepo {
  get(did: string, currency: string): Promise<SpendRow | null>
  getOrCreate(did: string, currency: string): Promise<SpendRow>
  put(row: SpendRow): Promise<void>
}

export const walletRowToBalance = (row: WalletRow): { available: Money; held: Money } => ({
  available: { amount: row.available, currency: row.currency },
  held: { amount: row.held, currency: row.currency },
})
