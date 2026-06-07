import type {
  Clock,
  IdentityResolver,
  NonceStore,
  PolicyEvaluator,
  ReputationPort,
  ValueTransferPort,
} from '../../shared/ports/index'
import { MailroomService, type CoreSigner, type MailroomConfig } from './service'
import {
  MemoryFlagRepo,
  MemoryMessageRepo,
  MemoryPostageRepo,
  MemoryThreadRepo,
  MemoryWebhookRepo,
} from './memory'
import type { FlagRepo, MessageRepo, PostageRepo, ThreadRepo, WebhookRepo } from './repo'
import { makeMailroomRoutes } from './routes'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

// Public surface of the mailroom feature (§7, §14.2 MAILROOM).
export {
  MailroomService,
  DEFAULT_POSTAGE_AMOUNT,
  DEFAULT_POSTAGE_CURRENCY,
  type CoreSigner,
  type MailroomConfig,
  type MailroomDeps,
} from './service'
export type {
  MessageRepo,
  ThreadRepo,
  PostageRepo,
  WebhookRepo,
  FlagRepo,
  StoredMessage,
  ThreadRecord,
  WebhookRecord,
} from './repo'
export {
  MemoryMessageRepo,
  MemoryThreadRepo,
  MemoryPostageRepo,
  MemoryWebhookRepo,
  MemoryFlagRepo,
} from './memory'
export { makeMailroomRoutes } from './routes'
export type {
  Agreement,
  SendMessageInput,
  SendResponse,
  InboxQueryInput,
  InboxResponse,
  WebhookRegisterInput,
  WebhookResponse,
  FlagBodyInput,
  FlagResponse,
} from './schema'
export {
  SendMessageSchema,
  SendResponseSchema,
  AgreementSchema,
  InboxQuerySchema,
  InboxResponseSchema,
  WebhookRegisterSchema,
  WebhookResponseSchema,
  FlagBodySchema,
  FlagResponseSchema,
} from './schema'

export interface MailroomFactoryDeps {
  readonly clock: Clock
  readonly nonces: NonceStore
  readonly identity: IdentityResolver
  readonly valueTransfer: ValueTransferPort
  readonly policy: PolicyEvaluator
  readonly reputation: ReputationPort
  readonly coreSigner: CoreSigner
  readonly config: MailroomConfig
  // Repos are constructed by the factory by default; supply pre-built ones to swap persistence.
  readonly messages?: MessageRepo
  readonly threads?: ThreadRepo
  readonly postage?: PostageRepo
  readonly webhooks?: WebhookRepo
  readonly flags?: FlagRepo
}

export interface MailroomModule {
  readonly mailroomService: MailroomService
  readonly routes: FastifyPluginAsyncZod
}

// Hexagonal factory: every collaborator is injected; repos default to in-memory adapters the
// factory constructs itself. Returns the service + a Fastify route plugin the container
// registers uniformly.
export const buildMailroom = (deps: MailroomFactoryDeps): MailroomModule => {
  const messages: MessageRepo = deps.messages ?? new MemoryMessageRepo()
  const threads: ThreadRepo = deps.threads ?? new MemoryThreadRepo()
  const postage: PostageRepo = deps.postage ?? new MemoryPostageRepo()
  const webhooks: WebhookRepo = deps.webhooks ?? new MemoryWebhookRepo()
  const flags: FlagRepo = deps.flags ?? new MemoryFlagRepo()

  const mailroomService = new MailroomService({
    clock: deps.clock,
    nonces: deps.nonces,
    identity: deps.identity,
    valueTransfer: deps.valueTransfer,
    policy: deps.policy,
    reputation: deps.reputation,
    coreSigner: deps.coreSigner,
    config: deps.config,
    messages,
    threads,
    postage,
    webhooks,
    flags,
  })

  return { mailroomService, routes: makeMailroomRoutes(mailroomService) }
}
