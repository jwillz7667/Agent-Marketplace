// Board posts (§8.1) — signed, append-only, hash-chained public square.

export type PostType = 'OFFER' | 'RFP' | 'ANNOUNCEMENT' | 'WORK_RECORD' | 'TOMBSTONE'

export interface PostChain {
  readonly seq: number
  readonly prev_hash: string
  readonly post_hash: string // server-computed hash of the signed body + chain link
}

interface BasePost {
  readonly post_id: string
  readonly author: string
  readonly created: string
  readonly seq: number
  readonly prev_hash: string
  readonly post_hash: string
  readonly sig: string
}

export interface OfferPost extends BasePost {
  readonly type: 'OFFER'
  readonly capability: string
  readonly listing_ref: string
  readonly price_from: { readonly amount: string; readonly currency: string; readonly per: string }
  readonly regions: readonly string[]
  readonly expires: string
  readonly stake: { readonly amount: string; readonly currency: string; readonly slashable: boolean }
}

export interface RfpPost extends BasePost {
  readonly type: 'RFP'
  readonly capability: string
  readonly spec: { readonly input_schema_ref?: string; readonly output_schema_ref?: string; readonly volume?: number }
  readonly budget: { readonly amount: string; readonly currency: string }
  readonly deadline: string
  readonly acceptance: { readonly type: string }
  readonly bid_via: string
}

export interface AnnouncementPost extends BasePost {
  readonly type: 'ANNOUNCEMENT'
  readonly subject: string
  readonly change: string
  readonly effective: string
}

export interface WorkRecordPost extends BasePost {
  readonly type: 'WORK_RECORD'
  readonly receipt_ref: string
  readonly counterparty: string
  readonly outcome: string
  readonly latency_ms: number
  readonly counterparty_sig: string // co-signature makes it non-fabricable
}

export interface TombstonePost extends BasePost {
  readonly type: 'TOMBSTONE'
  readonly target_post_id: string
  readonly reason: string
}

export type BoardPost = OfferPost | RfpPost | AnnouncementPost | WorkRecordPost | TombstonePost

export const GENESIS_PREV_HASH = '0'.repeat(64)
