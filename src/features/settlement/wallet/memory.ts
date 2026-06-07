import type { HoldRepo, HoldRow, SpendRepo, SpendRow, WalletRepo, WalletRow } from './repo'

// In-memory adapters for the wallet repos. State lives in Maps; no I/O. Single-process only —
// the container swaps these for Prisma-backed implementations in production. The service
// serializes mutations per (did,currency) so the read-modify-write on a row is consistent
// without these adapters needing their own locking.

const walletKey = (did: string, currency: string): string => `${did}::${currency}`

export class MemoryWalletRepo implements WalletRepo {
  private readonly rows = new Map<string, WalletRow>()

  async get(did: string, currency: string): Promise<WalletRow | null> {
    return this.rows.get(walletKey(did, currency)) ?? null
  }

  async getOrCreate(did: string, currency: string): Promise<WalletRow> {
    const key = walletKey(did, currency)
    const existing = this.rows.get(key)
    if (existing) return existing
    const fresh: WalletRow = { did, currency, available: '0', held: '0' }
    this.rows.set(key, fresh)
    return fresh
  }

  async put(row: WalletRow): Promise<void> {
    this.rows.set(walletKey(row.did, row.currency), row)
  }

  async listByDid(did: string): Promise<WalletRow[]> {
    return [...this.rows.values()].filter((r) => r.did === did)
  }
}

export class MemoryHoldRepo implements HoldRepo {
  private readonly rows = new Map<string, HoldRow>()

  async get(holdId: string): Promise<HoldRow | null> {
    return this.rows.get(holdId) ?? null
  }

  async put(row: HoldRow): Promise<void> {
    this.rows.set(row.holdId, row)
  }
}

export class MemorySpendRepo implements SpendRepo {
  private readonly rows = new Map<string, SpendRow>()

  async get(did: string, currency: string): Promise<SpendRow | null> {
    return this.rows.get(walletKey(did, currency)) ?? null
  }

  async getOrCreate(did: string, currency: string): Promise<SpendRow> {
    const key = walletKey(did, currency)
    const existing = this.rows.get(key)
    if (existing) return existing
    const fresh: SpendRow = { did, currency, total: '0', dailyBucket: '', dailyAmount: '0' }
    this.rows.set(key, fresh)
    return fresh
  }

  async put(row: SpendRow): Promise<void> {
    this.rows.set(walletKey(row.did, row.currency), row)
  }
}
