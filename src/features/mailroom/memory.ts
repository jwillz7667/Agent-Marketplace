import Big from 'big.js'
import type { Message } from '../../domain/index'
import type {
  FlagRepo,
  MessageRepo,
  PostageRepo,
  StoredMessage,
  ThreadRecord,
  ThreadRepo,
  WebhookRecord,
  WebhookRepo,
} from './repo'

// In-memory adapters for the mailroom repos. State lives in Maps/arrays; no I/O. Single-process
// only — the container swaps these for Prisma-backed implementations in production.

export class MemoryMessageRepo implements MessageRepo {
  private readonly log: StoredMessage[] = []
  private readonly byId = new Map<string, StoredMessage>()
  // Per-recipient cursor index so inbox reads stay O(matches) rather than scanning the log.
  private readonly byRecipient = new Map<string, StoredMessage[]>()
  private nextCursor = 1

  async append(message: Message): Promise<number> {
    const cursor = this.nextCursor++
    const stored: StoredMessage = { cursor, message }
    this.log.push(stored)
    this.byId.set(message.msg_id, stored)
    const bucket = this.byRecipient.get(message.to)
    if (bucket) bucket.push(stored)
    else this.byRecipient.set(message.to, [stored])
    return cursor
  }

  async get(msgId: string): Promise<StoredMessage | null> {
    return this.byId.get(msgId) ?? null
  }

  async inbox(recipient: string, since: number, limit: number): Promise<StoredMessage[]> {
    const bucket = this.byRecipient.get(recipient) ?? []
    // bucket is already cursor-ascending (append order); filter then cap.
    const out: StoredMessage[] = []
    for (const s of bucket) {
      if (s.cursor > since) {
        out.push(s)
        if (out.length >= limit) break
      }
    }
    return out
  }
}

export class MemoryThreadRepo implements ThreadRepo {
  private readonly byId = new Map<string, ThreadRecord>()

  async get(threadId: string): Promise<ThreadRecord | null> {
    return this.byId.get(threadId) ?? null
  }

  async put(record: ThreadRecord): Promise<void> {
    this.byId.set(record.thread_id, record)
  }
}

export class MemoryPostageRepo implements PostageRepo {
  // key: `${sender}::${utcDay}` -> accumulated decimal string.
  private readonly totals = new Map<string, string>()

  private key(sender: string, utcDay: string): string {
    return `${sender}::${utcDay}`
  }

  async spentOnDay(sender: string, utcDay: string): Promise<string> {
    return this.totals.get(this.key(sender, utcDay)) ?? '0'
  }

  async recordHold(sender: string, utcDay: string, amount: string): Promise<void> {
    const k = this.key(sender, utcDay)
    const current = this.totals.get(k) ?? '0'
    this.totals.set(k, new Big(current).plus(amount).toString())
  }
}

export class MemoryWebhookRepo implements WebhookRepo {
  private readonly byOwner = new Map<string, WebhookRecord[]>()

  async put(record: WebhookRecord): Promise<void> {
    const bucket = this.byOwner.get(record.owner)
    if (bucket) bucket.push(record)
    else this.byOwner.set(record.owner, [record])
  }

  async listByOwner(owner: string): Promise<WebhookRecord[]> {
    return this.byOwner.get(owner) ?? []
  }
}

export class MemoryFlagRepo implements FlagRepo {
  private readonly byMsg = new Map<string, 'released' | 'forfeited'>()

  async outcome(msgId: string): Promise<'released' | 'forfeited' | null> {
    return this.byMsg.get(msgId) ?? null
  }

  async record(msgId: string, outcome: 'released' | 'forfeited'): Promise<void> {
    this.byMsg.set(msgId, outcome)
  }
}
