import type { Quote } from '../../../domain/index'
import type { EscrowRecord, EscrowRepo, QuoteBindRepo, StakeRepo, StakeRow } from './repo'

// In-memory adapters for the escrow repos. State lives in Maps; no I/O. Single-process only.

export class MemoryEscrowRepo implements EscrowRepo {
  private readonly byId = new Map<string, EscrowRecord>()

  async get(escrowId: string): Promise<EscrowRecord | null> {
    return this.byId.get(escrowId) ?? null
  }

  async put(record: EscrowRecord): Promise<void> {
    this.byId.set(record.contract.escrow_id, record)
  }

  async getByJobRef(jobRef: string): Promise<EscrowRecord[]> {
    return [...this.byId.values()].filter((r) => r.contract.job_ref === jobRef)
  }
}

export class MemoryQuoteBindRepo implements QuoteBindRepo {
  private readonly byId = new Map<string, Quote>()

  async get(quoteId: string): Promise<Quote | null> {
    return this.byId.get(quoteId) ?? null
  }

  async put(quote: Quote): Promise<void> {
    this.byId.set(quote.quote_id, quote)
  }
}

export class MemoryStakeRepo implements StakeRepo {
  private readonly byId = new Map<string, StakeRow>()

  async get(stakeId: string): Promise<StakeRow | null> {
    return this.byId.get(stakeId) ?? null
  }

  async put(row: StakeRow): Promise<void> {
    this.byId.set(row.stakeId, row)
  }

  async listByDid(did: string): Promise<StakeRow[]> {
    return [...this.byId.values()].filter((r) => r.did === did)
  }
}
