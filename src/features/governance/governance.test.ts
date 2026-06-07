import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { hashChain, merkleRoot } from '../../shared/crypto/index'
import { isAppError } from '../../shared/errors'
import { FixedClock } from '../../shared/time/clock'
import type {
  Clock,
  DelegationAdminPort,
  IdentityResolver,
  Ledger,
  LedgerEntry,
  PrincipalAgentEntry,
  ReputationPort,
  WalletBalanceRow,
  WalletQueryPort,
} from '../../shared/ports/index'
import type {
  DelegationCredential,
  DelegationPolicy,
  Passport,
  Receipt,
  ReputationMetrics,
  ReputationSnapshot,
} from '../../domain/index'
import type { Config } from '../../shared/config/index'
import { buildGovernance, GOV_AUDIT_KIND, type GovernanceModule, type DelegationPolicyInput } from './index'

// ---------------------------------------------------------------------------
// Test doubles. The Ledger is a faithful hash-chained implementation (not a stub) so
// verifyChain() is meaningfully true and tampering would break it. The admin/wallet/
// reputation/identity ports are minimal fakes covering exactly the contract the governance
// plane reads/writes.
// ---------------------------------------------------------------------------

const PRINCIPAL = 'did:praxis:org:acme'
const AGENT_A = 'did:praxis:agent:a'
const AGENT_B = 'did:praxis:agent:b'
const GOV_KEY = 'super-secret-supervisor-token'

const TEST_CONFIG: Config = {
  PORT: 8080,
  NODE_ENV: 'test',
  PERSISTENCE: 'memory',
  GOV_API_KEY: GOV_KEY,
  LOG_LEVEL: 'silent',
  SIGNATURE_SKEW_MS: 2000,
}

const GENESIS_PREV_HASH = '0'.repeat(64)

const hashedContent = (e: Pick<LedgerEntry, 'seq' | 'ts' | 'kind' | 'subject' | 'payload'>) => ({
  seq: e.seq,
  ts: e.ts,
  kind: e.kind,
  subject: e.subject,
  payload: e.payload,
})

// Hand-rolled in-test Ledger implementing the port with real hash-chain semantics, mirroring
// the production LedgerService link convention so verifyChain() exercises a genuine chain.
class FakeLedger implements Ledger {
  private readonly entries: LedgerEntry[] = []
  constructor(private readonly clock: Clock) {}

  async append(input: { kind: string; subject?: string; payload: unknown }): Promise<LedgerEntry> {
    const prev = this.entries[this.entries.length - 1]
    const seq = prev ? prev.seq + 1 : 1
    const prevHash = prev ? prev.hash : GENESIS_PREV_HASH
    const ts = this.clock.now()
    const content = hashedContent({ seq, ts, kind: input.kind, subject: input.subject, payload: input.payload })
    const hash = hashChain(prevHash, content)
    const entry: LedgerEntry = {
      seq,
      prevHash,
      hash,
      ts,
      kind: input.kind,
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      payload: input.payload,
    }
    this.entries.push(entry)
    return entry
  }

  async list(filter: { kind?: string; subject?: string; since?: number; until?: string; from?: string } = {}): Promise<LedgerEntry[]> {
    return this.entries.filter((e) => {
      if (filter.kind !== undefined && e.kind !== filter.kind) return false
      if (filter.subject !== undefined && e.subject !== filter.subject) return false
      if (filter.since !== undefined && e.seq < filter.since) return false
      return true
    })
  }

  async merkleRoot(): Promise<string> {
    return merkleRoot(this.entries.map((e) => e.hash))
  }

  async verifyChain(): Promise<boolean> {
    let prevHash = GENESIS_PREV_HASH
    let prevSeq = 0
    for (const e of this.entries) {
      if (e.seq !== prevSeq + 1) return false
      if (e.prevHash !== prevHash) return false
      if (e.hash !== hashChain(prevHash, hashedContent(e))) return false
      prevHash = e.hash
      prevSeq = e.seq
    }
    return true
  }

