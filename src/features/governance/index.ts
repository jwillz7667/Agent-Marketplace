import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { Config } from '../../shared/config/index'
import type {
  ApprovalPort,
  Clock,
  DelegationAdminPort,
  IdentityResolver,
  Ledger,
  ReputationPort,
  WalletQueryPort,
} from '../../shared/ports/index'
import { ApprovalQueue } from './approvals'
import { MemoryApprovalRepo } from './memory'
import type { ApprovalRepo } from './repo'
import { GovernanceService } from './service'
import { makeGovernanceRoutes } from './routes'

// Public surface of the governance feature (§12, §14.2 GOVERNANCE/CONTROL).
export { GovernanceService, GOV_AUDIT_KIND } from './service'
export type { GovAgentView, AuditView, AuditFilter, GovernanceDeps } from './service'
export { ApprovalQueue } from './approvals'
export type { ApprovalDecision } from './approvals'
export type { ApprovalRepo } from './repo'
export { MemoryApprovalRepo } from './memory'
export { makeGovernanceRoutes } from './routes'
export type { GovernanceRoutesDeps } from './routes'
export * from './schema'

export interface GovernanceFactoryDeps {
  readonly clock: Clock
  readonly config: Config
  readonly identity: IdentityResolver
  readonly delegationAdmin: DelegationAdminPort
  readonly walletQuery: WalletQueryPort
  readonly reputation: ReputationPort
  readonly ledger: Ledger
  // The approval repo is constructed by the factory by default; supply a pre-built one to
  // swap persistence (e.g. a durable queue) without touching the service.
  readonly approvals?: ApprovalRepo
}

export interface GovernanceModule {
  // The ApprovalPort implementation the Settlement / Mailroom modules park into (§4.3, §12).
  readonly approvals: ApprovalPort
  readonly governanceService: GovernanceService
  readonly routes: FastifyPluginAsyncZod
}

// Hexagonal factory: every collaborator is injected; the approval repo defaults to the
// in-memory adapter. Returns the ApprovalPort impl (consumed by other modules), the
// GovernanceService, and a Fastify route plugin with the supervisor bearer guard applied to
// every route. The bearer token is read from the injected config, never process.env.
export const buildGovernance = (deps: GovernanceFactoryDeps): GovernanceModule => {
  const approvalRepo: ApprovalRepo = deps.approvals ?? new MemoryApprovalRepo()
  const approvals = new ApprovalQueue(approvalRepo, deps.clock)

  const governanceService = new GovernanceService({
    clock: deps.clock,
    identity: deps.identity,
    delegationAdmin: deps.delegationAdmin,
    walletQuery: deps.walletQuery,
    reputation: deps.reputation,
    ledger: deps.ledger,
    approvals,
  })

  return {
    approvals,
    governanceService,
    routes: makeGovernanceRoutes({ service: governanceService, govApiKey: deps.config.GOV_API_KEY }),
  }
}
