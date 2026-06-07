import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type {
  Clock,
  IdempotencyStore,
  IdentityResolver,
  Ledger,
  NonceStore,
  PolicyEvaluator,
  ReputationPort,
  ValueTransferPort,
} from '../../shared/ports/index'
import type { Config } from '../../shared/config/index'
import { BoardService } from './service'
import { MemoryFlagRepo, MemoryPostRepo, MemorySubscriptionRepo } from './memory'
import type { FlagRepo, PostRepo, SubscriptionRepo } from './repo'
import { makeBoardRoutes } from './routes'

// Public surface of the board feature (§8, §2.2, §9.3, §10.3, §14.2 BOARD).
export { BoardService } from './service'
export type { BoardDeps, AppendResult, BoardQueryMatch, FlagResult } from './service'
export { POST_FEE_AMOUNT, POST_FEE_CURRENCY, FLAG_FORFEIT_THRESHOLD } from './service'
export type { PostRepo, SubscriptionRepo, FlagRepo, Subscription, ChainHead, FlagRecord } from './repo'
export { MemoryPostRepo, MemorySubscriptionRepo, MemoryFlagRepo } from './memory'
export { makeBoardRoutes } from './routes'
export { rankPosts, RANK_WEIGHTS, type RankedPost, type MatchExplanation } from './ranking'
export * from './schema'

export interface BoardFactoryDeps {
  readonly clock: Clock
  readonly nonces: NonceStore
  // idempotency is part of the standard container deps; the board's mutations are dedup'd
  // structurally (append-only seq, per-(post,flagger) flag dedup, per-post forfeit guard), so we
  // accept it for uniform wiring even though no handler needs an Idempotency-Key replay cache.
  readonly idempotency: IdempotencyStore
  readonly identity: IdentityResolver
  readonly valueTransfer: ValueTransferPort
  readonly policy: PolicyEvaluator
  readonly reputation: ReputationPort
  readonly ledger: Ledger
  readonly config: Config
  // Repos default to in-memory adapters the factory constructs; supply pre-built ones to swap
  // persistence without touching the service.
  readonly posts?: PostRepo
  readonly subscriptions?: SubscriptionRepo
  readonly flags?: FlagRepo
}

export interface BoardModule {
  readonly boardService: BoardService
  readonly routes: FastifyPluginAsyncZod
}

// Hexagonal factory: every collaborator is injected; repos default to in-memory adapters the
// factory constructs itself. Returns the service + a Fastify route plugin the container
// registers uniformly.
export const buildBoard = (deps: BoardFactoryDeps): BoardModule => {
  const posts: PostRepo = deps.posts ?? new MemoryPostRepo()
  const subscriptions: SubscriptionRepo = deps.subscriptions ?? new MemorySubscriptionRepo()
  const flags: FlagRepo = deps.flags ?? new MemoryFlagRepo()

  const boardService = new BoardService({
    clock: deps.clock,
    nonces: deps.nonces,
    identity: deps.identity,
    valueTransfer: deps.valueTransfer,
    policy: deps.policy,
    reputation: deps.reputation,
    ledger: deps.ledger,
    config: deps.config,
    posts,
    subscriptions,
    flags,
  })

  return { boardService, routes: makeBoardRoutes(boardService) }
}