  // Test-only escape hatch to corrupt the chain and prove verifyChain() catches it.
  tamper(seq: number, mutate: (e: LedgerEntry) => LedgerEntry): void {
    const idx = this.entries.findIndex((e) => e.seq === seq)
    if (idx >= 0) this.entries[idx] = mutate(this.entries[idx]!)
  }
}

const money = (amount: string, currency = 'USDC') => ({ amount, currency })

const samplePolicy = (perTx = '1.00'): DelegationPolicyInput => ({
  spend: { per_tx_max: money(perTx), daily_max: money('10.00'), total_max: money('100.00') },
  categories_allow: ['doc.*'],
  categories_deny: ['payments.*'],
  counterparties_allow: [],
  counterparties_deny: [],
  require_human_approval_over: money('5.00'),
  messaging: { send: true, max_postage_per_day: '0.50' },
  posting: { offers: true, rfps: false, max_post_spend_per_day: '1.00' },
  escrow: { may_commit: true, max_escrow: money('50.00') },
  may_stake: false,
})

const credentialFor = (subject: string, policy: DelegationPolicy, issued: string): DelegationCredential => ({
  type: ['VerifiableCredential', 'PraxisDelegation'],
  issuer: PRINCIPAL,
  subject,
  policy,
  issued,
  expires: '2027-01-01T00:00:00.000Z',
  revocation: `praxis:revocations/${subject}`,
  sig: 'fake.sig',
})

// FakeDelegationAdmin holds per-agent credentials; update re-issues with the new policy and a
// fresh `issued`; revoke records the kill so the test can assert it fired.
class FakeDelegationAdmin implements DelegationAdminPort {
  readonly creds = new Map<string, DelegationCredential>()
  readonly revoked = new Set<string>()
  private readonly entries: PrincipalAgentEntry[] = []

  constructor(private readonly clock: Clock) {}

  seedAgent(did: string, policy: DelegationPolicy): void {
    const cred = credentialFor(did, policy, this.clock.now())
    this.creds.set(did, cred)
    this.entries.push({ did, delegation: cred })
  }

  async issue(input: { issuer: string; subject: string; policy: unknown; expires: string }): Promise<DelegationCredential> {
    const cred = credentialFor(input.subject, input.policy as DelegationPolicy, this.clock.now())
    this.creds.set(input.subject, cred)
    return cred
  }

  async update(subjectDid: string, policy: unknown): Promise<DelegationCredential> {
    const cred = credentialFor(subjectDid, policy as DelegationPolicy, this.clock.now())
    this.creds.set(subjectDid, cred)
    const e = this.entries.find((x) => x.did === subjectDid)
    if (e) e.delegation = cred
    return cred
  }

  async revoke(subjectDid: string): Promise<void> {
    this.revoked.add(subjectDid)
  }

  async listByPrincipal(_principal: string): Promise<PrincipalAgentEntry[]> {
    return this.entries.map((e) => ({ ...e }))
  }
}

class FakeWalletQuery implements WalletQueryPort {
  private readonly rows = new Map<string, WalletBalanceRow[]>()
  set(did: string, rows: WalletBalanceRow[]): void {
    this.rows.set(did, rows)
  }
  async balances(did: string): Promise<WalletBalanceRow[]> {
    return this.rows.get(did) ?? []
  }
}

