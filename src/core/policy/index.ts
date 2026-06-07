import type { ApprovalPort, Clock, IdentityResolver, Keystore, UsagePort } from '../../shared/ports/index'
import { PolicyEvaluator } from './evaluator'
import { WalletSigner } from './signer'

export { PolicyEvaluator } from './evaluator'
export { WalletSigner } from './signer'
export type { WalletSignerDeps } from './signer'

export interface PolicyModuleDeps {
  readonly clock: Clock
  readonly identity: IdentityResolver
  readonly keystore: Keystore
  readonly usage: UsagePort
  readonly approvals: ApprovalPort
}

export interface PolicyModule {
  readonly policyEvaluator: PolicyEvaluator
  readonly signer: WalletSigner
  readonly routes: null
}

// Factory: the SAFETY CORE. The evaluator is pure; the signer composes it with the clock,
// identity resolver, keystore, and usage port to form the §4.3 below-the-agent hard stop.
// This module exposes no HTTP surface (routes: null).
export const buildPolicy = (deps: PolicyModuleDeps): PolicyModule => {
  const policyEvaluator = new PolicyEvaluator()
  const signer = new WalletSigner({
    clock: deps.clock,
    identity: deps.identity,
    keystore: deps.keystore,
    usage: deps.usage,
    policyEvaluator,
    approvals: deps.approvals,
  })
  return { policyEvaluator, signer, routes: null }
}
