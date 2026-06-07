import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { Clock, IdentityResolver, NonceStore, ReputationPort } from '../../shared/ports/index'
import type { Config } from '../../shared/config/index'
import { RegistryService, type CoreSigner } from './service'
import { MemoryListingRepo, MemoryQuoteRepo } from './memory'
import type { ListingRepo, QuoteRepo } from './repo'
import { makeRegistryRoutes } from './routes'

// Public surface of the registry feature (§2, §3, §5.2, §9.4, §14.2 REGISTRY).
export type { CoreSigner, RegistryDeps, SignedDryRun } from './service'
export { RegistryService } from './service'
export type { ListingRepo, QuoteRepo } from './repo'
export { MemoryListingRepo, MemoryQuoteRepo } from './memory'
export { makeRegistryRoutes } from './routes'
export {
  hardFilter,
  rankSurvivors,
  descriptionSimilarity,
  DEFAULT_WEIGHTS,
  SEMANTIC_SIMILARITY_THRESHOLD,
} from './ranking'

export interface RegistryFactoryDeps {
  readonly clock: Clock
  readonly nonces: NonceStore
  readonly identity: IdentityResolver
  readonly reputation: ReputationPort
  readonly coreSigner: CoreSigner
  readonly config: Config
  // Repos are constructed by the factory by default; supply pre-built ones to swap persistence.
  readonly listings?: ListingRepo
  readonly quotes?: QuoteRepo
}

export interface RegistryModule {
  readonly registryService: RegistryService
  readonly routes: FastifyPluginAsyncZod
}

// Hexagonal factory: every collaborator is injected; repos default to in-memory adapters
// the factory constructs itself. Returns the service + a Fastify route plugin the container
// registers uniformly.
export const buildRegistry = (deps: RegistryFactoryDeps): RegistryModule => {
  const listings: ListingRepo = deps.listings ?? new MemoryListingRepo()
  const quotes: QuoteRepo = deps.quotes ?? new MemoryQuoteRepo()

  const registryService = new RegistryService({
    clock: deps.clock,
    nonces: deps.nonces,
    identity: deps.identity,
    reputation: deps.reputation,
    coreSigner: deps.coreSigner,
    config: deps.config,
    listings,
    quotes,
  })

  return { registryService, routes: makeRegistryRoutes(registryService) }
}
