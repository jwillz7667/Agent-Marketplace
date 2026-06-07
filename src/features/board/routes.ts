import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { BoardPostInput } from './schema'
import {
  AnchorResponseSchema,
  BoardPostSchema,
  BoardQueryResponseSchema,
  BoardQuerySchema,
  FlagRequestSchema,
  FlagResponseSchema,
  PostIdParamsSchema,
  PostResponseSchema,
  SubscribeResponseSchema,
  SubscribeSchema,
  TombstoneRequestSchema,
} from './schema'
import type { BoardService } from './service'

// Board HTTP surface (§14.2 BOARD). The app installs the Zod validator/serializer compilers and
// the shared error handler; handlers validate-then-delegate and throw AppError subclasses only.
export const makeBoardRoutes = (svc: BoardService): FastifyPluginAsyncZod => async (app) => {
  // POST /board/post — publish a signed, chain-linked post (+ posting-fee hold) (§8.1, §8.2).
  app.post(
    '/board/post',
    { schema: { body: BoardPostSchema, response: { 200: PostResponseSchema } } },
    async (req) => {
      const { post, merkle_root } = await svc.post(req.body as BoardPostInput)
      return {
        post_id: post.post_id,
        seq: post.seq,
        prev_hash: post.prev_hash,
        post_hash: post.post_hash,
        merkle_root,
      }
    },
  )

  // GET /board/query — two-stage filtered post search (§2.2, §8.3). Tombstoned posts excluded.
  app.get(
    '/board/query',
    { schema: { querystring: BoardQuerySchema, response: { 200: BoardQueryResponseSchema } } },
    async (req) => {
      const { matches, next_cursor } = await svc.query(req.query)
      return {
        matches: matches.map((m) => ({
          post: m.post as unknown as Record<string, unknown>,
          match_explanation: {
            post_id: m.match_explanation.post_id,
            score: m.match_explanation.score,
            signals: { ...m.match_explanation.signals },
            notes: [...m.match_explanation.notes],
          },
        })),
        next_cursor,
      }
    },
  )

  // GET /board/anchor — recomputable Merkle root + head seq (externally verifiable, §8.2).
  app.get('/board/anchor', { schema: { response: { 200: AnchorResponseSchema } } }, async () => {
    return svc.merkleRoot()
  })

  // POST /board/subscribe — register a topic subscription for push-discovery (§8.3).
  app.post(
    '/board/subscribe',
    { schema: { body: SubscribeSchema, response: { 200: SubscribeResponseSchema } } },
    async (req) => {
      const sub = await svc.subscribe(req.body)
      return { subscription_id: sub.subscription_id, subscriber: sub.subscriber, topics: [...sub.topics] }
    },
  )

  // POST /board/:postId/tombstone — signed retraction by the original author (§8.2).
  app.post(
    '/board/:postId/tombstone',
    { schema: { params: PostIdParamsSchema, body: TombstoneRequestSchema, response: { 200: PostResponseSchema } } },
    async (req) => {
      const { post, merkle_root } = await svc.tombstone(req.params.postId, req.body)
      return {
        post_id: post.post_id,
        seq: post.seq,
        prev_hash: post.prev_hash,
        post_hash: post.post_hash,
        merkle_root,
      }
    },
  )

  // POST /board/:postId/flag — report abuse; sustained spam forfeits stake + docks reputation (§8.5).
  app.post(
    '/board/:postId/flag',
    { schema: { params: PostIdParamsSchema, body: FlagRequestSchema, response: { 200: FlagResponseSchema } } },
    async (req) => {
      return svc.flag(req.params.postId, req.body)
    },
  )
}
