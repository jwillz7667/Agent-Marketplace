import Big from 'big.js'

// Money is a string-decimal amount + currency, mirroring the spec wire format exactly.
// All arithmetic goes through big.js so there is never binary-float drift on value.

export interface Money {
  readonly amount: string
  readonly currency: string
}

export const DEFAULT_CURRENCY = 'USDC'

export const mZero = (currency: string = DEFAULT_CURRENCY): Money => ({ amount: '0', currency })

export const mFromString = (amount: string, currency: string = DEFAULT_CURRENCY): Money => {
  if (!mIsValidAmount(amount)) throw new Error(`invalid money amount: ${amount}`)
  return { amount: new Big(amount).toString(), currency }
}

export const mIsValidAmount = (amount: string): boolean => {
  try {
    // Reject negatives at construction; value movement uses explicit sign-aware ops.
    return new Big(amount).gte(0)
  } catch {
    return false
  }
}

export const mIsValid = (m: Money): boolean =>
  typeof m?.amount === 'string' && typeof m?.currency === 'string' && mIsValidAmount(m.amount)

const assertSameCurrency = (a: Money, b: Money): void => {
  if (a.currency !== b.currency) throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`)
}

export const mAdd = (a: Money, b: Money): Money => {
  assertSameCurrency(a, b)
  return { amount: new Big(a.amount).plus(b.amount).toString(), currency: a.currency }
}

export const mSub = (a: Money, b: Money): Money => {
  assertSameCurrency(a, b)
  return { amount: new Big(a.amount).minus(b.amount).toString(), currency: a.currency }
}

export const mMul = (a: Money, factor: string | number): Money => ({
  amount: new Big(a.amount).times(factor).toString(),
  currency: a.currency,
})

// -1 if a<b, 0 if equal, 1 if a>b.
export const mCmp = (a: Money, b: Money): -1 | 0 | 1 => {
  assertSameCurrency(a, b)
  return new Big(a.amount).cmp(b.amount) as -1 | 0 | 1
}

export const mGte = (a: Money, b: Money): boolean => mCmp(a, b) >= 0
export const mGt = (a: Money, b: Money): boolean => mCmp(a, b) > 0
export const mLte = (a: Money, b: Money): boolean => mCmp(a, b) <= 0
export const mLt = (a: Money, b: Money): boolean => mCmp(a, b) < 0
export const mEq = (a: Money, b: Money): boolean => mCmp(a, b) === 0
export const mIsZero = (a: Money): boolean => new Big(a.amount).eq(0)

export const mToString = (m: Money): string => `${new Big(m.amount).toString()} ${m.currency}`

export const mToNumber = (m: Money): number => Number(m.amount)