class FakeReputation implements ReputationPort {
  private readonly snaps = new Map<string, ReputationSnapshot>()
  set(did: string, trust: number, jobs: number): void {
    const metrics: ReputationMetrics = {
      success_rate: 0.99,
      dispute_rate: 0.004,
      refund_rate: 0.006,
      latency_ms: { p50: 870, p95: 3100 },
      uptime: 0.997,
      jobs,
      settled_value: '421.55',
      stake: '250.00',
      first_seen: '2025-12-02T00:00:00Z',
      last_settled: '2026-06-05T00:00:00Z',
      counterparty_diversity: 0.9,
      spam_flags: 0,
      post_flags: 0,
    }
    this.snaps.set(did, {
      snapshot_id: `rep_${did}`,
      subject: did,
      window: '30d',
      metrics,
      trust,
      issued: '2026-06-06T00:00:00Z',
      expires: '2026-06-07T00:00:00Z',
      issuer: 'did:praxis:core:reputation',
      sig: 'test',
    })
  }
  async getSnapshot(did: string): Promise<ReputationSnapshot | null> {
    return this.snaps.get(did) ?? null
  }
  async getRaw(): Promise<ReputationMetrics | null> {
    return null
  }
  async ingestReceipt(_r: Receipt): Promise<void> {}
  async ingestSignal(): Promise<void> {}
}

// FakeIdentity reports the active delegation so updatePolicy can capture the BEFORE policy.
class FakeIdentity implements IdentityResolver {
  constructor(private readonly admin: FakeDelegationAdmin) {}
  async resolvePassport(): Promise<Passport | null> {
    return null
  }
  async publicKeyFor(): Promise<Uint8Array | null> {
    return null
  }
  async activeDelegation(did: string): Promise<DelegationCredential | null> {
    if (this.admin.revoked.has(did)) return null
    return this.admin.creds.get(did) ?? null
  }
  async isRevoked(did: string): Promise<boolean> {
    return this.admin.revoked.has(did)
  }
}

interface Harness {
  module: GovernanceModule
  clock: FixedClock
  admin: FakeDelegationAdmin
  wallet: FakeWalletQuery
  reputation: FakeReputation
  ledger: FakeLedger
}

const newHarness = (): Harness => {
  const clock = new FixedClock('2026-06-06T15:00:00.000Z')
  const admin = new FakeDelegationAdmin(clock)
  const wallet = new FakeWalletQuery()
  const reputation = new FakeReputation()
  const ledger = new FakeLedger(clock)
  const identity = new FakeIdentity(admin)

  admin.seedAgent(AGENT_A, samplePolicy('1.00'))
  admin.seedAgent(AGENT_B, samplePolicy('2.00'))
  wallet.set(AGENT_A, [{ currency: 'USDC', available: money('42.00'), held: money('3.00') }])
  reputation.set(AGENT_A, 0.93, 17)

  const module = buildGovernance({
    clock,
    config: TEST_CONFIG,
    identity,
    delegationAdmin: admin,
    walletQuery: wallet,
    reputation,
    ledger,
  })

  return { module, clock, admin, wallet, reputation, ledger }
}

// HTTP harness mirroring the reputation routes test: local Zod compilers + a local AppError
// boundary, so the REAL route plugin (with the real bearer guard) is exercised end to end
// without depending on the transitive zod/v3 resolution that breaks the published compilers.
const zodValidatorCompiler =
  ({ schema }: { schema: z.ZodTypeAny }) =>
  (data: unknown) => {
    const result = schema.safeParse(data)
    return result.success ? { value: result.data } : { error: result.error }
  }
const jsonSerializerCompiler = () => (data: unknown) => JSON.stringify(data)

