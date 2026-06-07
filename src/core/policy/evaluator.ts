import type { DelegationCredential, Money } from '../../domain/index'
import { mGt, mAdd, mZero, taxonomyAllowed, matchTaxonomy } from '../../domain/index'
import type {
  PolicyEvaluator as PolicyEvaluatorPort,
  PolicyAction,
  PolicyDecision,
  SpendUsage,
} from '../../shared/ports/index'

// PolicyEvaluator (§4.3 pre-flight + the cap logic the signer hard-stop re-runs).
// PURE: no IO, no clock, no instance state. Expiry/revocation are owned by the signer
// (which has a clock + identity resolver); this evaluator defends spend / category /
// counterparty / surface caps only.
//
// Deny-by-default: `allow` is returned ONLY when an explicit allow path is reached for a
// known action kind. Any unknown kind or ambiguous state denies.

const deny = (...reasons: string[]): PolicyDecision => ({ result: 'deny', reasons })
const allow = (): PolicyDecision => ({ result: 'allow' })
const needsApproval = (threshold: Money, ...reasons: string[]): PolicyDecision => ({
  result: 'needs_approval',
  threshold,
  reasons,
})

// Counterparty matching reuses taxonomy glob semantics ('*' = any, exact DID otherwise).
// deny-list wins over allow; absence from the allow-list is a denial.
const counterpartyAllowed = (
  counterparty: string,
  allowList: readonly string[],
  denyList: readonly string[],
): boolean => {
  if (denyList.some((p) => matchTaxonomy(p, counterparty))) return false
  return allowList.some((p) => matchTaxonomy(p, counterparty))
}

// Pull the matching usage figure in the charge currency, defaulting to zero. Cross-currency
// usage is treated as zero in the charge currency: aggregating across currencies is undefined
// and must never silently let a charge slip under a cap.
const usageIn = (m: Money, currency: string): Money =>
  m.currency === currency ? m : mZero(currency)

// Approval-threshold check, shared by spend/tip and escrow.
const approvalTail = (amount: Money, threshold: Money): PolicyDecision => {
  if (amount.currency === threshold.currency && mGt(amount, threshold)) {
    return needsApproval(threshold, `amount ${amount.amount} exceeds approval threshold ${threshold.amount}`)
  }
  return allow()
}

export class PolicyEvaluator implements PolicyEvaluatorPort {
  evaluate(delegation: DelegationCredential, action: PolicyAction, usage: SpendUsage): PolicyDecision {
    const { policy } = delegation

    // Counterparty gate applies to any kind that names a counterparty. A denied counterparty
    // short-circuits regardless of action kind.
    if (action.counterparty !== undefined) {
      const cp = action.counterparty
      if (!counterpartyAllowed(cp, policy.counterparties_allow, policy.counterparties_deny)) {
        const denied = policy.counterparties_deny.some((p) => matchTaxonomy(p, cp))
        return deny(denied ? `counterparty denied: ${cp}` : `counterparty not allowed: ${cp}`)
      }
    }

    switch (action.kind) {
      case 'spend':
      case 'tip':
        return evaluateSpend(delegation, action, usage)
      case 'message':
        return evaluateMessage(delegation)
      case 'post':
        return evaluatePost(delegation, action)
      case 'escrow':
        return evaluateEscrow(delegation, action)
      case 'stake':
        return evaluateStake(delegation)
      default:
        // DENY BY DEFAULT: an unknown kind is never implicitly authorized.
        return deny(`unknown action kind: ${String((action as { kind?: unknown }).kind)}`)
    }
  }
}

const evaluateSpend = (
  delegation: DelegationCredential,
  action: PolicyAction,
  usage: SpendUsage,
): PolicyDecision => {
  const { policy } = delegation
  const { spend } = policy

  if (action.category === undefined) return deny('spend requires a category')
  if (action.amount === undefined) return deny('spend requires an amount')
  const amount = action.amount

  if (!taxonomyAllowed(action.category, policy.categories_allow, policy.categories_deny)) {
    return deny(`category not allowed: ${action.category}`)
  }

  // Currency must match the policy caps; cross-currency comparison is meaningless (and big.js
  // throws), so reject explicitly rather than letting it blow up.
  if (amount.currency !== spend.per_tx_max.currency) {
    return deny(`currency mismatch: ${amount.currency} vs policy ${spend.per_tx_max.currency}`)
  }

  if (mGt(amount, spend.per_tx_max)) {
    return deny(`per_tx_max exceeded: ${amount.amount} > ${spend.per_tx_max.amount}`)
  }

  // Daily window: today's spend + this charge must fit under the cap.
  const dailyTotal = mAdd(usageIn(usage.dailySpent, amount.currency), amount)
  if (mGt(dailyTotal, spend.daily_max)) {
    return deny(`daily_max exceeded: ${dailyTotal.amount} > ${spend.daily_max.amount}`)
  }

  // Lifetime window: total spend + this charge must fit under the cap.
  const totalTotal = mAdd(usageIn(usage.totalSpent, amount.currency), amount)
  if (mGt(totalTotal, spend.total_max)) {
    return deny(`total_max exceeded: ${totalTotal.amount} > ${spend.total_max.amount}`)
  }

  return approvalTail(amount, policy.require_human_approval_over)
}

const evaluateMessage = (delegation: DelegationCredential): PolicyDecision => {
  if (delegation.policy.messaging.send !== true) return deny('messaging.send is disabled')
  // The per-day postage cap is enforced by the mailroom against postage usage; the policy
  // layer only gates that sending is permitted at all.
  return allow()
}

const evaluatePost = (delegation: DelegationCredential, action: PolicyAction): PolicyDecision => {
  const { posting } = delegation.policy
  const postingEnabled = posting.offers || posting.rfps
  if (!postingEnabled) return deny('posting is disabled')
  if (action.subKind === 'offer' && posting.offers !== true) return deny('posting.offers is disabled')
  if (action.subKind === 'rfp' && posting.rfps !== true) return deny('posting.rfps is disabled')
  // Other post subkinds (e.g. PRICE_SIGNAL, WORK_RECORD) are allowed when posting is enabled.
  return allow()
}

const evaluateEscrow = (delegation: DelegationCredential, action: PolicyAction): PolicyDecision => {
  const { escrow } = delegation.policy
  if (escrow.may_commit !== true) return deny('escrow.may_commit is disabled')
  if (action.amount === undefined) return deny('escrow requires an amount')
  const amount = action.amount
  if (amount.currency !== escrow.max_escrow.currency) {
    return deny(`currency mismatch: ${amount.currency} vs escrow ${escrow.max_escrow.currency}`)
  }
  if (mGt(amount, escrow.max_escrow)) {
    return deny(`max_escrow exceeded: ${amount.amount} > ${escrow.max_escrow.amount}`)
  }
  return approvalTail(amount, delegation.policy.require_human_approval_over)
}

const evaluateStake = (delegation: DelegationCredential): PolicyDecision => {
  if (delegation.policy.may_stake !== true) return deny('may_stake is disabled')
  return allow()
}
