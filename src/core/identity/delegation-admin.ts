import { signDetached } from '../../shared/crypto/index'
import { passportSigningKey, stripForSigning } from '../../domain/index'
import type { DelegationCredential, DelegationPolicy } from '../../domain/index'
import { ValidationError } from '../../shared/errors'
import type { Clock, DelegationAdminPort, Keystore, PrincipalAgentEntry } from '../../shared/ports/index'
import { DelegationPolicySchema } from './schema'
import { signingKid } from './keystore'
import type { DelegationRepo, PassportRepo, RevocationRepo } from './repo'

const DELEGATION_TYPE = ['VerifiableCredential', 'PraxisDelegation'] as const

// DelegationAdminPort: the governance/admin write side for spending policies (§4.2).
// issue/update build a DelegationCredential, sign it with the issuer's key when that key
// is held in the keystore, and persist it. revoke triggers the kill switch (§10.2).
export class PraxisDelegationAdmin implements DelegationAdminPort {
  constructor(
    private readonly passports: PassportRepo,
    private readonly delegations: DelegationRepo,
    private readonly revocations: RevocationRepo,
    private readonly keystore: Keystore,
    private readonly clock: Clock,
  ) {}

  async issue(input: {
    issuer: string
    subject: string
    policy: unknown
    expires: string
  }): Promise<DelegationCredential> {
    const policy = this.parsePolicy(input.policy)
    const credential = await this.build(input.issuer, input.subject, policy, input.expires)
    await this.delegations.put(input.subject, credential)
    return credential
  }

  async update(subjectDid: string, policy: unknown): Promise<DelegationCredential> {
    const existing = await this.delegations.get(subjectDid)
    if (!existing) throw new ValidationError(`no delegation to update for ${subjectDid}`)
    const parsed = this.parsePolicy(policy)
    // Re-issue with the same issuer/expiry but the new policy (and a fresh `issued`).
    const credential = await this.build(existing.issuer, subjectDid, parsed, existing.expires)
    await this.delegations.put(subjectDid, credential)
    return credential
  }

  async revoke(subjectDid: string): Promise<void> {
    await this.revocations.revoke(subjectDid)
  }

  async listByPrincipal(principal: string): Promise<PrincipalAgentEntry[]> {
    const passports = await this.passports.listByController(principal)
    const entries: PrincipalAgentEntry[] = []
    for (const p of passports) {
      // A self-controlled org/principal passport (did === controller) is the principal
      // itself, not one of its delegated agents — skip it.
      if (p.did === principal) continue
      const delegation = await this.delegations.get(p.did)
      entries.push({ did: p.did, delegation })
    }
    return entries
  }

  private parsePolicy(policy: unknown): DelegationPolicy {
    const parsed = DelegationPolicySchema.safeParse(policy)
    if (!parsed.success) {
      throw new ValidationError('invalid delegation policy', { details: parsed.error.issues })
    }
    return parsed.data as DelegationPolicy
  }

  // Constructs the credential and signs it with the issuer's signing key IF that key is
  // resolvable in the keystore. If no issuer key is available, sig is left empty: this is an
  // admin-plane action recorded in the ledger, and in production the principal must sign the
  // credential out-of-band (the governance/test path supplies policy directly). The signed
  // payload omits ['sig'] so verifiers strip the same field.
  private async build(
    issuer: string,
    subject: string,
    policy: DelegationPolicy,
    expires: string,
  ): Promise<DelegationCredential> {
    const issued = this.clock.now()
    const base = {
      type: DELEGATION_TYPE,
      issuer,
      subject,
      policy,
      issued,
      expires,
      revocation: `praxis:revocations/${subject}`,
    }

    const sig = await this.signWithIssuer(issuer, base)
    return { ...base, sig }
  }

  private async signWithIssuer(issuer: string, base: Record<string, unknown>): Promise<string> {
    const passport = await this.passports.get(issuer)
    if (!passport) return ''
    const key = passportSigningKey(passport)
    if (!key) return ''
    const privateKey = await this.keystore.getSigningKey(signingKid(issuer, key.id))
    if (!privateKey) return ''
    const payload = stripForSigning({ ...base, sig: '' }, ['sig'])
    return signDetached(payload, privateKey, signingKid(issuer, key.id))
  }
}
