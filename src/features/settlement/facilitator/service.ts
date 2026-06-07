import type {
  PaymentPayload,
  PaymentRequirements,
  Quote,
  Receipt,
  Money,
} from '../../../domain/index'
import { newReceiptId, quoteIsExpired } from '../../../domain/index'
import { signDetached, sha256Tagged, canonicalize } from '../../../shared/crypto/index'
import type {
  ApprovalPort,
  Clock,
  IdempotencyStore,
  IdentityResolver,
  Ledger,
  NonceStore,
  RailRegistry,
  ReputationPort,
  WalletSigner,
} from '../../../shared/ports/index'
import { verifySignedObject, withIdempotency } from '../../../shared/http/index'
import {
  AuthError,
  ForbiddenError,
  PaymentRequiredError,
  ValidationError,
} from '../../../shared/errors'
import { getRailOrThrow } from '../../../infrastructure/rail/index'
import type { CoreSigner } from '../core-signer'
import type { WalletService } from '../wallet/index'
import type { PayBody } from './schema'

export interface FacilitatorDeps {
  readonly clock: Clock
  readonly nonces: NonceStore
  readonly idempotency: IdempotencyStore
  readonly identity: IdentityResolver
  readonly signer: WalletSigner
  readonly ledger: Ledger
  readonly reputation: ReputationPort
  readonly approvals: ApprovalPort
  readonly rails: RailRegistry
  readonly wallet: WalletService // for the spend accumulator update (UsagePort source)
  readonly coreSigner: CoreSigner // the facilitator's signing identity
  readonly registrySignerDid: string // the registry core DID that signs quotes
  readonly skewMs: number
  readonly facilitatorUrl: string
}

// Result of POST /pay/:listingId. A first call (no payment) yields 402 requirements; a payment
// that needs principal approval is parked; a settled payment yields the signed receipt. The route
// translates each variant into the right HTTP status.
export type PayOutcome =
  | { kind: 'requirements'; requirements: PaymentRequirements }
  | { kind: 'needs_approval'; approvalId: string; threshold: Money; reasons: string[] }
  | { kind: 'receipt'; receipt: Receipt }

// The fields stripped before the facilitator signs / the payee co-signs a receipt. Symmetric with
// any verifier that recomputes the receipt signing input.
const RECEIPT_SIG_OMIT = ['facilitator_sig', 'payee_sig'] as const

export class FacilitatorService {
  private readonly envDeps: { identity: IdentityResolver; nonces: NonceStore; clock: Clock; skewMs: number }

  constructor(private readonly deps: FacilitatorDeps) {
    this.envDeps = {
      identity: deps.identity,
      nonces: deps.nonces,
      clock: deps.clock,
      skewMs: deps.skewMs,
    }
  }

  // POST /pay/:listingId — the atomic x402 handshake (§5.3, §14.3).
  async pay(listingId: string, idempotencyKey: string | undefined, body: PayBody): Promise<PayOutcome> {
    const quote = body.quote as Quote
    await this.validateQuote(quote, listingId)

    // First call (no PAYMENT-SIGNATURE) → 402 with PaymentRequirements (§5.3 step 2). The nonce
    // here is the quote_id-scoped requirements nonce; the agent echoes a fresh payload nonce later.
    if (!body.payment) {
      const requirements = this.buildRequirements(quote, body.payee)
      return { kind: 'requirements', requirements }
    }

    // Second call (PAYMENT-SIGNATURE present) requires an Idempotency-Key so a retry is safe.
    if (!idempotencyKey || idempotencyKey.length === 0) {
      throw new ValidationError('Idempotency-Key header is required to settle a payment')
    }

    const payment = body.payment as PaymentPayload
    this.assertPayloadConsistent(quote, payment, body.payee)

    // Idempotency tie (§6.1): payment AND result are bound by Idempotency-Key + quote_id, so a
    // retried call returns the SAME receipt and never double-charges, and a settled-but-undelivered
    // state is detectable by replaying this exact scope.
    const scope = 'pay'
    const idemKey = `${idempotencyKey}:${quote.quote_id}`
    const receipt = await withIdempotency(this.deps.idempotency, scope, idemKey, () =>
      this.settle(quote, payment, body.payee, body.result, body.approval_id),
    )

    // A parked-for-approval settle short-circuits before any money moves; surface it as such.
    if (isParked(receipt)) {
      return { kind: 'needs_approval', approvalId: receipt.approvalId, threshold: receipt.threshold, reasons: receipt.reasons }
    }
    return { kind: 'receipt', receipt }
  }

