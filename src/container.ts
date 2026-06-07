// Composition root. Builds every module factory and wires the cross-module ports.
//
// Two dependency cycles exist between modules and are resolved with lazy port proxies that
// are bound once all participants are constructed (requests only arrive after wiring):
//   1. policy <-> settlement: the WalletSigner needs a UsagePort, which the settlement
//      wallet implements; settlement needs the WalletSigner. We build policy first against a
//      lazy UsagePort, then bind it to settlement.usage.
//   2. settlement <-> governance: settlement parks needs-approval actions into the
//      ApprovalPort that governance implements; governance reads settlement's WalletQueryPort.
//      We build settlement against a lazy ApprovalPort, then bind it to governance.approvals.
//
// All collaborators are injected; no module reads process.env or reaches a global.

import { didFromPublicKey, generateKeyPair } from './shared/crypto/index'
import { SystemClock } from './shared/time/clock'
import { createLogger, type Logger } from './shared/logger/index'
import { MemoryNonceStore } from './infrastructure/persistence/memory/nonce-store'
import { MemoryIdempotencyStore } from './infrastructure/persistence/memory/idempotency-store'
import type { Config } from './shared/config/index'
import type {
  ApprovalPort,
  Clock,
  PendingApproval,
  PolicyAction,
  SpendUsage,
  UsagePort,
} from './shared/ports/index'

import { buildIdentity, type IdentityModule } from './core/identity/index'
import { buildPolicy, type PolicyModule } from './core/policy/index'
import { buildLedger, type LedgerModule } from './core/ledger/index'
import { buildReputation, type ReputationModule } from './core/reputation/index'
import { buildRegistry, type RegistryModule } from './features/registry/index'
import { buildSettlement, type SettlementModule } from './features/settlement/index'
import { buildMailroom, type MailroomModule } from './features/mailroom/index'
import { buildBoard, type BoardModule } from './features/board/index'
import { buildGovernance, type GovernanceModule } from './features/governance/index'

// A core (system) signing identity. The container generates each, registers its public key so
// core-signed objects (quotes, receipts, snapshots, agreements) verify, and stores its private
// key in the keystore under `kid`.
export interface CoreSignerIdentity {
  readonly did: string
  readonly kid: string
  readonly privateKey: Uint8Array
  readonly publicKey: Uint8Array
}

export interface CoreSigners {
  readonly reputation: CoreSignerIdentity
  readonly registry: CoreSignerIdentity
  readonly facilitator: CoreSignerIdentity
  readonly mailroom: CoreSignerIdentity
}

export interface Container {
  readonly config: Config
  readonly clock: Clock
  readonly logger: Logger
  readonly identity: IdentityModule
  readonly policy: PolicyModule
  readonly ledger: LedgerModule
  readonly reputation: ReputationModule
  readonly settlement: SettlementModule
  readonly registry: RegistryModule
  readonly mailroom: MailroomModule
  readonly board: BoardModule
  readonly governance: GovernanceModule
  readonly coreSigners: CoreSigners
}

const makeCoreSigner = async (): Promise<CoreSignerIdentity> => {
  const { privateKey, publicKey } = await generateKeyPair()
  const did = didFromPublicKey(publicKey, 'core')
  return { did, kid: `${did}#sign-1`, privateKey, publicKey }
}

// A lazily-bound UsagePort: holds the call until the real implementation is wired.
const makeLazyUsage = (): { port: UsagePort; bind: (impl: UsagePort) => void } => {
  let impl: UsagePort | null = null
  return {
    port: {
      usage: (did: string): Promise<SpendUsage> => {
        if (!impl) throw new Error('container: UsagePort used before wiring')
        return impl.usage(did)
      },
    },
    bind: (i) => {
      impl = i
    },
  }
}

// A lazily-bound ApprovalPort: holds the call until governance is wired.
const makeLazyApprovals = (): { port: ApprovalPort; bind: (impl: ApprovalPort) => void } => {
  let impl: ApprovalPort | null = null
  return {
    port: {
      enqueue: (input: { agent: string; action: PolicyAction; payload: unknown }): Promise<PendingApproval> => {
        if (!impl) throw new Error('container: ApprovalPort used before wiring')
        return impl.enqueue(input)
      },
      status: (approvalId: string): Promise<PendingApproval | null> => {
        if (!impl) throw new Error('container: ApprovalPort used before wiring')
        return impl.status(approvalId)
      },
      consume: (approvalId: string, expect: { agent: string; action: PolicyAction }): Promise<PendingApproval> => {
        if (!impl) throw new Error('container: ApprovalPort used before wiring')
        return impl.consume(approvalId, expect)
      },
    },
    bind: (i) => {
      impl = i
    },
  }
}

// Builds and wires the full backend. Async because key generation and core-identity seeding are.
export const buildContainer = async (config: Config): Promise<Container> => {
  const clock: Clock = new SystemClock()
  const logger = createLogger(config)
  const nonces = new MemoryNonceStore(clock)
  const idempotency = new MemoryIdempotencyStore()

  // Core signing identities (one per system signer surface).
  const coreSigners: CoreSigners = {
    reputation: await makeCoreSigner(),
    registry: await makeCoreSigner(),
    facilitator: await makeCoreSigner(),
    mailroom: await makeCoreSigner(),
  }

  // Identity is foundational: it owns the Keystore and DID resolution.
  const identity = buildIdentity({ clock, nonces, config })

  // Make each core signer resolvable (public key) and signable (private key in keystore).
  for (const signer of Object.values(coreSigners)) {
    await identity.admin.seedCoreIdentity({
      did: signer.did,
      kid: signer.kid,
      privateKey: signer.privateKey,
      publicKey: signer.publicKey,
      controller: signer.did, // core identities are self-controlled
    })
  }

  const ledger = buildLedger({ clock })
  const reputation = buildReputation({ clock, coreSigner: coreSigners.reputation })

  const lazyUsage = makeLazyUsage()
  const lazyApprovals = makeLazyApprovals()

  // Policy (the safety core). Signer enforces caps below the agent; its UsagePort is bound to
  // settlement after settlement is constructed.
  const policy = buildPolicy({
    clock,
    identity: identity.identityResolver,
    keystore: identity.keystore,
    usage: lazyUsage.port,
    approvals: lazyApprovals.port,
  })

  const settlement = buildSettlement({
    clock,
    nonces,
    idempotency,
    identity: identity.identityResolver,
    keystore: identity.keystore,
    policy: policy.policyEvaluator,
    signer: policy.signer,
    ledger: ledger.ledger,
    reputation: reputation.reputation,
    approvals: lazyApprovals.port,
    coreSigner: coreSigners.facilitator,
    registrySignerDid: coreSigners.registry.did,
    onStakeChanged: (did, total) => {
      // Stake bonded/slashed in settlement feeds the reputation stake metric. Fire-and-forget;
      // a failure here must not roll back a settled stake, so we log instead of throwing.
      reputation.reputationService
        .setStake(did, total)
        .catch((err: unknown) => logger.error({ err, did }, 'reputation.setStake failed'))
    },
    config,
  })
  lazyUsage.bind(settlement.usage)

  const governance = buildGovernance({
    clock,
    config,
    identity: identity.identityResolver,
    delegationAdmin: identity.delegationAdmin,
    walletQuery: settlement.walletQuery,
    reputation: reputation.reputation,
    ledger: ledger.ledger,
  })
  lazyApprovals.bind(governance.approvals)

  const registry = buildRegistry({
    clock,
    nonces,
    identity: identity.identityResolver,
    reputation: reputation.reputation,
    coreSigner: coreSigners.registry,
    config,
  })

  const mailroom = buildMailroom({
    clock,
    nonces,
    identity: identity.identityResolver,
    valueTransfer: settlement.valueTransfer,
    policy: policy.policyEvaluator,
    reputation: reputation.reputation,
    coreSigner: coreSigners.mailroom,
    config,
  })

  const board = buildBoard({
    clock,
    nonces,
    idempotency,
    identity: identity.identityResolver,
    valueTransfer: settlement.valueTransfer,
    policy: policy.policyEvaluator,
    reputation: reputation.reputation,
    ledger: ledger.ledger,
    config,
  })

  return {
    config,
    clock,
    logger,
    identity,
    policy,
    ledger,
    reputation,
    settlement,
    registry,
    mailroom,
    board,
    governance,
    coreSigners,
  }
}
