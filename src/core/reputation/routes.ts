import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { NotFoundError } from '../../shared/errors'
import type { ReputationPort } from '../../shared/ports/index'
import { RawResponseSchema, SnapshotResponseSchema, SubjectParamsSchema } from './schema'

// Read-only HTTP surface for reputation (§9). Both routes are point lookups by subject DID.
// No write surface: reputation is never client-asserted, only measured from settled receipts
// and observed signals (§9.2). 404 when the subject has no measured history at all.
export const makeReputationRoutes = (reputation: ReputationPort): FastifyPluginAsyncZod => async (app) => {
  app.get(
    '/reputation/:did',
    { schema: { params: SubjectParamsSchema, response: { 200: SnapshotResponseSchema } } },
    async (req) => {
      const snapshot = await reputation.getSnapshot(req.params.did)
      if (!snapshot) throw new NotFoundError(`no reputation for subject ${req.params.did}`)
      return snapshot
    },
  )

  app.get(
    '/reputation/:did/raw',
    { schema: { params: SubjectParamsSchema, response: { 200: RawResponseSchema } } },
    async (req) => {
      const metrics = await reputation.getRaw(req.params.did)
      if (!metrics) throw new NotFoundError(`no reputation for subject ${req.params.did}`)
      return metrics
    },
  )
}
