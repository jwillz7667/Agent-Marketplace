import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { IdentityService } from './service'
import {
  RegisterBodySchema,
  RegisterResponseSchema,
  ResolveParamsSchema,
  ResolveResponseSchema,
  RevokeBodySchema,
  RevokeParamsSchema,
  RevokeResponseSchema,
  RotateBodySchema,
  RotateParamsSchema,
  RotateResponseSchema,
} from './schema'

// HTTP surface for the identity module (§4.1, §10.2 kill switch). All write routes are
// authenticated by a detached JWS over the request body; verification (freshness, single-use
// nonce, signature) happens inside the service via verifySignedObject. Handlers stay thin:
// validate -> delegate -> shape response. Typed AppErrors propagate to the global handler.
export const makeIdentityRoutes = (svc: IdentityService): FastifyPluginAsyncZod => async (app) => {
  app.post(
    '/identity/register',
    { schema: { body: RegisterBodySchema, response: { 200: RegisterResponseSchema } } },
    async (req) => {
      const passport = await svc.register(req.body)
      return { did: passport.did, controller: passport.controller, kyc_level: passport.kyc_level }
    },
  )

  app.get(
    '/identity/:did',
    { schema: { params: ResolveParamsSchema, response: { 200: ResolveResponseSchema } } },
    async (req) => {
      const passport = await svc.resolve(req.params.did)
      // Map to a plain (non-readonly) object matching StoredPassportSchema's inferred type.
      // PassportServices has an optional index signature; drop undefined values for the record.
      const services: Record<string, string> = {}
      for (const [name, url] of Object.entries(passport.services)) {
        if (typeof url === 'string') services[name] = url
      }
      return {
        did: passport.did,
        controller: passport.controller,
        keys: passport.keys.map((k) => ({ id: k.id, type: k.type, pub: k.pub })),
        services,
        delegation_ref: passport.delegation_ref,
        kyc_level: passport.kyc_level,
        sig: passport.sig,
      }
    },
  )

  app.post(
    '/identity/:did/rotate',
    {
      schema: {
        params: RotateParamsSchema,
        body: RotateBodySchema,
        response: { 200: RotateResponseSchema },
      },
    },
    async (req) => {
      const { passport, deprecatedKeyId } = await svc.rotate(req.params.did, req.body)
      const active = passport.keys[passport.keys.length - 1]
      return {
        did: passport.did,
        active_key_id: active ? active.id : req.body.new_key.id,
        deprecated_key_id: deprecatedKeyId,
      }
    },
  )

  app.post(
    '/identity/:did/revoke',
    {
      schema: {
        params: RevokeParamsSchema,
        body: RevokeBodySchema,
        response: { 200: RevokeResponseSchema },
      },
    },
    async (req) => {
      await svc.revoke(req.params.did, req.body)
      return { did: req.params.did, revoked: true as const }
    },
  )
}
