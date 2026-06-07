import { ulid } from 'ulid'

// Prefixed, sortable identifiers. ULID gives lexicographic time-ordering.

export const ID_PREFIX = {
  listing: 'lst',
  quote: 'qt',
  receipt: 'rcp',
  message: 'msg',
  thread: 'thr',
  post: 'pst',
  escrow: 'esc',
  job: 'job',
  query: 'q',
  reputation: 'rep',
  approval: 'apr',
  postage: 'pst_e',
  hold: 'hold',
  webhook: 'wh',
  subscription: 'sub',
  stake: 'stk',
} as const

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX]

export const newId = (prefix: string): string => `${prefix}_${ulid()}`

export const newListingId = (): string => newId(ID_PREFIX.listing)
export const newQuoteId = (): string => newId(ID_PREFIX.quote)
export const newReceiptId = (): string => newId(ID_PREFIX.receipt)
export const newMessageId = (): string => newId(ID_PREFIX.message)
export const newThreadId = (): string => newId(ID_PREFIX.thread)
export const newPostId = (): string => newId(ID_PREFIX.post)
export const newEscrowId = (): string => newId(ID_PREFIX.escrow)
export const newJobId = (): string => newId(ID_PREFIX.job)
export const newQueryId = (): string => newId(ID_PREFIX.query)
export const newReputationId = (): string => newId(ID_PREFIX.reputation)
export const newApprovalId = (): string => newId(ID_PREFIX.approval)
export const newPostageId = (): string => newId(ID_PREFIX.postage)
export const newHoldId = (): string => newId(ID_PREFIX.hold)
export const newWebhookId = (): string => newId(ID_PREFIX.webhook)
export const newSubscriptionId = (): string => newId(ID_PREFIX.subscription)
export const newStakeId = (): string => newId(ID_PREFIX.stake)
