// Quote (§5.2) — bound price. Void if the listing changes version.

export interface QuotePrice {
  readonly amount: string
  readonly currency: string
  readonly per: string
}

export interface Quote {
  readonly quote_id: string
  readonly listing_id: string
  readonly listing_version: string
  readonly price: QuotePrice
  readonly rail: string
  readonly requester: string
  readonly issued: string
  readonly expires: string // bind window
  readonly sig: string
}

export const quoteIsExpired = (q: Quote, nowIso: string): boolean =>
  new Date(q.expires).getTime() <= new Date(nowIso).getTime()

export const quoteMatchesListingVersion = (q: Quote, listingVersion: string): boolean =>
  q.listing_version === listingVersion
