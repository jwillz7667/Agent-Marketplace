import { delegationIsExpired } from '../../domain/index'
import { signDetached } from '../../shared/crypto/index'
import type {
  WalletSigner as WalletSignerPort,
  ApprovalPort,
  PolicyEvaluator,
  PolicyAction,
  PolicyDecision,
  Clock,
  IdentityResolver,
  Keystore,
  UsagePort,
} from '../../shared/ports/index'

// WalletSigner — the §4.3 HARD STOP. Policy is enforced BELOW the agent at the signing
// boundary, NOT inside agent logic. This is the critical backstop against prompt injection
// (§15.8): even a fully hijacked agent cannot produce a signature that exceeds its delegated
// caps, because this signer independently re-runs the policy and resolves the key itself.
//
// It does NOT trust any "already checked" flag from a pre-flight Policy Engine call. Order:
//   1. resolve active delegation        -> none => deny
//   2. revocation / kill-switch check   -> revoked => deny
//   3. expiry check (needs the clock)   -> expired => deny
//   4. read spend usage
//   5. independent policy.evaluate(...) -> allow | needs_approval | deny
//   6. on needs_approval: redeem a matching supervisor approval (single-use) or park
//   7. on allow (or redeemed approval): resolve agent key, sign detached JWS over the payload.

const deny = (...reasons: string[]): { ok: false; decision: PolicyDecision } => ({
  ok: false,
  decision: { result: 'deny', reasons },
})

export interface WalletSignerDeps {
  readonly clock: Clock
  readonly identity: IdentityResolver
  readonly keystore: Keystore
  readonly usage: UsagePort
  readonly policyEvaluator: PolicyEvaluator
  readonly approvals: ApprovalPort
}

export class WalletSigner implements WalletSignerPort {
  constructor(private readonly deps: WalletSignerDeps) {}

  async signWithinPolicy(input: {
    did: string
    payload: unknown
    action: PolicyAction
    approvalId?: string
  }): Promise<{ ok: true; sig: string } | { ok: false; decision: PolicyDecision }> {
    const { clock, identity, keystore, usage, policyEvaluator, approvals } = this.deps
    const { did, payload, action, approvalId } = input

    const delegation = await identity.activeDelegation(did)
    if (delegation === null) return deny('no active delegation')

    // Kill switch (§10.2): a revoked principal->agent delegation stops the signer immediately.
    if (await identity.isRevoked(did)) return deny('revoked / kill-switch')

    // Expiry is checked here (the signer has the clock); the pure evaluator cannot.
    if (delegationIsExpired(delegation, clock.now())) return deny('delegation expired')

    const spendUsage = await usage.usage(did)

    const decision = policyEvaluator.evaluate(delegation, action, spendUsage)
    if (decision.result === 'deny') return { ok: false, decision }
    if (decision.result === 'needs_approval') {
      // An over-threshold action signs ONLY if a matching, approved, not-yet-consumed supervisor
      // clearance is presented. Without one, park (return needs_approval). The approval is redeemed
      // here — at the signing boundary — so it is single-use and bound to exactly this action; a
      // revoked/expired delegation already short-circuited above, so an approval can never resurrect
      // a killed agent. consume() throws on a missing/pending/already-consumed/mismatched approval;
      // that surfaces as a typed error to the caller (a bad approval id is a client error, not a
      // policy outcome). A denied approval declines without signing.
      if (approvalId === undefined) return { ok: false, decision }
      const redeemed = await approvals.consume(approvalId, { agent: did, action })
      if (redeemed.decision !== 'approved') {
        return deny(`approval ${approvalId} was ${redeemed.decision ?? 'not approved'}`)
      }
    }

    // Resolve the agent's signing key. The kid convention is `${did}${keyId}` where keyId is the
    // passport key id (e.g. "#sign-1"), matching how identity registers keys in the keystore.
    const passport = await identity.resolvePassport(did)
    if (passport === null) return deny('no passport')
    const firstKey = passport.keys[0]
    if (firstKey === undefined) return deny('no signing key')
    const kid = `${did}${firstKey.id}`

    const privateKey = await keystore.getSigningKey(kid)
    if (privateKey === null) return deny('no signing key')

    const sig = await signDetached(payload, privateKey, kid)
    return { ok: true, sig }
  }
}
