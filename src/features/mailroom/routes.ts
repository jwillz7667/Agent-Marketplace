import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { MailroomService } from './service'
import {
  FlagBodySchema,
  FlagParamsSchema,
  FlagResponseSchema,
  InboxQuerySchema,
  InboxResponseSchema,
  SendMessageSchema,
  SendResponseSchema,
  WebhookRegisterSchema,
  WebhookResponseSchema,
} from './schema'

// Mailroom HTTP surface (§7, §14.2 MAILROOM). The app installs the Zod validator/serializer
// compilers and the shared error handler; handlers just validate-then-delegate and throw
// AppError subclasses. Free-text body fields are validated as strings and never interpreted.
export const makeMailroomRoutes = (svc: MailroomService): FastifyPluginAsyncZod => async (app) => {
  // POST /mailroom/send — send a signed, typed message (+ micro-postage escrow) (§7.1, §7.4).
  app.post(
    '/mailroom/send',
    { schema: { body: SendMessageSchema, response: { 200: SendResponseSchema } } },
    async (req) => {
      const result = await svc.send(req.body)
      // Project into a fresh mutable literal so the serializer's expected shape matches without
      // a structural readonly mismatch.
      return {
        msg_id: result.msg_id,
        thread_id: result.thread_id,
        thread_state: result.thread_state,
        cursor: result.cursor,
        postage: { ...result.postage },
        ...(result.agreement ? { agreement: { ...result.agreement } } : {}),
      }
    },
  )

  // GET /mailroom/inbox — cursor-paginated poll; the SIGNED query proves the caller is the
  // recipient (signerDid = recipient via verifySignedObject over the query) (§7.2).
  app.get(
    '/mailroom/inbox',
    { schema: { querystring: InboxQuerySchema, response: { 200: InboxResponseSchema } } },
    async (req) => {
      const result = await svc.inbox(req.query)
      return {
        recipient: result.recipient,
        messages: result.messages.map((m) => ({ cursor: m.cursor, message: m.message })),
        next_cursor: result.next_cursor,
      }
    },
  )

  // POST /mailroom/webhook — register a push delivery endpoint, owner-signed (§7.2).
  app.post(
    '/mailroom/webhook',
    { schema: { body: WebhookRegisterSchema, response: { 200: WebhookResponseSchema } } },
    async (req) => {
      return svc.registerWebhook(req.body)
    },
  )

  // POST /mailroom/:msgId/flag — recipient flags legit (refund) | spam (forfeit) (§7.4).
  app.post(
    '/mailroom/:msgId/flag',
    {
      schema: {
        params: FlagParamsSchema,
        body: FlagBodySchema,
        response: { 200: FlagResponseSchema },
      },
    },
    async (req) => {
      return svc.flag(req.params.msgId, req.body)
    },
  )
}
