import type { Listing, Quote } from '../../domain/index'
import type { ListingRepo, QuoteRepo } from './repo'

// In-memory adapters for the registry repos. State lives in Maps; no I/O. Single-process
// only — the container swaps these for Prisma-backed implementations in production.

export class MemoryListingRepo implements ListingRepo {
  private readonly byId = new Map<string, Listing>()

  async get(listingId: string): Promise<Listing | null> {
    return this.byId.get(listingId) ?? null
  }

  async put(listing: Listing): Promise<void> {
    this.byId.set(listing.listing_id, listing)
  }

  async all(): Promise<Listing[]> {
    return [...this.byId.values()]
  }
}

export class MemoryQuoteRepo implements QuoteRepo {
  private readonly byId = new Map<string, Quote>()

  async get(quoteId: string): Promise<Quote | null> {
    return this.byId.get(quoteId) ?? null
  }

  async put(quote: Quote): Promise<void> {
    this.byId.set(quote.quote_id, quote)
  }
}
