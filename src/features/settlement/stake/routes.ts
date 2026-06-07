import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { StakeService } from './service'
import {
  ApprovalParkedSchema,
  StakeResponseSchema,
  StakeSchema,
  TipResponseSchema,
  TipSchema,
} from './schema'

// Stake + tip HTTP surface (§4.3). Both gate through the signer hard-stop; a parked-for-approval
// outcome is 402 (nothing locked/moved), a success is 200.
export const makeStakeRoutes = (svc: StakeService): FastifyPluginAsyncZod => async (app) => {
  app.post(
    '/stake',
    { schema: { body: StakeSchema, response: { 200: StakeResponseSchema, 402: ApprovalParkedSchema } } },
    async (req, reply) => {
      const outcome = await svc.stake(req.body)
      if (outcome.kind === 'needs_approval') {
        return reply.code(402).send({
          status: 'needs_approval' as const,
          approval_id: outcome.approvalId,
          threshold: outcome.threshold,
          reasons: outcome.reasons,
        })
      }
      return reply.code(200).send({
        stake_id: outcome.stake.stakeId,
        did: outcome.stake.did,
        amount: { amount: outcome.stake.amount, currency: outcome.stake.currency },
        total_bonded: outcome.totalBonded,
        state: outcome.stake.state,
      })
    },
  )

  app.post(
    '/tip',
    { schema: { body: TipSchema, response: { 200: TipResponseSchema, 402: ApprovalParkedSchema } } },
    async (req, reply) => {
      const outcome = await svc.tip(req.body)
      if (outcome.kind === 'needs_approval') {
        return reply.code(402).send({
          status: 'needs_approval' as const,
          approval_id: outcome.approvalId,
          threshold: outcome.threshold,
          reasons: outcome.reasons,
        })
      }
      return reply.code(200).send({
        tip_id: outcome.tipId,
        from: outcome.from,
        to: outcome.to,
        amount: outcome.amount,
        settled_at: outcome.settledAt,
      })
    },
  )
}
