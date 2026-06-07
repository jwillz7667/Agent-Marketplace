import type { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod'
import { AppError, isAppError } from '../errors'

export interface ErrorBody {
  readonly statusCode: number
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

const toBody = (e: AppError): ErrorBody => ({
  statusCode: e.httpStatus,
  code: e.code,
  message: e.message,
  ...(e.details !== undefined ? { details: e.details } : {}),
})

// Single error boundary: log once here, map typed errors to responses.
export const setErrorHandler = (app: FastifyInstance): void => {
  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      if (error.httpStatus >= 500) request.log.error({ err: error }, error.code)
      else request.log.warn({ err: error.code, msg: error.message }, 'request rejected')
      void reply.status(error.httpStatus).send(toBody(error))
      return
    }

    if (hasZodFastifySchemaValidationErrors(error) || error instanceof ZodError) {
      request.log.warn({ err: 'validation_error' }, 'schema validation failed')
      void reply.status(400).send({
        statusCode: 400,
        code: 'validation_error',
        message: 'Request failed schema validation',
        details: 'validation' in error ? error.validation : (error as ZodError).issues,
      })
      return
    }

    // Fastify's own typed errors (e.g. 404, 415) carry a statusCode.
    const status = typeof (error as { statusCode?: number }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500
    if (status >= 500) request.log.error({ err: error }, 'unhandled error')
    void reply.status(status).send({
      statusCode: status,
      code: status >= 500 ? 'internal_error' : 'request_error',
      message: status >= 500 ? 'Internal server error' : error.message,
    })
  })
}
