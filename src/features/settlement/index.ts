import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type {
  ApprovalPort,
  Clock,
  IdempotencyStore,
  IdentityResolver,
  Keystore,
  Ledger,
  PolicyEvaluator,
  RailRegistry,
  ReputationPort,
  UsagePort,
  ValueTransferPort,
  WalletQueryPort,
  WalletSigner,
  NonceStore,
} from '../../shared/ports/index'
import type { Money } from '../../domain/index'
import type { Config } from '../../shared/config/index'
import { buildRailRegistry } from '../../infrastructure/rail/index'
import type { CoreSigner } from './core-signer'
import {
  WalletService,
  MemoryWalletRepo,
  MemoryHoldRepo,
  MemorySpendRepo,
  type WalletRepo,
  type HoldRepo,
  type SpendRepo,
} from './wallet/index'
import { FacilitatorService, makeFacilitatorRoutes } from './facilitator/index'
import {
  EscrowService,
  makeEscrowRoutes,
  MemoryEscrowRepo,
  MemoryStakeRepo,
  type EscrowRepo,
  type StakeRepo,
} from './escrow/index'
import { StakeService, makeStakeRoutes } from './stake/index'

export type { CoreSigner } from './core-signer'
export { WalletService } from './wallet/index'
export { FacilitatorService } from './facilitator/index'
export { EscrowService } from './escrow/index'
export { StakeService } from './stake/index'
export { buildRailRegistry, getRailOrThrow } from '../../infrastructure/rail/index'

export interface SettlementFactoryDeps {
  readonly clock: Clock
  readonly nonces: NonceStore
  readonly idempotency: IdempotencyStore
  readonly identity: IdentityResolver
  readonly keystore: Keystore
  readonly policy: PolicyEvaluator
  readonly signer: WalletSigner
  readonly ledger: Ledger
  readonly reputation: ReputationPort
  readonly approvals: ApprovalPort
  // The facilitator's core signing identity (signs receipts). The container registers its public
  // key via identity (so receipts verify) and the private key in the keystore under its kid.
  readonly coreSigner: CoreSigner
  // The registry core DID that signs quotes; the facilitator verifies quotes against it.
  readonly registrySignerDid: string
  // Bound by the container to reputationService.setStake (setStake is not on ReputationPort).
  readonly onStakeChanged?: (did: string, total: string) => void
  readonly config: Config
  // Repos default to in-memory adapters the factory builds itself; supply pre-built ones to swap
  // persistence without touching the services.
  readonly wallets?: WalletRepo
  readonly holds?: HoldRepo
  readonly spends?: SpendRepo
  readonly escrows?: EscrowRepo
  readonly stakes?: StakeRepo
  // The facilitator URL advertised in PaymentRequirements; defaults to an internal marker.
  readonly facilitatorUrl?: string
}

export interface SettlementModule {
  readonly valueTransfer: ValueTransferPort
  readonly walletQuery: WalletQueryPort
  readonly usage: UsagePort
  readonly rails: RailRegistry
  readonly walletService: WalletService
  readonly facilitatorService: FacilitatorService
  readonly escrowService: EscrowService
  readonly stakeService: StakeService
  // Dev faucet: seed a wallet (calls valueTransfer.credit). Exposed as a method, not a route, so it
  // can never be reached over HTTP in production.
  readonly faucet: (did: string, amount: Money, currency?: string) => Promise<void>
  readonly routes: FastifyPluginAsyncZod
}

// Hexagonal factory for the settlement module: the internal value store + rails (the swap point) +
// the facilitator (atomic x402 pay) + escrow (commissioned jobs + dispute slashing) + stake/tip.
// Every collaborator is injected; repos default to in-memory adapters the factory constructs.
export const buildSettlement = (deps: SettlementFactoryDeps): SettlementModule => {
  const wallets: WalletRepo = deps.wallets ?? new MemoryWalletRepo()
  const holds: HoldRepo = deps.holds ?? new MemoryHoldRepo()
  const spends: SpendRepo = deps.spends ?? new MemorySpendRepo()
  const escrows: EscrowRepo = deps.escrows ?? new MemoryEscrowRepo()
  const stakes: StakeRepo = deps.stakes ?? new MemoryStakeRepo()

  const walletService = new WalletService({ clock: deps.clock, wallets, holds, spends })

  // Rails settle over the internal value store. This is the only place rail adapters are wired;
  // changing a payment rail never touches identity/policy/receipt logic.
  const rails = buildRailRegistry({ clock: deps.clock, valueTransfer: walletService })

  const facilitatorService = new FacilitatorService({
    clock: deps.clock,
    nonces: deps.nonces,
    idempotency: deps.idempotency,
    identity: deps.identity,
    signer: deps.signer,
    ledger: deps.ledger,
    reputation: deps.reputation,
    approvals: deps.approvals,
    rails,
    wallet: walletService,
    coreSigner: deps.coreSigner,
    registrySignerDid: deps.registrySignerDid,
    skewMs: deps.config.SIGNATURE_SKEW_MS,
    facilitatorUrl: deps.facilitatorUrl ?? 'praxis-internal-facilitator',
  })

  const escrowService = new EscrowService({
    clock: deps.clock,
    nonces: deps.nonces,
    identity: deps.identity,
    signer: deps.signer,
    ledger: deps.ledger,
    reputation: deps.reputation,
    approvals: deps.approvals,
    wallet: walletService,
    coreSigner: deps.coreSigner,
    escrows,
    stakes,
    skewMs: deps.config.SIGNATURE_SKEW_MS,
  })

  const stakeService = new StakeService({
    clock: deps.clock,
    nonces: deps.nonces,
    identity: deps.identity,
    signer: deps.signer,
    ledger: deps.ledger,
    approvals: deps.approvals,
    wallet: walletService,
    stakes,
    skewMs: deps.config.SIGNATURE_SKEW_MS,
    onStakeChanged: deps.onStakeChanged,
  })

  const faucet = async (did: string, amount: Money, currency?: string): Promise<void> => {
    const money: Money = currency ? { amount: amount.amount, currency } : amount
    await walletService.credit(did, money, `faucet:${did}`)
  }

  // Compose the three route plugins into one parent the container registers uniformly.
  const routes: FastifyPluginAsyncZod = async (app) => {
    await app.register(makeFacilitatorRoutes(facilitatorService))
    await app.register(makeEscrowRoutes(escrowService))
    await app.register(makeStakeRoutes(stakeService))
  }

  return {
    valueTransfer: walletService,
    walletQuery: walletService,
    usage: walletService,
    rails,
    walletService,
    facilitatorService,
    escrowService,
    stakeService,
    faucet,
    routes,
  }
}
