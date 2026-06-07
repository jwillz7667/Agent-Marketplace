import Big from 'big.js'
import type { Money } from '../../../domain/index'
import { newHoldId } from '../../../domain/index'
import type {
  Clock,
  SpendUsage,
  ValueTransferPort,
  WalletBalanceRow,
  WalletQueryPort,
  UsagePort,
} from '../../../shared/ports/index'
import { ConflictError, NotFoundError, PaymentRequiredError, ValidationError } from '../../../shared/errors'
import type { HoldRepo, SpendRepo, SpendRow, WalletRepo } from './repo'
import { walletRowToBalance } from './repo'

export interface WalletServiceDeps {
  readonly clock: Clock
  readonly wallets: WalletRepo
  readonly holds: HoldRepo
  readonly spends: SpendRepo
}

const assertPositive = (amount: Money): void => {
  let big: Big
  try {
    big = new Big(amount.amount)
  } catch {
    throw new ValidationError(`invalid amount: ${amount.amount}`)
  }
  if (big.lte(0)) throw new ValidationError(`amount must be positive: ${amount.amount}`)
}

// UTC start-of-day bucket key (YYYY-MM-DD) derived from the clock, so dailySpent resets at the
// UTC day boundary without any wall-clock dependency inside the service.
const utcDayBucket = (clock: Clock): string => new Date(clock.nowMs()).toISOString().slice(0, 10)

