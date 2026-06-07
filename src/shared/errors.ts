// Typed error hierarchy. Every error carries a stable machine code + HTTP status.
// Routes map these to responses via the shared error handler (src/shared/http/errors.ts).
// Never throw bare strings; never swallow with catch(e: any).

export interface AppErrorOptions {
  readonly details?: unknown
  readonly cause?: unknown
}

export abstract class AppError extends Error {
  abstract readonly code: string
  abstract readonly httpStatus: number
  readonly details?: unknown

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message)
    this.name = new.target.name
    this.details = options.details
    if (options.cause !== undefined) {
      // Preserve the cause chain without re-logging at intermediate layers.
      ;(this as { cause?: unknown }).cause = options.cause
    }
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class ValidationError extends AppError {
  readonly code = 'validation_error'
  readonly httpStatus = 400
}

export class AuthError extends AppError {
  readonly code = 'auth_error'
  readonly httpStatus = 401
}

export class ForbiddenError extends AppError {
  readonly code = 'forbidden'
  readonly httpStatus = 403
}

export class NotFoundError extends AppError {
  readonly code = 'not_found'
  readonly httpStatus = 404
}

export class ConflictError extends AppError {
  readonly code = 'conflict'
  readonly httpStatus = 409
}

export class PolicyViolationError extends AppError {
  readonly code = 'policy_violation'
  readonly httpStatus = 403
}

export class PaymentRequiredError extends AppError {
  readonly code = 'payment_required'
  readonly httpStatus = 402
}

export class ReplayError extends AppError {
  readonly code = 'replay_detected'
  readonly httpStatus = 409
}

export class RailError extends AppError {
  readonly code = 'rail_error'
  readonly httpStatus = 502
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError
