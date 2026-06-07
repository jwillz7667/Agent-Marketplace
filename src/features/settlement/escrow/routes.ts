import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { FastifyReply } from 'fastify'
import { z } from 'zod'
import type { EscrowMutation, EscrowService } from './service'
import {
  AcceptSchema,
  DeliverSchema,
  DisputeSchema,
  EscrowParamsSchema,
  EscrowStateResponseSchema,
  OpenEscrowSchema,
  ResolveEscalationSchema,
} from './schema'

const MoneySchema = z.object({ amount: z.string(), currency: z.string() })
const ApprovalParkedSchema = z.object({
  status: z.literal('needs_approval'),
  approval_id: z.string(),
  threshold: MoneySchema,
  reasons: z.array(z.string()),
})

// Map a service mutation onto the right HTTP response: a state result is 200; a parked-for-approval
// result is 402 (the action is held pending principal/arbiter approval, nothing settled).
const sendMutation = (reply: FastifyReply, outcome: EscrowMutation): FastifyReply => {
  if (outcome.kind === 'needs_approval') {
    return reply.code(402).send({
      status: 'needs_approval' as const,
      approval_id: outcome.approvalId,
      threshold: outcome.threshold,
      reasons: outcome.reasons,
    })
  }
  return reply.code(200).send(outcome.record)
}

// Escrow HTTP surface (§6.2 / §14.4 / §9.5).
export const makeEscrowRoutes = (svc: EscrowService): FastifyPluginAsyncZod => async (app) => {
  app.post(
    '/escrow',
    { schema: { body: OpenEscrowSchema, response: { 200: EscrowStateResponseSchema, 402: ApprovalParkedSchema } } },
    async (req, reply) => sendMutation(reply, await svc.open(req.body)),
  )

  app.post(
    '/escrow/:id/deliver',
    {
      schema: {
        params: EscrowParamsSchema,
        body: DeliverSchema,
        response: { 200: EscrowStateResponseSchema, 402: ApprovalParkedSchema },
      },
    },
    async (req, reply) => sendMutation(reply, await svc.deliver(req.params.id, req.body)),
  )

  app.post(
    '/escrow/:id/accept',
    {
      schema: {
        params: EscrowParamsSchema,
        body: AcceptSchema,
        response: { 200: EscrowStateResponseSchema, 402: ApprovalParkedSchema },
      },
    },
    async (req, reply) => sendMutation(reply, await svc.accept(req.params.id, req.body)),
  )

  app.post(
    '/escrow/:id/dispute',
    {
      schema: {
        params: EscrowParamsSchema,
        body: DisputeSchema,
        response: { 200: EscrowStateResponseSchema, 402: ApprovalParkedSchema },
      },
    },
    async (req, reply) => sendMutation(reply, await svc.dispute(req.params.id, req.body)),
  )

  // Settle an escalated escrow once governance has ruled. Always returns a state result (200): by the
  // time it is callable the ruling already exists; a not-yet-ruled approval surfaces as a 409.
  app.post(
    '/escrow/:id/resolve',
    {
      schema: {
        params: EscrowParamsSchema,
        body: ResolveEscalationSchema,
        response: { 200: EscrowStateResponseSchema, 402: ApprovalParkedSchema },
      },
    },
    async (req, reply) => sendMutation(reply, await svc.resolveEscalation(req.params.id, req.body)),
  )
}
