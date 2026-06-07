import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { Clock, ReputationPort } from '../../shared/ports/index'
import { MemoryAccumulatorRepo, MemorySnapshotCacheRepo } from './memory'
import { makeReputationRoutes } from './routes'
import { type CoreSigner, ReputationService } from './reputation.service'

export type { CoreSigner } from './reputation.service'
export { ReputationService } from './reputation.service'

// The container wires these. `reputation` is the port settlement and others consume;
// `reputationService` is the concrete instance carrying setStake (which is NOT on the
// port — only settlement, holding the admin handle, may bond/slash stake, §4.3/§9.1).
export interface ReputationModule {
  readonly reputation: ReputationPort
  readonly reputationService: ReputationService
  readonly routes: FastifyPluginAsyncZod
}

export interface BuildReputationDeps {
  readonly clock: Clock
  readonly coreSigner: CoreSigner
}

// Hexagonal factory: constructs its own in-memory repos by default and returns the port,
// the concrete service (with setStake), and the Fastify route plugin.
export const buildReputation = (deps: BuildReputationDeps): ReputationModule => {
  const service = new ReputationService({
    clock: deps.clock,
    coreSigner: deps.coreSigner,
    accumulators: new MemoryAccumulatorRepo(),
    snapshots: new MemorySnapshotCacheRepo(),
  })

  return {
    reputation: service,
    reputationService: service,
    routes: makeReputationRoutes(service),
  }
}
