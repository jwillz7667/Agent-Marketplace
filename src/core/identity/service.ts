import { b64uToBytes, didFromPublicKey, parseDid } from '../../shared/crypto/index'
import type { Passport, PassportKey } from '../../domain/index'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors'
import { verifySignedObject } from '../../shared/http/index'
import type { Clock, IdentityResolver, Keystore, NonceStore } from '../../shared/ports/index'
import type { Config } from '../../shared/config/index'
import type { PraxisDelegationAdmin } from './delegation-admin'
import { RotateBodySchema } from './schema'
import type { PassportInput } from './schema'
import { z } from 'zod'
import type { DelegationRepo, PassportRepo, RevocationRepo } from './repo'

type RotateInput = z.infer<typeof RotateBodySchema>

interface ServiceDeps {
  readonly passports: PassportRepo
  readonly delegations: DelegationRepo
  readonly revocations: RevocationRepo
  readonly keystore: Keystore
  readonly identity: IdentityResolver
  readonly delegationAdmin: PraxisDelegationAdmin
  readonly nonces: NonceStore
  readonly clock: Clock
  readonly config: Config
}

// IdentityService: the write side of the DID registry + Agent Passport lifecycle (§4.1).
// Registration verifies the principal/self signature and the deterministic DID derivation
// before storing; rotation and revocation are likewise controller-authenticated. Revocation
// is the kill switch (§10.2) and takes effect immediately via the RevocationRepo.
//
// SIGNING NOTE: the principal signs the FULL wire object (passport + nonce/iat/exp) minus
// ['sig']. We therefore verify against that full input. The canonical stored Passport drops
// the envelope fields (the domain Passport type — and the §4.1 spec JSON — carry only `sig`);
// the registration-time check is the trust boundary, not a re-verification on every resolve.
export class IdentityService {
  constructor(private readonly deps: ServiceDeps) {}

  private envDeps() {
    return {
      identity: this.deps.identity,
      nonces: this.deps.nonces,
      clock: this.deps.clock,
      skewMs: this.deps.config.SIGNATURE_SKEW_MS,
    }
  }

  // POST /identity/register. The body is the signed Passport. A self-signed org passport
  // bootstraps a principal (signer == subject); an agent passport is signed by its controller.
  // We verify the signature, then require the DID to be the deterministic hash of the
  // declared public key so a DID cannot be claimed for a key it does not control.
  async register(input: PassportInput): Promise<Passport> {
    const existing = await this.deps.passports.get(input.did)
    if (existing) throw new ConflictError(`passport already registered for ${input.did}`)

    const role = this.didRole(input.did)
    const isSelfSigned = input.controller === input.did

    if (role === 'agent' && isSelfSigned) {
      throw new ValidationError('agent passport must be signed by its controller principal, not self')
    }
    if (role !== 'agent' && !isSelfSigned) {
      throw new ValidationError('a principal/org passport must be self-signed (controller === did)')
    }

    // Bind the DID to the declared key: did == didFromPublicKey(firstKey, role).
    const firstKey = input.keys[0]
    if (!firstKey) throw new ValidationError('passport must declare at least one key')
    const derived = didFromPublicKey(b64uToBytes(firstKey.pub), role)
    if (derived !== input.did) {
      throw new ValidationError('passport.did does not match did derived from keys[0].pub')
    }

    // The signer is the controller principal (already resolvable), or — for a self-signed
    // org passport — the subject itself. For self-signed bootstrap the resolver cannot yet
    // return the key, so verify against the declared key directly.
    if (isSelfSigned) {
      await this.verifySelfSigned(input)
    } else {
      const controller = await this.deps.passports.get(input.controller)
      if (!controller) {
        throw new ForbiddenError(`controller principal ${input.controller} is not registered`)
      }
      await verifySignedObject(this.envDeps(), { ...input }, {
        signerDid: input.controller,
        omitFields: ['sig'],
      })
    }

    const passport = this.toPassport(input)
    await this.deps.passports.put(passport)
    return passport
  }

  async resolve(did: string): Promise<Passport> {
    const passport = await this.deps.passports.get(did)
    if (!passport) throw new NotFoundError(`no passport for ${did}`)
    return passport
  }

  // POST /identity/:did/rotate. Controller-signed. Appends `new_key`, marks the named old
  // key deprecated by removing it from the active key set, and re-stores the passport. The
  // new key is appended last so the first (default) signing key remains stable unless it is
  // the one being deprecated.
  async rotate(did: string, body: RotateInput): Promise<{ passport: Passport; deprecatedKeyId: string }> {
    const passport = await this.deps.passports.get(did)
    if (!passport) throw new NotFoundError(`no passport for ${did}`)

    if (!passport.keys.some((k) => k.id === body.deprecate_key_id)) {
      throw new ValidationError(`key ${body.deprecate_key_id} not found on passport ${did}`)
    }
    if (passport.keys.some((k) => k.id === body.new_key.id)) {
      throw new ConflictError(`key ${body.new_key.id} already exists on passport ${did}`)
    }

    // Authenticated by the controller principal (self for an org passport).
    await verifySignedObject(this.envDeps(), { ...body }, {
      signerDid: passport.controller,
      omitFields: ['sig'],
    })

    const newKey: PassportKey = {
      id: body.new_key.id,
      type: body.new_key.type,
      pub: body.new_key.pub,
    }
    const remaining = passport.keys.filter((k) => k.id !== body.deprecate_key_id)
    const updated: Passport = { ...passport, keys: [...remaining, newKey] }

    await this.deps.passports.put(updated)
    return { passport: updated, deprecatedKeyId: body.deprecate_key_id }
  }

  // POST /identity/:did/revoke. The kill switch (§10.2): the controller revokes the agent's
  // delegation; isRevoked(did) flips to true immediately and activeDelegation returns null.
  async revoke(
    did: string,
    body: { sig: string; nonce: string; iat: string; exp: string },
  ): Promise<void> {
    const passport = await this.deps.passports.get(did)
    if (!passport) throw new NotFoundError(`no passport for ${did}`)

    await verifySignedObject(this.envDeps(), { ...body }, {
      signerDid: passport.controller,
      omitFields: ['sig'],
    })

    await this.deps.delegationAdmin.revoke(did)
  }

  private didRole(did: string): 'agent' | 'org' | 'core' {
    return parseDid(did).role
  }

  // For a self-signed (bootstrapping) org passport the key is not yet in the registry, so we
  // verify freshness + nonce + signature directly against the passport's own declared key via
  // a one-shot resolver that reuses the shared envelope verifier.
  private async verifySelfSigned(input: PassportInput): Promise<void> {
    const key = input.keys[0]
    if (!key) throw new ValidationError('passport must declare at least one key')
    const pub = b64uToBytes(key.pub)
    const selfResolver: IdentityResolver = {
      resolvePassport: async () => null,
      publicKeyFor: async () => pub,
      activeDelegation: async () => null,
      isRevoked: async () => false,
    }
    await verifySignedObject(
      {
        identity: selfResolver,
        nonces: this.deps.nonces,
        clock: this.deps.clock,
        skewMs: this.deps.config.SIGNATURE_SKEW_MS,
      },
      { ...input },
      { signerDid: input.did, omitFields: ['sig'] },
    )
  }

  private toPassport(input: PassportInput): Passport {
    return {
      did: input.did,
      controller: input.controller,
      keys: input.keys.map((k) => ({ id: k.id, type: k.type, pub: k.pub })),
      services: input.services,
      delegation_ref: input.delegation_ref,
      kyc_level: input.kyc_level,
      sig: input.sig,
    }
  }
}