const buildApp = async () => {
  const h = newHarness()
  const app = Fastify({ logger: false })
  app.setValidatorCompiler(zodValidatorCompiler)
  app.setSerializerCompiler(jsonSerializerCompiler)
  app.setErrorHandler((error, _req, reply) => {
    if (isAppError(error)) {
      void reply.status(error.httpStatus).send({ statusCode: error.httpStatus, code: error.code, message: error.message })
      return
    }
    if (error instanceof z.ZodError) {
      void reply.status(400).send({ statusCode: 400, code: 'validation_error', message: 'bad input' })
      return
    }
    const status = typeof (error as { statusCode?: number }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500
    void reply.status(status).send({ statusCode: status, code: status >= 500 ? 'internal_error' : 'request_error', message: error.message })
  })
  await app.register(h.module.routes)
  await app.ready()
  return { app, ...h }
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

// ---------------------------------------------------------------------------
// Bearer guard — deny by default.
// ---------------------------------------------------------------------------
describe('governance bearer guard', () => {
  let toClose: Array<Awaited<ReturnType<typeof buildApp>>['app']> = []
  afterEach(async () => {
    await Promise.all(toClose.map((a) => a.close()))
    toClose = []
  })

  const routes: Array<{ method: 'GET' | 'PUT' | 'POST'; url: string }> = [
    { method: 'GET', url: `/gov/agents?principal=${PRINCIPAL}` },
    { method: 'PUT', url: `/gov/agents/${AGENT_A}/policy` },
    { method: 'POST', url: `/gov/agents/${AGENT_A}/kill` },
    { method: 'GET', url: '/gov/approvals' },
    { method: 'POST', url: '/gov/approvals/apr_x' },
    { method: 'GET', url: '/gov/audit' },
  ]

  it('rejects every route with 401 when no bearer is supplied', async () => {
    const { app } = await buildApp()
    toClose.push(app)
    for (const r of routes) {
      const res = await app.inject({ method: r.method, url: r.url })
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401)
      expect(res.json().code).toBe('auth_error')
    }
  })

  it('rejects every route with 401 when the bearer token is wrong', async () => {
    const { app } = await buildApp()
    toClose.push(app)
    for (const r of routes) {
      const res = await app.inject({ method: r.method, url: r.url, headers: auth('not-the-key') })
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401)
      expect(res.json().code).toBe('auth_error')
    }
  })

  it('rejects a non-Bearer Authorization scheme', async () => {
    const { app } = await buildApp()
    toClose.push(app)
    const res = await app.inject({ method: 'GET', url: '/gov/audit', headers: { authorization: GOV_KEY } })
    expect(res.statusCode).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// GET /gov/agents
// ---------------------------------------------------------------------------
describe('GET /gov/agents', () => {
  it('composes policy + balances + standing for the principal’s agents', async () => {
    const { app } = await buildApp()
    const res = await app.inject({ method: 'GET', url: `/gov/agents?principal=${PRINCIPAL}`, headers: auth(GOV_KEY) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.principal).toBe(PRINCIPAL)
    expect(body.agents).toHaveLength(2)
    const a = body.agents.find((x: { did: string }) => x.did === AGENT_A)
    expect(a.policy.spend.per_tx_max.amount).toBe('1.00')
    expect(a.balances[0].available.amount).toBe('42.00')
    expect(a.standing).toEqual({ trust: 0.93, jobs: 17 })
    const b = body.agents.find((x: { did: string }) => x.did === AGENT_B)
    expect(b.balances).toEqual([])
    expect(b.standing).toBeNull()
    await app.close()
  })

  it('400s when principal query param is missing', async () => {
    const { app } = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/gov/agents', headers: auth(GOV_KEY) })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

// ---------------------------------------------------------------------------
// PUT /gov/agents/:did/policy
// ---------------------------------------------------------------------------
describe('PUT /gov/agents/:did/policy', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })

  const updatedPolicy = (): DelegationPolicyInput => ({ ...samplePolicy('7.50') })

  it('validates, persists via the admin port, and appends a gov_policy_change audit entry', async () => {
    const before = h.admin.creds.get(AGENT_A)!.policy

    const result = await h.module.governanceService.updatePolicy(AGENT_A, updatedPolicy())

    expect(result.policy.spend.per_tx_max.amount).toBe('7.50')
    expect(h.admin.creds.get(AGENT_A)!.policy.spend.per_tx_max.amount).toBe('7.50')

    const audit = await h.ledger.list({ kind: GOV_AUDIT_KIND.policyChange })
    expect(audit).toHaveLength(1)
    expect(audit[0]!.subject).toBe(AGENT_A)
    const payload = audit[0]!.payload as { before: DelegationPolicy; after: DelegationPolicy; by: string }
    expect(payload.by).toBe('supervisor')
    expect(payload.before.spend.per_tx_max.amount).toBe(before.spend.per_tx_max.amount)
    expect(payload.after.spend.per_tx_max.amount).toBe('7.50')
  })

  it('rejects an invalid policy at the HTTP boundary with 400 (no audit written)', async () => {
    const { app, ledger } = await buildApp()
    const res = await app.inject({
      method: 'PUT',
      url: `/gov/agents/${AGENT_A}/policy`,
      headers: auth(GOV_KEY),
      payload: { policy: { spend: { per_tx_max: { amount: '1.00' } } } },
    })
    expect(res.statusCode).toBe(400)
    expect(await ledger.list({ kind: GOV_AUDIT_KIND.policyChange })).toHaveLength(0)
    await app.close()
  })

  it('updates over HTTP and returns the re-issued credential', async () => {
    const { app, admin } = await buildApp()
    const res = await app.inject({
      method: 'PUT',
      url: `/gov/agents/${AGENT_A}/policy`,
      headers: auth(GOV_KEY),
      payload: { policy: samplePolicy('9.99') },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().policy.spend.per_tx_max.amount).toBe('9.99')
    expect(admin.creds.get(AGENT_A)!.policy.spend.per_tx_max.amount).toBe('9.99')
    await app.close()
  })
})

// ---------------------------------------------------------------------------
// POST /gov/agents/:did/kill — kill switch
// ---------------------------------------------------------------------------
describe('POST /gov/agents/:did/kill', () => {
  it('revokes the delegation and appends a gov_kill audit entry', async () => {
    const { app, admin, ledger } = await buildApp()
    const res = await app.inject({ method: 'POST', url: `/gov/agents/${AGENT_A}/kill`, headers: auth(GOV_KEY) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ did: AGENT_A, revoked: true })
    expect(admin.revoked.has(AGENT_A)).toBe(true)

    const audit = await ledger.list({ kind: GOV_AUDIT_KIND.kill })
    expect(audit).toHaveLength(1)
    expect(audit[0]!.subject).toBe(AGENT_A)
    expect((audit[0]!.payload as { by: string }).by).toBe('supervisor')
    await app.close()
  })
})

// ---------------------------------------------------------------------------
// Approval queue: enqueue -> GET pending -> POST approve/deny
// ---------------------------------------------------------------------------
describe('approval queue', () => {
  it('enqueue surfaces in GET /gov/approvals, then approve flips status + audits', async () => {
    const { app, module, ledger } = await buildApp()

    const parked = await module.approvals.enqueue({
      agent: AGENT_A,
      action: { kind: 'spend', agent: AGENT_A, amount: money('25.00'), category: 'doc.extract' },
      payload: { quote_id: 'qt_1' },
    })
    expect(parked.status).toBe('pending')

    const listRes = await app.inject({ method: 'GET', url: '/gov/approvals', headers: auth(GOV_KEY) })
    expect(listRes.statusCode).toBe(200)
    expect(listRes.json().approvals).toHaveLength(1)
    expect(listRes.json().approvals[0].approvalId).toBe(parked.approvalId)

    const approveRes = await app.inject({
      method: 'POST',
      url: `/gov/approvals/${parked.approvalId}`,
      headers: auth(GOV_KEY),
      payload: { decision: 'approve', note: 'looks fine' },
    })
    expect(approveRes.statusCode).toBe(200)
    expect(approveRes.json().approval.status).toBe('approved')

    // The originator now observes the flipped status (it re-submits the parked action itself).
    const status = await module.approvals.status(parked.approvalId)
    expect(status!.status).toBe('approved')

    // No longer pending.
    const after = await app.inject({ method: 'GET', url: '/gov/approvals', headers: auth(GOV_KEY) })
    expect(after.json().approvals).toHaveLength(0)

    const audit = await ledger.list({ kind: GOV_AUDIT_KIND.approval })
    expect(audit).toHaveLength(1)
    expect(audit[0]!.subject).toBe(AGENT_A)
    expect(audit[0]!.payload).toMatchObject({ id: parked.approvalId, decision: 'approve', note: 'looks fine', by: 'supervisor' })
    await app.close()
  })

  it('deny flips status to denied and audits the decision', async () => {
    const { app, module, ledger } = await buildApp()
    const parked = await module.approvals.enqueue({
      agent: AGENT_B,
      action: { kind: 'escrow', agent: AGENT_B, amount: money('200.00') },
      payload: {},
    })
    const res = await app.inject({
      method: 'POST',
      url: `/gov/approvals/${parked.approvalId}`,
      headers: auth(GOV_KEY),
      payload: { decision: 'deny' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().approval.status).toBe('denied')
    expect((await module.approvals.status(parked.approvalId))!.status).toBe('denied')
    const audit = await ledger.list({ kind: GOV_AUDIT_KIND.approval })
    expect(audit[0]!.payload).toMatchObject({ decision: 'deny' })
    await app.close()
  })

  it('404s when resolving an unknown approval id', async () => {
    const { app } = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/gov/approvals/apr_unknown',
      headers: auth(GOV_KEY),
      payload: { decision: 'approve' },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('a repeated identical decision is idempotent; the opposite decision conflicts (409)', async () => {
    const { module } = newHarness()
    const parked = await module.approvals.enqueue({
      agent: AGENT_A,
      action: { kind: 'spend', agent: AGENT_A, amount: money('25.00') },
      payload: {},
    })
    const first = await module.governanceService.resolveApproval(parked.approvalId, 'approve')
    expect(first.status).toBe('approved')
    const repeat = await module.governanceService.resolveApproval(parked.approvalId, 'approve')
    expect(repeat.status).toBe('approved')
    await expect(module.governanceService.resolveApproval(parked.approvalId, 'deny')).rejects.toThrow(/already approved/)
  })
})

// ---------------------------------------------------------------------------
// ApprovalQueue.consume — single-use redemption (C4). The backstop that makes a supervisor's
// clearance one-shot and bound to exactly one action, so it cannot be replayed past delegated caps.
// ---------------------------------------------------------------------------
describe('ApprovalQueue.consume — single-use redemption (C4)', () => {
  const spendAction = (amount = '25.00') => ({
    kind: 'spend' as const,
    agent: AGENT_A,
    amount: money(amount),
    category: 'doc.extract',
  })

  const enqueueAndResolve = async (module: GovernanceModule, decision: 'approve' | 'deny') => {
    const parked = await module.approvals.enqueue({ agent: AGENT_A, action: spendAction(), payload: { quote_id: 'qt_1' } })
    await module.governanceService.resolveApproval(parked.approvalId, decision)
    return parked.approvalId
  }

  it('consumes an approved clearance once: status → consumed, decision preserved', async () => {
    const { module } = newHarness()
    const approvalId = await enqueueAndResolve(module, 'approve')

    const consumed = await module.approvals.consume(approvalId, { agent: AGENT_A, action: spendAction() })
    expect(consumed.status).toBe('consumed')
    expect(consumed.decision).toBe('approved')
    expect((await module.approvals.status(approvalId))!.status).toBe('consumed')
  })

  it('refuses a second redemption of the same clearance (single-use)', async () => {
    const { module } = newHarness()
    const approvalId = await enqueueAndResolve(module, 'approve')
    await module.approvals.consume(approvalId, { agent: AGENT_A, action: spendAction() })
    await expect(
      module.approvals.consume(approvalId, { agent: AGENT_A, action: spendAction() }),
    ).rejects.toThrow(/already been consumed/)
  })

  it('refuses to consume a still-pending (unresolved) approval', async () => {
    const { module } = newHarness()
    const parked = await module.approvals.enqueue({ agent: AGENT_A, action: spendAction(), payload: {} })
    await expect(
      module.approvals.consume(parked.approvalId, { agent: AGENT_A, action: spendAction() }),
    ).rejects.toThrow(/not yet resolved/)
  })

  it('refuses a clearance redeemed for a different amount (action binding is exact)', async () => {
    const { module } = newHarness()
    const approvalId = await enqueueAndResolve(module, 'approve')
    await expect(
      module.approvals.consume(approvalId, { agent: AGENT_A, action: spendAction('99.00') }),
    ).rejects.toThrow(/does not authorize this action/)
  })

  it('refuses a clearance redeemed by a different agent', async () => {
    const { module } = newHarness()
    const approvalId = await enqueueAndResolve(module, 'approve')
    await expect(
      module.approvals.consume(approvalId, { agent: AGENT_B, action: { ...spendAction(), agent: AGENT_B } }),
    ).rejects.toThrow(/issued for a different agent/)
  })

  it('consumes a DENIED clearance too (terminal), preserving decision=denied', async () => {
    const { module } = newHarness()
    const approvalId = await enqueueAndResolve(module, 'deny')
    const consumed = await module.approvals.consume(approvalId, { agent: AGENT_A, action: spendAction() })
    expect(consumed.status).toBe('consumed')
    expect(consumed.decision).toBe('denied')
  })

  it('404s when consuming an unknown approval id', async () => {
    const { module } = newHarness()
    await expect(
      module.approvals.consume('apr_unknown', { agent: AGENT_A, action: spendAction() }),
    ).rejects.toThrow(/not found/)
  })
})

// ---------------------------------------------------------------------------
// GET /gov/audit
// ---------------------------------------------------------------------------
describe('GET /gov/audit', () => {
  it('returns entries, a merkleRoot, and chainValid=true over a real hash chain', async () => {
    const { app, module } = await buildApp()

    await module.governanceService.kill(AGENT_A)
    await module.governanceService.updatePolicy(AGENT_B, samplePolicy('3.00'))

    const res = await app.inject({ method: 'GET', url: '/gov/audit', headers: auth(GOV_KEY) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.entries.length).toBe(2)
    expect(typeof body.merkleRoot).toBe('string')
    expect(body.merkleRoot.length).toBeGreaterThan(0)
    expect(body.chainValid).toBe(true)
    await app.close()
  })

  it('filters by kind and subject', async () => {
    const { app, module } = await buildApp()
    await module.governanceService.kill(AGENT_A)
    await module.governanceService.updatePolicy(AGENT_B, samplePolicy('3.00'))

    const killOnly = await app.inject({ method: 'GET', url: `/gov/audit?kind=${GOV_AUDIT_KIND.kill}`, headers: auth(GOV_KEY) })
    expect(killOnly.json().entries).toHaveLength(1)
    expect(killOnly.json().entries[0].kind).toBe(GOV_AUDIT_KIND.kill)

    const subjB = await app.inject({ method: 'GET', url: `/gov/audit?subject=${AGENT_B}`, headers: auth(GOV_KEY) })
    expect(subjB.json().entries).toHaveLength(1)
    expect(subjB.json().entries[0].subject).toBe(AGENT_B)
    await app.close()
  })

  it('reports chainValid=false when the ledger is tampered', async () => {
    const { ledger, module } = newHarness()
    await module.governanceService.kill(AGENT_A)
    await module.governanceService.kill(AGENT_B)
    ledger.tamper(1, (e) => ({ ...e, payload: { ...(e.payload as object), injected: true } }))
    const view = await module.governanceService.audit()
    expect(view.chainValid).toBe(false)
  })
})
