// x402-aligned payment handshake objects (§5.3).

export type PaymentScheme = 'exact' | 'upto' | 'stream'

export interface PaymentRequirements {
  readonly scheme: PaymentScheme
  readonly rail: string
  readonly network: string
  readonly asset: string
  readonly amount: string
  readonly pay_to: string // provider settlement DID/address
  readonly quote_id: string
  readonly nonce: string
  readonly expires: string
  readonly facilitator: string
}

// EIP-3009 transfer-with-authorization shape carried for the crypto rail.
export interface Eip3009Authorization {
  readonly from: string
  readonly to: string
  readonly value: string
  readonly validAfter: string
  readonly validBefore: string
  readonly nonce: string
}

export interface PaymentPayload {
  readonly scheme: PaymentScheme
  readonly rail: string
  readonly authorization: Eip3009Authorization
  readonly quote_id: string
  readonly from: string // payer agent DID
  readonly to: string // payee DID/address (mirrors requirements.pay_to)
  readonly amount: string
  readonly currency: string
  readonly nonce: string
  readonly iat: string
  // Expiry (RFC 3339). Required like every signed object (§13): bounds the single-use nonce's
  // validity so a captured payload cannot be replayed within the rail's authorization window even
  // under a fresh Idempotency-Key. Independent of (and tighter than) the EIP-3009 validBefore.
  readonly exp: string
  readonly sig: string
}