// The internal value store (§4.3 wallet) and the substrate every rail moves value over. It owns
// the per-(did,currency) {available, held} split and the holds that escrow/stake/forfeit act on.
// All arithmetic is big.js string-decimal so there is never float drift on value.
//
// Concurrency: a read-modify-write on a wallet row must be atomic w.r.t. other transfers on the
// same wallet. We serialize per (did,currency) through an in-process promise chain so two
// concurrent debits cannot both read the same `available` and double-spend it. A transfer that
// touches two wallets (capture/forfeit/transfer) acquires both keys in a stable order to avoid
// deadlock. In a multi-process deployment the Prisma adapter would use a row lock / SELECT FOR
// UPDATE instead; the service contract is identical.
export class WalletService implements ValueTransferPort, WalletQueryPort, UsagePort {
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: WalletServiceDeps) {}

  private async withLock<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort()
    // Chain onto the tail of every involved key's queue so the critical section waits for all
    // in-flight work on those keys, then publishes itself as the new tail for each.
    const prior = Promise.all(ordered.map((k) => this.locks.get(k) ?? Promise.resolve()))
    const run = prior.then(fn)
    const guard = run.catch(() => undefined)
    for (const k of ordered) this.locks.set(k, guard)
    try {
      return await run
    } finally {
      for (const k of ordered) {
        if (this.locks.get(k) === guard) this.locks.delete(k)
      }
    }
  }

  private static key(did: string, currency: string): string {
    return `${did}::${currency}`
  }

  async balanceOf(did: string, currency: string): Promise<Money> {
    const row = await this.deps.wallets.get(did, currency)
    return { amount: row?.available ?? '0', currency }
  }

  async credit(did: string, amount: Money, _ref: string): Promise<void> {
    assertPositive(amount)
    await this.withLock([WalletService.key(did, amount.currency)], async () => {
      const row = await this.deps.wallets.getOrCreate(did, amount.currency)
      row.available = new Big(row.available).plus(amount.amount).toString()
      await this.deps.wallets.put(row)
    })
  }

  async debit(did: string, amount: Money, _ref: string): Promise<void> {
    assertPositive(amount)
    await this.withLock([WalletService.key(did, amount.currency)], async () => {
      const row = await this.deps.wallets.getOrCreate(did, amount.currency)
      if (new Big(row.available).lt(amount.amount)) {
        throw new PaymentRequiredError(`insufficient available balance for ${did}`, {
          details: { did, currency: amount.currency, available: row.available, requested: amount.amount },
        })
      }
      row.available = new Big(row.available).minus(amount.amount).toString()
      await this.deps.wallets.put(row)
    })
  }

  // Move available → held, returning a holdId. The settlement transfer (capture) later moves the
  // held amount to the recipient; release returns it; forfeit slashes it.
  async hold(did: string, amount: Money, ref: string): Promise<string> {
    assertPositive(amount)
    return this.withLock([WalletService.key(did, amount.currency)], async () => {
      const row = await this.deps.wallets.getOrCreate(did, amount.currency)
      if (new Big(row.available).lt(amount.amount)) {
        throw new PaymentRequiredError(`insufficient available balance to hold for ${did}`, {
          details: { did, currency: amount.currency, available: row.available, requested: amount.amount },
        })
      }
      row.available = new Big(row.available).minus(amount.amount).toString()
      row.held = new Big(row.held).plus(amount.amount).toString()
      await this.deps.wallets.put(row)

      const holdId = newHoldId()
      await this.deps.holds.put({
        holdId,
        did,
        amount: amount.amount,
        currency: amount.currency,
        ref,
        state: 'active',
        createdAt: this.deps.clock.now(),
      })
      return holdId
    })
  }

  async release(holdId: string): Promise<void> {
    const h = await this.deps.holds.get(holdId)
    if (!h) throw new NotFoundError(`hold not found: ${holdId}`)
    if (h.state !== 'active') throw new ConflictError(`hold ${holdId} is not active (state=${h.state})`)
    await this.withLock([WalletService.key(h.did, h.currency)], async () => {
      const row = await this.deps.wallets.getOrCreate(h.did, h.currency)
      row.held = new Big(row.held).minus(h.amount).toString()
      row.available = new Big(row.available).plus(h.amount).toString()
      await this.deps.wallets.put(row)
      h.state = 'released'
      await this.deps.holds.put(h)
    })
  }

  // The settlement transfer: held funds on the payer become available funds for the recipient.
  async capture(holdId: string, to: string): Promise<void> {
    const h = await this.deps.holds.get(holdId)
    if (!h) throw new NotFoundError(`hold not found: ${holdId}`)
    if (h.state !== 'active') throw new ConflictError(`hold ${holdId} is not active (state=${h.state})`)
    await this.withLock([WalletService.key(h.did, h.currency), WalletService.key(to, h.currency)], async () => {
      const from = await this.deps.wallets.getOrCreate(h.did, h.currency)
      from.held = new Big(from.held).minus(h.amount).toString()
      await this.deps.wallets.put(from)
      const recipient = await this.deps.wallets.getOrCreate(to, h.currency)
      recipient.available = new Big(recipient.available).plus(h.amount).toString()
      await this.deps.wallets.put(recipient)
      h.state = 'captured'
      await this.deps.holds.put(h)
    })
  }

  // Slashing: held funds are taken from the payer and either credited to a recipient and/or
  // burned. `split` lets a dispute send part to the wronged party and burn the rest; with no
  // split the whole hold is burned. burnFraction ∈ [0,1] of the held amount is destroyed.
  async forfeit(holdId: string, split?: { toRecipient: string; burnFraction: number }): Promise<void> {
    const h = await this.deps.holds.get(holdId)
    if (!h) throw new NotFoundError(`hold not found: ${holdId}`)
    if (h.state !== 'active') throw new ConflictError(`hold ${holdId} is not active (state=${h.state})`)

    const burnFraction = split ? split.burnFraction : 1
    if (burnFraction < 0 || burnFraction > 1) {
      throw new ValidationError(`burnFraction must be within [0,1]: ${burnFraction}`)
    }
    const total = new Big(h.amount)
    const burned = total.times(burnFraction)
    const toRecipientAmount = total.minus(burned)

    const keys = [WalletService.key(h.did, h.currency)]
    if (split && toRecipientAmount.gt(0)) keys.push(WalletService.key(split.toRecipient, h.currency))

    await this.withLock(keys, async () => {
      const from = await this.deps.wallets.getOrCreate(h.did, h.currency)
      from.held = new Big(from.held).minus(h.amount).toString()
      await this.deps.wallets.put(from)
      if (split && toRecipientAmount.gt(0)) {
        const recipient = await this.deps.wallets.getOrCreate(split.toRecipient, h.currency)
        recipient.available = new Big(recipient.available).plus(toRecipientAmount.toString()).toString()
        await this.deps.wallets.put(recipient)
      }
      // Burned value is simply removed from `held` and credited nowhere — it leaves the system.
      h.state = 'forfeited'
      await this.deps.holds.put(h)
    })
  }

  // WalletQueryPort — for governance/audit (§12). Lists every currency row a DID holds.
  async balances(did: string): Promise<WalletBalanceRow[]> {
    const rows = await this.deps.wallets.listByDid(did)
    return rows.map((r) => {
      const b = walletRowToBalance(r)
      return { currency: r.currency, available: b.available, held: b.held }
    })
  }

  // UsagePort — what policy reads to enforce daily/total caps (§4.3). Sourced from the internal
  // accumulator kept in sync on each settle (authoritative + fast), NOT recomputed from the
  // ledger: the accumulator updates inside the same settle critical section so it always reflects
  // already-settled charges. dailySpent is the accumulator's value only when the stored bucket is
  // the current UTC day, else it has rolled over to a new day and reads as zero.
  async usage(did: string): Promise<SpendUsage> {
    // Spend is denominated in the default currency the caps apply to. We aggregate the lifetime
    // total across currencies' rows is not meaningful, so usage reports the primary spend
    // currency row. Policy caps and quotes are same-currency, so we report per the row that
    // exists; with a single settlement currency (USDC) there is exactly one row.
    const rows = await this.allSpendRows(did)
    const today = utcDayBucket(this.deps.clock)
    // Sum totals across currencies into the first currency seen; in the single-currency
    // deployment this is exactly the USDC row. If no spend yet, return zero in USDC.
    if (rows.length === 0) {
      return { dailySpent: { amount: '0', currency: 'USDC' }, totalSpent: { amount: '0', currency: 'USDC' } }
    }
    const currency = rows[0]!.currency
    let total = new Big(0)
    let daily = new Big(0)
    for (const r of rows) {
      if (r.currency !== currency) continue
      total = total.plus(r.total)
      if (r.dailyBucket === today) daily = daily.plus(r.dailyAmount)
    }
    return {
      dailySpent: { amount: daily.toString(), currency },
      totalSpent: { amount: total.toString(), currency },
    }
  }

  // Record a settled spend against the payer's accumulator. Called by the facilitator/escrow
  // inside the settle path AFTER value has moved, so usage() reflects it immediately. Rolls the
  // daily bucket forward when the UTC day has changed.
  async recordSpend(did: string, amount: Money): Promise<void> {
    assertPositive(amount)
    const today = utcDayBucket(this.deps.clock)
    await this.withLock([`spend::${did}::${amount.currency}`], async () => {
      const row = await this.deps.spends.getOrCreate(did, amount.currency)
      const next: typeof row = {
        ...row,
        total: new Big(row.total).plus(amount.amount).toString(),
        dailyBucket: today,
        dailyAmount:
          row.dailyBucket === today
            ? new Big(row.dailyAmount).plus(amount.amount).toString()
            : amount.amount,
      }
      await this.deps.spends.put(next)
    })
  }

  private async allSpendRows(did: string): Promise<SpendRow[]> {
    // The spend repo is keyed by (did,currency); the single settlement currency means at most one
    // row. We fetch the default-currency row directly and return it if present.
    const usdc = await this.deps.spends.get(did, 'USDC')
    return usdc ? [usdc] : []
  }
}
