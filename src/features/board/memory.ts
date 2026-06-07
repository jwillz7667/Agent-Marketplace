import type { BoardPost } from '../../domain/index'
import { ConflictError } from '../../shared/errors'
import type {
  ChainHead,
  FlagRecord,
  FlagRepo,
  PostRepo,
  Subscription,
  SubscriptionRepo,
} from './repo'

// In-memory adapters for the board repos. State lives in arrays/maps; no I/O. Single-process
// only — the container swaps these for Prisma-backed implementations in production.

// Append-only post log. Posts are stored in append order (which is seq order); there is no
// update/delete API, so a stored post is immutable by construction (§8.2).
export class MemoryPostRepo implements PostRepo {
  private readonly log: BoardPost[] = []
  private readonly byId = new Map<string, BoardPost>()
  private headRef: ChainHead | null = null

  async append(post: BoardPost): Promise<void> {
    if (this.byId.has(post.post_id)) {
      throw new ConflictError(`post already exists: ${post.post_id}`)
    }
    const expectedSeq = (this.headRef?.seq ?? 0) + 1
    if (post.seq !== expectedSeq) {
      throw new ConflictError(`seq gap: expected ${expectedSeq}, got ${post.seq}`)
    }
    this.log.push(post)
    this.byId.set(post.post_id, post)
    this.headRef = { seq: post.seq, post_hash: post.post_hash }
  }

  async get(postId: string): Promise<BoardPost | null> {
    return this.byId.get(postId) ?? null
  }

  async head(): Promise<ChainHead | null> {
    return this.headRef
  }

  async all(): Promise<BoardPost[]> {
    return [...this.log]
  }

  async hashes(): Promise<string[]> {
    return this.log.map((p) => p.post_hash)
  }
}

export class MemorySubscriptionRepo implements SubscriptionRepo {
  private readonly byId = new Map<string, Subscription>()

  async put(sub: Subscription): Promise<void> {
    this.byId.set(sub.subscription_id, sub)
  }

  async get(subscriptionId: string): Promise<Subscription | null> {
    return this.byId.get(subscriptionId) ?? null
  }

  async all(): Promise<Subscription[]> {
    return [...this.byId.values()]
  }
}

export class MemoryFlagRepo implements FlagRepo {
  private readonly byPost = new Map<string, Map<string, FlagRecord>>()
  private readonly forfeited = new Set<string>()

  async add(flag: FlagRecord): Promise<boolean> {
    let flaggers = this.byPost.get(flag.post_id)
    if (!flaggers) {
      flaggers = new Map<string, FlagRecord>()
      this.byPost.set(flag.post_id, flaggers)
    }
    if (flaggers.has(flag.flagger)) return false
    flaggers.set(flag.flagger, flag)
    return true
  }

  async countFor(postId: string): Promise<number> {
    return this.byPost.get(postId)?.size ?? 0
  }

  async isForfeited(postId: string): Promise<boolean> {
    return this.forfeited.has(postId)
  }

  async markForfeited(postId: string): Promise<void> {
    this.forfeited.add(postId)
  }
}
