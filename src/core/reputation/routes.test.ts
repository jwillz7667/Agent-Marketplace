import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Receipt } from '../../domain/index'
import { didFromPublicKey, generateKeyPair } from '../../shared/crypto/index'
import { isAppError } from '../../shared/errors'
import { FixedClock } from '../../shared/time/clock'
import { buildReputation } from './index'
import type { CoreSigner } from './reputation.service'

const PROVIDER = 'did:praxis:agent:provider'

const makeCoreSigner = async (): Promise<CoreSigner> => {
  const kp = await generateKeyPair()
  const did = didFromPublicKey(kp.publicKey, 'core')
  return { did, kid: `${did}#rep-1`, privateKey: kp.privateKey, publicKey: kp.publicKey }
}

const receipt = (): Receipt => ({
  receipt_id: 'rcp_route_1',
  quote_id: 'qt_1',
  listing_id: 'lst_1',
  listing_version: '1',
  job_ref: null,
  payer: 'did:praxis:agent:payer1',
  payee: PROVIDER,
  amount: { amount: '1.00', currency: 'USDC' },
  rail: 'x402-usdc',
  result_hash: 'sha256:deadbeef',
  latency_ms: 1000,
  outcome: 'delivered',
  settled_at: '2026-06-06T15:00:00.000Z',
  facilitator_sig: 'fac.sig',
  payee_sig: 'payee.sig',
})

// The repo's pinned fastify-type-provider-zod@4 pulls zod-to-json-schema@3.25 which
// resolves `zod/v3` (a zod v4 subpath), so the published serializer/validator compilers
// cannot load against the pinned zod v3. We supply equivalent Zod-driven compilers locally
// so the ACTUAL route plugin (with its real Zod schemas) is exercised end to end here:
// inbound params are parsed with the route's Zod schema, and responses are serialized as
// JSON. This tests routing + handler delegation + 404 mapping for real, with no dependency
// on the broken transitive package.
const zodValidatorCompiler =
  ({ schema }: { schema: z.ZodTypeAny }) =>
  (data: unknown) => {
    const result = schema.safeParse(data)
    return result.success ? { value: result.data } : { error: result.error }
  }

const jsonSerializerCompiler = () => (data: unknown) => JSON.stringify(data)

const buildApp = async () => {
  const coreSigner = await makeCoreSigner()
  const module = buildReputation({ clock: new FixedClock(), coreSigner })

  const app = Fastify({ logger: false })
  app.setValidatorCompiler(zodValidatorCompiler)
  app.setSerializerCompiler(jsonSerializerCompiler)
  // Local equivalent of the shared AppError boundary. The real src/shared/http/errors
  // value-imports fastify-type-provider-zod (the package that fails to resolve zod/v3
  // against the pinned zod v3), so we map AppError -> {statusCode, code} inline here.
  app.setErrorHandler((error, _req, reply) => {
    if (isAppError(error)) {
      void reply.status(error.httpStatus).send({ statusCode: error.httpStatus, code: error.code, message: error.message })
      return
    }
    void reply.status(500).send({ statusCode: 500, code: 'internal_error', message: 'Internal server error' })
  })
  await app.register(module.routes)
  await app.ready()
  return { app, module, coreSigner }
}

describe('reputation routes', () => {
  let toClose: Array<Awaited<ReturnType<typeof buildApp>>['app']> = []
  afterEach(async () => {
    await Promise.all(toClose.map((a) => a.close()))
    toClose = []
  })

  it('GET /reputation/:did returns the signed snapshot for a known subject', async () => {
    const { app, module, coreSigner } = await buildApp()
    toClose.push(app)
    await module.reputationService.ingestReceipt(receipt())

    const res = await app.inject({ method: 'GET', url: `/reputation/${PROVIDER}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.subject).toBe(PROVIDER)
    expect(body.issuer).toBe(coreSigner.did)
    expect(body.window).toBe('30d')
    expect(typeof body.sig).toBe('string')
    expect(body.metrics.jobs).toBe(1)
  })

  it('GET /reputation/:did/raw returns the underlying metrics', async () => {
    const { app, module } = await buildApp()
    toClose.push(app)
    await module.reputationService.ingestReceipt(receipt())

    const res = await app.inject({ method: 'GET', url: `/reputation/${PROVIDER}/raw` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.success_rate).toBe(1)
    expect(body.jobs).toBe(1)
    // The raw response must NOT leak any review-shaped field.
    expect(Object.keys(body)).not.toContain('stars')
    expect(Object.keys(body)).not.toContain('review')
  })

  it('returns 404 for an unknown subject on both routes', async () => {
    const { app } = await buildApp()
    toClose.push(app)

    const snap = await app.inject({ method: 'GET', url: '/reputation/did:praxis:agent:nobody' })
    expect(snap.statusCode).toBe(404)
    expect(snap.json().code).toBe('not_found')

    const raw = await app.inject({ method: 'GET', url: '/reputation/did:praxis:agent:nobody/raw' })
    expect(raw.statusCode).toBe(404)
    expect(raw.json().code).toBe('not_found')
  })
})
