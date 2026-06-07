import { pubToB64u } from '../../shared/crypto/index'
import type { DelegationCredential, KycLevel, Passport } from '../../domain/index'
import type { Clock, DelegationAdminPort, IdentityResolver, Keystore, NonceStore } from '../../shared/ports/index'
import type { Config } from '../../shared/config/index'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { MemoryDelegationRepo, MemoryPassportRepo, MemoryRevocationRepo } from './memory'
import { MemoryKeystore, signingKid } from './keystore'
import { PraxisIdentityResolver } from './identity-resolver'
import { PraxisDelegationAdmin } from './delegation-admin'
import { IdentityService } from './service'
import { makeIdentityRoutes } from './routes'

// ============================================================================
// KID CONVENTION (load-bearing across modules)
// ----------------------------------------------------------------------------
// The Keystore key and the JWS `kid` are one and the same string:
//
//     kid = `${did}${keyId}`        // keyId already starts with '#', e.g. '#sign-1'
//
// so an agent signing kid is `did:praxis:agent:7f3a...#sign-1`. A consumer that needs to
// sign as an agent (e.g. WalletSigner) resolves the agent's Passport via IdentityResolver,
// reads keys[0].id (or a named key id), and rebuilds the same kid to fetch the private key
// from the Keystore. This namespacing keeps kids globally unique. Use signingKid(did, keyId)
// to build it — exported below so other modules never hand-concatenate.
// ============================================================================

export interface IdentityDeps {
  readonly clock: Clock
  readonly nonces: NonceStore
  readonly config: Config
}

export interface SeedCoreIdentityInput {
  readonly did: string
  // The full JWS kid, conventionally `${did}${keyId}` (see KID CONVENTION above).
  readonly kid: string
  readonly privateKey: Uint8Array
  readonly publicKey: Uint8Array
  readonly controller: string
}

// Admin/bootstrap surface used by the composition root and tests to make DIDs resolvable
// and signable without going through the signed HTTP register flow.
export interface IdentityAdmin {
  // Registers a resolvable single-key passport for a core DID and stores its private key in
  // the Keystore under `kid`, so verifySignedObject works for objects this DID signs and the
  // DID can itself sign. The passport key id is derived from `kid` by stripping the `${did}`
  // prefix (the remainder, e.g. '#sign-1', is the PassportKey.id).
  seedCoreIdentity(input: SeedCoreIdentityInput): Promise<Passport>
  // Stores a fully-formed passport verbatim (tests that pre-sign their own passports).
  seedPassport(passport: Passport): Promise<void>
  // Stores a delegation for an agent without re-issuing/signing (tests + governance plane).
  seedDelegation(subjectDid: string, delegation: DelegationCredential): Promise<void>
  // Registers a private key under an arbitrary kid (tests that need an agent signing key).
  seedSigningKey(kid: string, privateKey: Uint8Array): Promise<void>
}

export interface IdentityModule {
  readonly service: IdentityService
  readonly identityResolver: IdentityResolver
  readonly delegationAdmin: DelegationAdminPort
  readonly keystore: Keystore
  readonly admin: IdentityAdmin
  readonly routes: FastifyPluginAsyncZod
}

// buildIdentity wires the DID registry, Agent Passport lifecycle, Keystore, and delegation
// admin. Repos are constructed here (in-memory by default per the build contract). Returns
// the three ports it implements (identityResolver / delegationAdmin / keystore), an admin
// bootstrap surface, and the Fastify route plugin.
export const buildIdentity = (deps: IdentityDeps): IdentityModule => {
  const passports = new MemoryPassportRepo()
  const delegations = new MemoryDelegationRepo()
  const revocations = new MemoryRevocationRepo()
  const keystore = new MemoryKeystore()

  const identityResolver = new PraxisIdentityResolver(passports, delegations, revocations, deps.clock)
  const delegationAdmin = new PraxisDelegationAdmin(passports, delegations, revocations, keystore, deps.clock)

  const service = new IdentityService({
    passports,
    delegations,
    revocations,
    keystore,
    identity: identityResolver,
    delegationAdmin,
    nonces: deps.nonces,
    clock: deps.clock,
    config: deps.config,
  })

  const admin: IdentityAdmin = {
    async seedCoreIdentity(input) {
      const keyId = deriveKeyId(input.did, input.kid)
      const kycLevel: KycLevel = 'enhanced'
      const passport: Passport = {
        did: input.did,
        controller: input.controller,
        keys: [{ id: keyId, type: 'Ed25519', pub: pubToB64u(input.publicKey) }],
        services: {},
        delegation_ref: null,
        kyc_level: kycLevel,
        sig: '', // core identities are seeded out-of-band, not via the signed register flow
      }
      await passports.put(passport)
      await keystore.register(input.kid, input.privateKey)
      return passport
    },
    async seedPassport(passport) {
      await passports.put(passport)
    },
    async seedDelegation(subjectDid, delegation) {
      await delegations.put(subjectDid, delegation)
    },
    async seedSigningKey(kid, privateKey) {
      await keystore.register(kid, privateKey)
    },
  }

  return {
    service,
    identityResolver,
    delegationAdmin,
    keystore,
    admin,
    routes: makeIdentityRoutes(service),
  }
}

// keyId = kid with the leading `${did}` removed. The convention keeps keyId === the '#...'
// suffix; if a caller passes a kid that is not prefixed by the did we fall back to the kid
// itself as the key id (defensive — keeps the passport key resolvable either way).
const deriveKeyId = (did: string, kid: string): string =>
  kid.startsWith(did) ? kid.slice(did.length) : kid

export { signingKid }
export type { Passport, DelegationCredential } from '../../domain/index'
export type { PassportRepo, DelegationRepo, RevocationRepo } from './repo'
export { MemoryPassportRepo, MemoryDelegationRepo, MemoryRevocationRepo } from './memory'
export { MemoryKeystore } from './keystore'
export { PraxisIdentityResolver } from './identity-resolver'
export { PraxisDelegationAdmin } from './delegation-admin'
export { IdentityService } from './service'
