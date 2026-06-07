import type { Money } from './money'

// Receipt (§11) — signed settled-transaction record, the reputation primitive.

export type ReceiptOutcome = 'delivered' | 'refunded' | 'partial' | 'disputed'

export interface Receipt {
  readonly receipt_id: string
  readonly quote_id: string | null
  readonly listing_id: string | null
  readonly listing_version: string | null
  readonly job_ref?: string | null
  readonly payer: string
  readonly payee: string
  readonly amount: Money
  readonly rail: string
  readonly result_hash: string // "sha256:…" binds the receipt to the delivered result
  readonly latency_ms: number
  readonly outcome: ReceiptOutcome
  readonly settled_at: string
  readonly facilitator_sig: string
  readonly payee_sig: string
}
