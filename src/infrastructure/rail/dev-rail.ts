import Big from 'big.js'
import type { PaymentPayload, PaymentRequirements } from '../../domain/index'
import type { Rail, SettlementResult, ValueTransferPort, VerifyResult, Clock } from '../../shared/ports/index'
import { RailError } from '../../shared/errors'

export interface DevRailDeps {
  readonly clock: Clock
  readonly valueTransfer: ValueTransferPort
}

// DevRail — a pure-internal settlement rail. There is no external network: value moves directly
// between internal wallets. verify() confirms the payload's amount/currency/from/to agree with the
// requirements and that the payer actually holds the funds; settle() performs the transfer against
// the internal ledger (debit payer available, credit payee available) and returns a synthetic
// txRef. Nothing in identity/policy/receipt logic branches on this being the dev rail — the receipt
// merely records `rail: 'dev'`.
export class DevRail implements Rail {
  readonly id = 'dev'

  constructor(private readonly deps: DevRailDeps) {}

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResult> {
    if (payload.to !== req.pay_to) return { ok: false, reason: 'payee mismatch' }
    if (payload.quote_id !== req.quote_id) return { ok: false, reason: 'quote_id mismatch' }
    if (payload.currency !== req.asset) return { ok: false, reason: 'currency mismatch' }
    if (!amountsEqual(payload.amount, req.amount)) return { ok: false, reason: 'amount mismatch' }

    const balance = await this.deps.valueTransfer.balanceOf(payload.from, payload.currency)
    if (new Big(balance.amount).lt(payload.amount)) return { ok: false, reason: 'insufficient funds' }
    return { ok: true }
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettlementResult> {
    const verified = await this.verify(payload, req)
    if (!verified.ok) {
      throw new RailError(`dev rail refused settlement: ${verified.reason ?? 'verify failed'}`)
    }
    const ref = `dev:${payload.quote_id}:${payload.nonce}`
    // Atomic internal transfer: remove from payer's available, add to payee's available.
    await this.deps.valueTransfer.debit(payload.from, { amount: payload.amount, currency: payload.currency }, ref)
    await this.deps.valueTransfer.credit(payload.to, { amount: payload.amount, currency: payload.currency }, ref)
    return { ok: true, settledAt: this.deps.clock.now(), railRef: ref }
  }
}

const amountsEqual = (a: string, b: string): boolean => {
  try {
    return new Big(a).eq(b)
  } catch {
    return false
  }
}
