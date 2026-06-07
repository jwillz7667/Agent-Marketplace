import type { BoardPost } from '../../domain/index'

// Persistence ports owned by the board module. The factory constructs the in-memory adapters
// by default; the container can swap Prisma-backed pairs without touching the service.
//
// The PostRepo is APPEND-ONLY by construction: there is NO update or delete method. Editing a
// post is impossible — a new post supersedes it, and "deleting" is a signed TOMBSTONE that
// references the original (§8.2). The repo maintains the chain head so the service can link
// each new post to the previous post_hash.

export interface ChainHead {
  readonly seq: number
  readonly post_hash: string
}

export interface PostRepo {
  // Append a fully-formed (signed + chain-linked) post. Throws on a seq/post_id collision so a
  // double-append can never silently fork the chain.
  append(post: BoardPost): Promise<void>
  get(postId: string): Promise<BoardPost | null>
  // Current chain head (highest seq), or null when the chain is empty (next seq = 1).
  head(): Promise<ChainHead | null>
  // All posts in seq order. The service applies filter/rank and tombstone exclusion on top.
  all(): Promise<BoardPost[]>
  // Ordered post_hashes for Merkle-root computation (§8.2).
  hashes(): Promise<string[]>
}

export interface Subscription {
  readonly subscription_id: string
  readonly subscriber: string
  readonly topics: readonly string[]
  readonly webhook_url: string | null
  readonly created: string
}

export interface SubscriptionRepo {
  put(sub: Subscription): Promise<void>
  get(subscriptionId: string): Promise<Subscription | null>
  // Subscriptions whose topic set matches a post (topic match is computed by the service).
  all(): Promise<Subscription[]>
}

export interface FlagRecord {
  readonly post_id: string
  readonly flagger: string
  readonly reason: string
  readonly category: string
  readonly created: string
}

export interface FlagRepo {
  // Idempotent per (post_id, flagger): returns false if this flagger already flagged the post.
  add(flag: FlagRecord): Promise<boolean>
  countFor(postId: string): Promise<number>
  // Whether a sustained-flag forfeit has already been applied for this post (idempotent slash).
  isForfeited(postId: string): Promise<boolean>
  markForfeited(postId: string): Promise<void>
}