  // ---- internals --------------------------------------------------------

  // Verify the registry's core signature over the quote and that it binds this listing + is fresh.
  private async validateQuote(quote: Quote, listingId: string): Promise<void> {
    if (quote.listing_id !== listingId) {
      throw new ValidationError(`quote ${quote.quote_id} does not bind listing ${listingId}`)
    }
    if (quoteIsExpired(quote, this.deps.clock.now())) {
      throw new PaymentRequiredError(`quote ${quote.quote_id} has expired`, {
        details: { quote_id: quote.quote_id, expires: quote.expires },
      })
    }
    // The quote has no nonce/exp envelope of its own (its freshness is `expires`), so verify the
    // detached registry signature directly with skipNonce; the issued/expires guard above is the
    // freshness check.
    await verifySignedObject(this.envDeps, quote as unknown as Record<string, unknown>, {
      signerDid: this.deps.registrySignerDid,
      skipNonce: true,
    })
  }

  private buildRequirements(quote: Quote, payee: string): PaymentRequirements {
    return {
      scheme: 'exact',
      rail: quote.rail,
      network: 'praxis-internal',
      asset: quote.price.currency,
      amount: quote.price.amount,
      pay_to: payee,
      quote_id: quote.quote_id,
      nonce: `req:${quote.quote_id}`,
      expires: quote.expires,
      facilitator: this.deps.facilitatorUrl,
    }
  }

  // Cheap shape checks before doing crypto: the payload must agree with the quote it claims to pay.
  private assertPayloadConsistent(quote: Quote, payment: PaymentPayload, payee: string): void {
    if (payment.quote_id !== quote.quote_id) throw new ValidationError('payment.quote_id does not match quote')
    if (payment.to !== payee) throw new ValidationError('payment.to does not match payee')
    if (payment.currency !== quote.price.currency) throw new ValidationError('payment currency mismatch')
    if (payment.amount !== quote.price.amount) throw new ValidationError('payment amount does not match quoted price')
    if (payment.rail !== quote.rail) throw new ValidationError('payment rail does not match quoted rail')
  }

