// Message (§7.1) — signed, typed, asynchronous DM. The body schema is fixed per type
// so messages are machine-actionable, never free prose.

export type MessageType =
  | 'INQUIRY'
  | 'QUOTE_REQUEST'
  | 'QUOTE'
  | 'OFFER'
  | 'COUNTER'
  | 'ACCEPT'
  | 'REJECT'
  | 'DELEGATE'
  | 'STATUS'
  | 'RECEIPT_REF'

export type ThreadState = 'OPEN' | 'QUOTING' | 'OFFERED' | 'AGREED' | 'COMMITTED' | 'CLOSED'

export type RejectReason =
  | 'price_too_high'
  | 'out_of_capacity'
  | 'capability_mismatch'
  | 'deadline_infeasible'
  | 'policy_forbidden'
  | 'other'

export interface MessageRefs {
  readonly listing_ref?: string | null
  readonly quote_id?: string | null
  readonly job_ref?: string | null
}

export interface MessagePostage {
  readonly amount: string
  readonly currency: string
  readonly escrow_id: string
}

export interface Message {
  readonly msg_id: string
  readonly thread_id: string
  readonly in_reply_to: string | null
  readonly from: string
  readonly to: string
  readonly type: MessageType
  readonly body: Record<string, unknown> // validated per-type at the boundary
  readonly refs?: MessageRefs
  readonly postage?: MessagePostage
  readonly nonce: string
  readonly iat: string
  readonly exp: string
  readonly sig: string
}

export const isTerminalThreadState = (s: ThreadState): boolean => s === 'CLOSED'

// Thread state transition derived from the message type applied to the current state.
// Conversation state is a function of the signed message DAG, not mutable server state.
export const nextThreadState = (current: ThreadState, type: MessageType): ThreadState => {
  if (type === 'REJECT') return 'CLOSED'
  switch (current) {
    case 'OPEN':
      if (type === 'QUOTE_REQUEST' || type === 'INQUIRY') return 'QUOTING'
      if (type === 'OFFER' || type === 'QUOTE') return 'OFFERED'
      return current
    case 'QUOTING':
      if (type === 'QUOTE' || type === 'OFFER') return 'OFFERED'
      return current
    case 'OFFERED':
      if (type === 'COUNTER') return 'OFFERED'
      if (type === 'ACCEPT') return 'AGREED'
      return current
    case 'AGREED':
      if (type === 'STATUS' || type === 'RECEIPT_REF') return 'COMMITTED'
      return current
    case 'COMMITTED':
      if (type === 'RECEIPT_REF') return 'CLOSED'
      return current
    default:
      return current
  }
}
