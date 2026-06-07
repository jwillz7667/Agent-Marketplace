import Big from 'big.js'
import type {
  Eip3009Authorization,
  PaymentPayload,
  PaymentRequirements,
} from '../../domain/index'
import type { Rail, SettlementResult, ValueTransferPort, VerifyResult, Clock } from '../../shared/ports/index'
import { RailError } from '../../shared/errors'

export interface X402RailDeps {
  readonly clock: Clock
  readonly valueTransfer: ValueTransferPort
}

// X402Rail — the x402-aligned crypto rail (§5.3, §13.1). It validates the EIP-3009
// transfer-with-authorization SHAPE: from/to/value present and well-formed, validBefore > now >
// validAfter, value === requirements.amount, to === requirements.pay_to, and the auth is bound to
// the payment nonce. On a live chain the facilitator would broadcast transferWithAuthorization and
// confirm the on-chain transfer; in THIS deployment we are our own facilitator, so after the auth
// is verified for shape + freshness we settle against the internal ledger exactly like the dev
// rail. The receipt records `rail: 'x402'` and nothing downstream branches on which rail ran.
export class X402Rail implements Rail {
  readonly id = 'x402'

  constructor(private readonly deps: X402RailDeps) {}

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResult> {
    if (payload.to !== req.pay_to) return { ok: false, reason: 'payee mismatch' }
    if (payload.quote_id !== req.quote_id) return { ok: false, reason: 'quote_id mismatch' }
    if (payload.currency !== req.asset) return { ok: false, reason: 'currency mismatch' }
    if (!amountsEqual(payload.amount, req.amount)) return { ok: false, reason: 'amount mismatch' }

    const auth = payload.authorization
    const shape = this.validateAuthShape(auth, payload, req)
    if (!shape.ok) return shape

    const balance = await this.deps.valueTransfer.balanceOf(payload.from, payload.currency)
    if (new Big(balance.amount).lt(payload.amount)) return { ok: false, reason: 'insufficient funds' }
    return { ok: true }
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettlementResult> {
    const verified = await this.verify(payload, req)
    if (!verified.ok) {
      // Malformed/expired authorizations are a rail-level failure (502 family per the error map).
      throw new RailError(`x402 rail refused settlement: ${verified.reason ?? 'verify failed'}`)
    }
    // The EIP-3009 nonce binds this settlement; the synthetic txRef stands in for the on-chain tx
    // hash a real facilitator would return after confirmation.
    const ref = `x402:${payload.authorization.nonce}`
    await this.deps.valueTransfer.debit(payload.from, { amount: payload.amount, currency: payload.currency }, ref)
    await this.deps.valueTransfer.credit(payload.to, { amount: payload.amount, currency: payload.currency }, ref)
    return { ok: true, settledAt: this.deps.clock.now(), railRef: ref }
  }

  // Validate the EIP-3009 authorization shape + time window against the requirements.
  private validateAuthShape(
    auth: Eip3009Authorization,
    payload: PaymentPayload,
    req: PaymentRequirements,
  ): VerifyResult {
    if (!isNonEmpty(auth.from) || !isNonEmpty(auth.to) || !isNonEmpty(auth.value)) {
      return { ok: false, reason: 'authorization missing from/to/value' }
    }
    if (!isNonEmpty(auth.nonce)) return { ok: false, reason: 'authorization missing nonce' }
    if (auth.from !== payload.from) return { ok: false, reason: 'authorization.from does not match payer' }
    if (auth.to !== req.pay_to) return { ok: false, reason: 'authorization.to does not match pay_to' }
    if (!amountsEqual(auth.value, req.amount)) return { ok: false, reason: 'authorization.value does not match amount' }

    const nowMs = this.deps.clock.nowMs()
    const after = new Date(auth.validAfter).getTime()
    const before = new Date(auth.validBefore).getTime()
    if (Number.isNaN(after) || Number.isNaN(before)) return { ok: false, reason: 'authorization time window malformed' }
    if (!(before > nowMs)) return { ok: false, reason: 'authorization expired (validBefore <= now)' }
    if (!(nowMs > after)) return { ok: false, reason: 'authorization not yet valid (validAfter >= now)' }
    return { ok: true }
  }
}

const amountsEqual = (a: string, b: string): boolean => {
  try {
    return new Big(a).eq(b)
  } catch {
    return false
  }
}

const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0
