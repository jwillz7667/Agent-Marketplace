import type { Message, ThreadState } from '../../domain/index'

// Persistence ports owned by the mailroom module. The factory constructs in-memory adapters
// by default; the container can swap Prisma-backed implementations without touching the
// service. Free-text fields inside a stored Message are never indexed for matching — only
// typed fields (recipient, cursor, thread) drive retrieval (§10.3).

// A stored message carries its server-assigned monotonic cursor alongside the signed object.
export interface StoredMessage {
  readonly cursor: number
  readonly message: Message
}

export interface MessageRepo {
  // Append a signed message, assigning the next global monotonic cursor. Returns the cursor.
  append(message: Message): Promise<number>
  get(msgId: string): Promise<StoredMessage | null>
  // Inbox for a recipient: messages with cursor > since, ascending, capped at limit.
  inbox(recipient: string, since: number, limit: number): Promise<StoredMessage[]>
}

// Thread state is derived from the signed message DAG (§7.3), but we persist the current
// derived state + the negotiated quote reference so an ACCEPT handoff (§7.5) can resolve the
// concrete (listing_ref, quote_id) without re-walking the whole chain on the hot path.
export interface ThreadRecord {
  readonly thread_id: string
  readonly state: ThreadState
  readonly opener: string
  readonly counterparty: string
  // The most recent QUOTE the thread negotiated to, captured when a QUOTE message lands.
  readonly negotiated_quote_id: string | null
  readonly listing_ref: string | null
  readonly updated_at: string
}

export interface ThreadRepo {
  get(threadId: string): Promise<ThreadRecord | null>
  put(record: ThreadRecord): Promise<void>
}

// Per-sender, per-UTC-day postage accounting (§7.4). Tracks the day's total holds so the
// daily cap (max_postage_per_day from the delegation messaging policy) is enforceable and
// so policy.evaluate can be fed an accurate SpendUsage.dailySpent.
export interface PostageRepo {
  // Sum of postage held by `sender` on the given UTC day (YYYY-MM-DD), as a decimal string.
  spentOnDay(sender: string, utcDay: string): Promise<string>
  // Record a hold against the sender's day total.
  recordHold(sender: string, utcDay: string, amount: string): Promise<void>
}

export interface WebhookRecord {
  readonly webhook_id: string
  readonly owner: string
  readonly url: string
  readonly registered_at: string
}

export interface WebhookRepo {
  put(record: WebhookRecord): Promise<void>
  listByOwner(owner: string): Promise<WebhookRecord[]>
}

// Idempotency guard for the flag endpoint: a message may be settled (released/forfeited)
// exactly once. Records the terminal flag outcome so a retry is a no-op.
export interface FlagRepo {
  outcome(msgId: string): Promise<'released' | 'forfeited' | null>
  record(msgId: string, outcome: 'released' | 'forfeited'): Promise<void>
}
