import type { Listing, Quote } from '../../domain/index'

// Persistence ports owned by the registry module. The factory constructs the in-memory
// adapters by default; the container can swap a Prisma-backed pair without touching the
// service. Listings are keyed by listing_id; quotes are stored so a later bind/settle can
// resolve the exact signed quote the registry issued.

export interface ListingRepo {
  get(listingId: string): Promise<Listing | null>
  put(listing: Listing): Promise<void>
  all(): Promise<Listing[]>
}

export interface QuoteRepo {
  get(quoteId: string): Promise<Quote | null>
  put(quote: Quote): Promise<void>
}
