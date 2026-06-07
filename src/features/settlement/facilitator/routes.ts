import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { FacilitatorService } from './service'
import {
  ApprovalParkedSchema,
  PayBodySchema,
  PaymentRequirementsSchema,
  PayParamsSchema,
  ReceiptSchema,
} from './schema'

// Atomic-pay HTTP surface (§5.3 / §14.3). The app installs the Zod validator/serializer compilers
// and the shared error handler; the handler validates-then-delegates and maps the service outcome
// onto the right x402 status: 402 for requirements/approval, 200 + PAYMENT-RECEIPT for a settle.
export const makeFacilitatorRoutes = (svc: FacilitatorService): FastifyPluginAsyncZod => async (app) => {
  app.post(
    '/pay/:listingId',
    {
      schema: {
        params: PayParamsSchema,
        body: PayBodySchema,
        headers: z.object({ 'idempotency-key': z.string().min(1).optional() }),
        response: {
          200: ReceiptSchema,
          402: z.union([PaymentRequirementsSchema, ApprovalParkedSchema]),
        },
      },
    },
    async (req, reply) => {
      const idempotencyKey = req.headers['idempotency-key']
      const outcome = await svc.pay(req.params.listingId, idempotencyKey, req.body)

      if (outcome.kind === 'requirements') {
        // §5.3 step 2: 402 with the PaymentRequirements echoed in the PAYMENT-REQUIRED header
        // (base64) and the body, mirroring x402 so existing facilitators/SDKs interoperate.
        const encoded = Buffer.from(JSON.stringify(outcome.requirements), 'utf8').toString('base64')
        reply.header('PAYMENT-REQUIRED', encoded)
        return reply.code(402).send(outcome.requirements)
      }

      if (outcome.kind === 'needs_approval') {
        // The call is parked (not charged) pending principal approval (§4.3 needs_approval).
        return reply.code(402).send({
          status: 'needs_approval' as const,
          approval_id: outcome.approvalId,
          threshold: outcome.threshold,
          reasons: outcome.reasons,
        })
      }

      // §5.3 step 7: 200 OK + PAYMENT-RECEIPT (base64 of the signed Receipt) + the receipt body.
      const encoded = Buffer.from(JSON.stringify(outcome.receipt), 'utf8').toString('base64')
      reply.header('PAYMENT-RECEIPT', encoded)
      return reply.code(200).send(outcome.receipt)
    },
  )
}
