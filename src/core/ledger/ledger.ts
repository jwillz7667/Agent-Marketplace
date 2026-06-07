import { hashChain, merkleRoot } from '../../shared/crypto/index'
import { ConflictError } from '../../shared/errors'
import type { Clock, Ledger, LedgerEntry } from '../../shared/ports/index'
import type { LedgerRepo } from './repo'

// Append-only, hash-chained ledger of receipts + key events (§11, §8.2). This is the
// trusted, tamper-evident substrate the governance plane reads for audit (§12) and the
// facilitator/escrow paths write settled receipts into. There is intentionally no
// update or delete surface: "correcting" a record is a new appended entry.
//
// seq convention: 1-BASED and monotonic. The first appended entry has seq=1. The
// genesis prevHash (the prevHash of seq=1) is GENESIS_PREV_HASH = 64 zero hex chars.
// Every entry's hash binds {seq, ts, kind, subject, payload} via hashChain(prevHash, …),
// so the content covers its own position (seq) and time (ts) — reordering two entries,
// or editing any field, breaks the recomputed hash at that link.

export const GENESIS_PREV_HASH = '0'.repeat(64)

// The exact content covered by an entry's hash. Keeping this as a single helper keeps
// append() and verifyChain() byte-for-byte symmetric.
const hashedContent = (e: Pick<LedgerEntry, 'seq' | 'ts' | 'kind' | 'subject' | 'payload'>) => ({
  seq: e.seq,
  ts: e.ts,
  kind: e.kind,
  // `subject` is intentionally included even when undefined: canonicalize drops absent
  // keys, so present-vs-absent subject produces distinct hashes (no ambiguity).
  subject: e.subject,
  payload: e.payload,
})

export interface LedgerListFilter {
  kind?: string
  subject?: string
  since?: number
  until?: string
  from?: string
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// `from` audit semantics (§11 "keyed by agent and principal"): an entry is attributed to
// an actor when its payload names that actor as the spending/sending side, i.e.
// payload.payer === from OR payload.from === from. Subject is matched separately via the
// `subject` filter, so `from` is purely a payload-level attribution probe.
const matchesFrom = (payload: unknown, from: string): boolean => {
  if (!isPlainObject(payload)) return false
  return payload['payer'] === from || payload['from'] === from
}

export class LedgerService implements Ledger {
  constructor(
    private readonly repo: LedgerRepo,
    private readonly clock: Clock,
  ) {}

  async append(input: { kind: string; subject?: string; payload: unknown }): Promise<LedgerEntry> {
    const prev = await this.repo.last()
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

    // Guard the chain head against a concurrent appender having advanced it between our
    // read and write. With the single-process in-memory repo this never trips, but it
    // makes the append-only invariant explicit for any persistent adapter and keeps the
    // method safe to reason about under contention.
    const headNow = await this.repo.last()
    if ((headNow?.seq ?? 0) !== (prev?.seq ?? 0)) {
      throw new ConflictError('ledger head advanced during append; retry', {
        details: { expectedHeadSeq: prev?.seq ?? 0, actualHeadSeq: headNow?.seq ?? 0 },
      })
    }

    await this.repo.appendEntry(entry)
    return entry
  }

  async list(filter: LedgerListFilter = {}): Promise<LedgerEntry[]> {
    const all = await this.repo.all()
    const untilMs = filter.until !== undefined ? Date.parse(filter.until) : undefined

    return all.filter((e) => {
      if (filter.kind !== undefined && e.kind !== filter.kind) return false
      if (filter.subject !== undefined && e.subject !== filter.subject) return false
      if (filter.since !== undefined && e.seq < filter.since) return false
      if (untilMs !== undefined && Date.parse(e.ts) > untilMs) return false
      if (filter.from !== undefined && !matchesFrom(e.payload, filter.from)) return false
      return true
    })
  }

  async merkleRoot(): Promise<string> {
    const all = await this.repo.all()
    return merkleRoot(all.map((e) => e.hash))
  }

  async verifyChain(): Promise<boolean> {
    const all = await this.repo.all()
    let prevHash = GENESIS_PREV_HASH
    let prevSeq = 0

    for (const e of all) {
      // Monotonic, gapless, 1-based sequence.
      if (e.seq !== prevSeq + 1) return false
      // Linkage: each entry must carry the prior entry's hash.
      if (e.prevHash !== prevHash) return false
      // Integrity: recompute the hash from prevHash + the covered content. Any edit to
      // seq/ts/kind/subject/payload, or a swapped prevHash, makes this disagree.
      const expected = hashChain(prevHash, hashedContent(e))
      if (e.hash !== expected) return false

      prevHash = e.hash
      prevSeq = e.seq
    }

    return true
  }
}
