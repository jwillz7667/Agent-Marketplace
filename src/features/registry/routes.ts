import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { CapabilityQuery, Listing } from '../../domain/index'
import type { RegistryService } from './service'
import {
  CapabilityQuerySchema,
  DryRunParamsSchema,
  DryRunResponseSchema,
  ListingParamsSchema,
  ListingPublishResponseSchema,
  ListingPublishSchema,
  ListingResponseSchema,
  QueryResponseSchema,
} from './schema'

// Registry HTTP surface (§14.2). The app installs the Zod validator/serializer compilers and
// the shared error handler; handlers just validate-then-delegate and throw AppError subclasses.
export const makeRegistryRoutes = (svc: RegistryService): FastifyPluginAsyncZod => async (app) => {
  // POST /registry/listings — publish/update a provider-signed listing (§3).
  app.post(
    '/registry/listings',
    { schema: { body: ListingPublishSchema, response: { 200: ListingPublishResponseSchema } } },
    async (req) => {
      const listing = await svc.publishListing(req.body)
      return { listing_id: listing.listing_id, version: listing.version, status: listing.status }
    },
  )

  // GET /registry/listings/:id — fetch a listing (404 if missing).
  app.get(
    '/registry/listings/:id',
    { schema: { params: ListingParamsSchema, response: { 200: ListingResponseSchema } } },
    async (req) => {
      const listing: Listing = await svc.getListing(req.params.id)
      return listing as unknown as Record<string, unknown>
    },
  )

  // POST /registry/query — capability query → ranked matches + signed quotes (§2.1–§2.3).
  // The validated body conforms to the §2.1 CapabilityQuery; map it into the domain shape and
  // project the result into a fresh (mutable) response literal so the Zod serializer's expected
  // shape matches without a structural readonly mismatch.
  app.post(
    '/registry/query',
    { schema: { body: CapabilityQuerySchema, response: { 200: QueryResponseSchema } } },
    async (req) => {
      const result = await svc.query(req.body as CapabilityQuery)
      return {
        query_id: result.query_id,
        matches: result.matches.map((m) => ({
          listing_id: m.listing_id,
          provider: m.provider,
          price: { amount: m.price.amount, currency: m.price.currency },
          quote: { ...m.quote },
          match_explanation: {
            listing_id: m.match_explanation.listing_id,
            score: m.match_explanation.score,
            signals: { ...m.match_explanation.signals },
            notes: [...m.match_explanation.notes],
          },
        })),
      }
    },
  )

  // POST /registry/dry-run/:id — free probe → signed result + checksum (§9.4).
  app.post(
    '/registry/dry-run/:id',
    { schema: { params: DryRunParamsSchema, response: { 200: DryRunResponseSchema } } },
    async (req) => {
      return svc.dryRun(req.params.id)
    },
  )
}
