import { b64uToBytes } from '../../shared/crypto/index'
import { passportSigningKey, delegationIsExpired } from '../../domain/index'
import type { DelegationCredential, Passport } from '../../domain/index'
import type { Clock, IdentityResolver } from '../../shared/ports/index'
import type { DelegationRepo, PassportRepo, RevocationRepo } from './repo'

// IdentityResolver: the read side of the DID registry. Resolves passports, returns raw
// public-key bytes for signature verification, surfaces the active delegation, and reports
// revocation state. Revocation is checked here so verifiers fail closed on a killed agent.
export class PraxisIdentityResolver implements IdentityResolver {
  constructor(
    private readonly passports: PassportRepo,
    private readonly delegations: DelegationRepo,
    private readonly revocations: RevocationRepo,
    private readonly clock: Clock,
  ) {}

  async resolvePassport(did: string): Promise<Passport | null> {
    return this.passports.get(did)
  }

  // Returns the raw Ed25519 public key bytes for the signer's key. Defaults to the first
  // key in the passport, or the key matching `keyId`. Null when the DID or key is unknown.
  async publicKeyFor(did: string, keyId?: string): Promise<Uint8Array | null> {
    const passport = await this.passports.get(did)
    if (!passport) return null
    const key = passportSigningKey(passport, keyId)
    if (!key) return null
    return b64uToBytes(key.pub)
  }

  // "Active" means genuinely usable RIGHT NOW: present, not revoked, and not expired. Consumers
  // that authorize off this (board posting §8, mailroom messaging §7) get a fail-closed gate without
  // each re-checking expiry. The signer (§4.3) additionally re-checks expiry itself for a precise
  // reason and as defense-in-depth, exactly as it already does for revocation.
  async activeDelegation(did: string): Promise<DelegationCredential | null> {
    if (await this.revocations.isRevoked(did)) return null
    const delegation = await this.delegations.get(did)
    if (!delegation) return null
    if (delegationIsExpired(delegation, this.clock.now())) return null
    return delegation
  }

  async isRevoked(did: string): Promise<boolean> {
    return this.revocations.isRevoked(did)
  }
}
