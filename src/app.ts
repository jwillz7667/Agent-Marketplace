// Fastify wiring: type provider, single error boundary, CORS, health, and every module's
// route plugin. No business logic lives here — the app only composes the container's surfaces.

import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod'
import { setErrorHandler } from './shared/http/index'
import type { Container } from './container'

export const buildApp = async (container: Container): Promise<FastifyInstance> => {
  // Widen to FastifyBaseLogger so the instance's logger generic stays the default the route
  // plugins are typed against (pino's Logger is a superset, so this is a safe widening).
  const loggerInstance: FastifyBaseLogger = container.logger
  const app = Fastify({
    loggerInstance,
    // DIDs and signatures can be long; allow generous but bounded bodies.
    bodyLimit: 1_048_576,
    requestIdHeader: 'x-request-id',
  }).withTypeProvider<ZodTypeProvider>()

  // Zod is the single source of truth for request/response schemas across all routes.
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  // One error boundary maps typed AppError / Zod validation failures to responses (logs once).
  setErrorHandler(app)

  await app.register(cors, { origin: true })

  // Liveness/readiness: confirms the process is up and the ledger hash-chain is intact.
  app.get('/health', async () => {
    const chainOk = await container.ledger.ledger.verifyChain()
    return { status: 'ok', ledger_intact: chainOk, time: container.clock.now() }
  })

  // Agent-facing protocol plane + shared-core read surfaces + human governance plane.
  // Each plugin owns its full §14.2 paths; there are no prefix collisions.
  await app.register(container.identity.routes)
  await app.register(container.reputation.routes)
  await app.register(container.registry.routes)
  await app.register(container.settlement.routes)
  await app.register(container.mailroom.routes)
  await app.register(container.board.routes)
  await app.register(container.governance.routes)

  return app
}