  // The settle path, run exactly once per (Idempotency-Key, quote_id). Returns either a signed
  // receipt or a parked-approval marker (the idempotency cache stores whichever it returns).
  private async settle(
    quote: Quote,
    payment: PaymentPayload,
    payee: string,
    result: unknown,
    approvalId: string | undefined,
  ): Promise<Receipt | Parked> {
    const payer = payment.from
    const startMs = this.deps.clock.nowMs()

    // Verify the agent's signature over the payload (freshness + single-use nonce + JWS). This
    // proves the payer authorized THIS exact payment object.
    await verifySignedObject(this.envDeps, payment as unknown as Record<string, unknown>, {
      signerDid: payer,
    })

    const amount: Money = { amount: payment.amount, currency: payment.currency }

    // §4.3 HARD STOP — policy is enforced BELOW the agent, at the signing boundary, BEFORE any
    // money moves. The signer independently refuses an out-of-policy signature even if a pre-flight
    // check was bypassed; a hijacked/rogue agent cannot exceed its delegated caps (the critical
    // backstop against prompt injection, §15.8). We only proceed to settle on { ok: true }. When the
    // call carries an approval_id (an over-threshold spend the principal cleared), the signer redeems
    // it single-use here — so the cleared payment runs exactly once and cannot be replayed past the
    // cap. The approval is consumed at signing; a settlement failure afterward requires a fresh
    // approval (we prioritize the single-use guarantee over retry-friendliness).
    const signed = await this.deps.signer.signWithinPolicy({
      did: payer,
      payload: payment,
      action: { kind: 'spend', agent: payer, amount, category: quote.listing_id, counterparty: payee },
      approvalId,
    })
    if (!signed.ok) {
      const decision = signed.decision
      if (decision.result === 'needs_approval') {
        // Park the call: enqueue for principal approval, do NOT charge. The agent polls the
        // approval id; on approval it re-submits and the payment proceeds.
        const pending = await this.deps.approvals.enqueue({
          agent: payer,
          action: { kind: 'spend', agent: payer, amount, category: quote.listing_id, counterparty: payee },
          payload: payment,
        })
        return { __parked: true, approvalId: pending.approvalId, threshold: decision.threshold, reasons: decision.reasons }
      }
      // Deny → out of policy (over-cap, denied counterparty/category). No money moves.
      throw new ForbiddenError('payment refused by signer policy', {
        details: { reasons: decision.result === 'deny' ? decision.reasons : [] },
      })
    }

    // Policy cleared. Resolve the rail and settle (verify → move value). Rail choice never leaks
    // into identity/receipt logic — only this registry lookup branches on the rail id.
    const requirements = this.buildRequirements(quote, payee)
    const rail = getRailOrThrow(this.deps.rails, quote.rail)
    const verified = await rail.verify(payment, requirements)
    if (!verified.ok) {
      throw new PaymentRequiredError(`payment verification failed: ${verified.reason ?? 'unknown'}`)
    }
    const settlement = await rail.settle(payment, requirements)

    // Issue the signed Receipt (§11). result_hash binds the receipt to the delivered result: when
    // the provider returned a result synchronously we hash its canonical form, otherwise we anchor
    // to the quote's canonical checksum (documented fallback — the provider can co-sign and supply
    // the true result hash out-of-band; here payee_sig is empty when not co-signed synchronously).
    const resultHash =
      result !== undefined ? sha256Tagged(canonicalize(result)) : sha256Tagged(canonicalize(quote))
    const latencyMs = Math.max(0, this.deps.clock.nowMs() - startMs)

    const unsigned: Omit<Receipt, 'facilitator_sig' | 'payee_sig'> = {
      receipt_id: newReceiptId(),
      quote_id: quote.quote_id,
      listing_id: quote.listing_id,
      listing_version: quote.listing_version,
      job_ref: null,
      payer,
      payee,
      amount,
      // The receipt records which rail settled (the resolved adapter's id). Nothing downstream
      // branches on it — this is the only place the rail id reaches the receipt.
      rail: rail.id,
      result_hash: resultHash,
      latency_ms: latencyMs,
      outcome: 'delivered',
      settled_at: settlement.settledAt,
    }
    const facilitatorSig = await signDetached(unsigned, this.deps.coreSigner.privateKey, this.deps.coreSigner.kid)
    const receipt: Receipt = { ...unsigned, facilitator_sig: facilitatorSig, payee_sig: '' }

    // Append to the append-only ledger, ingest into reputation, and record the payer's settled
    // spend so UsagePort reflects it immediately for the next policy check.
    await this.deps.ledger.append({ kind: 'receipt', subject: payee, payload: receipt })
    await this.deps.reputation.ingestReceipt(receipt)
    await this.deps.wallet.recordSpend(payer, amount)

    return receipt
  }
}

// Internal marker returned by settle() when the call is parked for approval. It is cached by the
// idempotency store like any other settle result, so re-submitting the same key returns the same
// parked state until the approval resolves and the agent submits afresh.
interface Parked {
  readonly __parked: true
  readonly approvalId: string
  readonly threshold: Money
  readonly reasons: string[]
}

const isParked = (v: Receipt | Parked): v is Parked => (v as Parked).__parked === true

// Receipt sign-omit list is exported for symmetric verification by consumers.
export { RECEIPT_SIG_OMIT }
