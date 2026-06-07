import { verifyDetached } from '../crypto/index'
import { stripForSigning } from '../../domain/index'
import { AuthError, ReplayError, ValidationError } from '../errors'
import type { Clock, IdentityResolver, NonceStore } from '../ports/index'

export interface EnvelopeDeps {
  readonly identity: IdentityResolver
  readonly nonces: NonceStore
  readonly clock: Clock
  readonly skewMs?: number
}

export interface VerifyOptions {
  // DID whose key signed the object.
  readonly signerDid: string
  // Field carrying the detached JWS (default "sig").
  readonly sigField?: string
  // Fields to strip before recomputing the signing input (default [sigField]).
  readonly omitFields?: readonly string[]
  // Optional explicit key id within the signer's passport.
  readonly keyId?: string
  // Optional: skip nonce consumption (e.g. server-recomputed objects). Default false.
  readonly skipNonce?: boolean
}

const DEFAULT_SKEW = 2000

// Verifies freshness (iat/exp), single-use nonce, and the detached signature over the
// canonical object minus its signature field. Throws typed errors on any failure.
export const verifySignedObject = async (
  deps: EnvelopeDeps,
  obj: Record<string, unknown>,
  opts: VerifyOptions,
): Promise<void> => {
  const sigField = opts.sigField ?? 'sig'
  const skew = deps.skewMs ?? DEFAULT_SKEW
  const nowMs = deps.clock.nowMs()

  const sig = obj[sigField]
  if (typeof sig !== 'string' || sig.length === 0) {
    throw new ValidationError(`missing signature field "${sigField}"`)
  }

  const iat = obj['iat']
  const exp = obj['exp']
  const nonce = obj['nonce']

  if (typeof iat === 'string') {
    const iatMs = new Date(iat).getTime()
    if (Number.isNaN(iatMs)) throw new ValidationError('invalid iat')
    if (iatMs > nowMs + skew) throw new ValidationError('iat is in the future')
  }

  // Replay protection is mandatory for every client-submitted object (the §13 invariant: every
  // object carries nonce + iat + exp; verifiers reject stale or replayed nonces). The ONLY
  // exception is skipNonce, used for server-recomputed objects (e.g. a registry-signed Quote whose
  // freshness is its own issued/expires window). When nonce protection applies we REQUIRE both
  // nonce and exp to be present — otherwise the object could silently skip single-use enforcement
  // and be replayed within its validity window (regardless of any client-chosen Idempotency-Key).
  if (!opts.skipNonce) {
    if (typeof nonce !== 'string' || nonce.length === 0) {
      throw new ValidationError('missing replay-protection nonce')
    }
    if (typeof exp !== 'string' || exp.length === 0) {
      throw new ValidationError('missing expiry (exp) for nonce-protected object')
    }
  }

  // Always enforce expiry when an exp is present (skipNonce objects may still carry one).
  if (typeof exp === 'string' && exp.length > 0) {
    const expMs = new Date(exp).getTime()
    if (Number.isNaN(expMs)) throw new ValidationError('invalid exp')
    if (expMs < nowMs - skew) throw new AuthError('signed object has expired')
  }

  // Consume the nonce exactly once (keyed by its expiry so the store can prune it). A replayed or
  // already-expired nonce fails closed.
  if (!opts.skipNonce && typeof nonce === 'string' && typeof exp === 'string') {
    const fresh = await deps.nonces.checkAndConsume(nonce, exp)
    if (!fresh) throw new ReplayError('nonce replayed or expired')
  }

  const publicKey = await deps.identity.publicKeyFor(opts.signerDid, opts.keyId)
  if (!publicKey) throw new AuthError(`no public key for signer ${opts.signerDid}`)

  // Fail closed on a revoked / killed signer (§10.2 kill switch): even a validly-signed object from
  // a DID whose delegation has been revoked must be rejected at the verification boundary.
  if (await deps.identity.isRevoked(opts.signerDid)) {
    throw new AuthError(`signer ${opts.signerDid} is revoked`)
  }

  const omit = opts.omitFields ?? [sigField]
  const payload = stripForSigning(obj, omit)
  const valid = await verifyDetached(payload, sig, publicKey)
  if (!valid) throw new AuthError('signature verification failed')
}
