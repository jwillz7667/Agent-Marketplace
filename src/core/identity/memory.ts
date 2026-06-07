import type { DelegationCredential, Passport } from '../../domain/index'
import type { DelegationRepo, PassportRepo, RevocationRepo } from './repo'

// In-memory adapters for the identity persistence ports. State lives in Maps; no I/O.
// Single-process only — the container swaps these for a Prisma-backed set in production.

export class MemoryPassportRepo implements PassportRepo {
  private readonly byDid = new Map<string, Passport>()

  async get(did: string): Promise<Passport | null> {
    return this.byDid.get(did) ?? null
  }

  async put(passport: Passport): Promise<void> {
    this.byDid.set(passport.did, passport)
  }

  async listByController(controller: string): Promise<Passport[]> {
    const out: Passport[] = []
    for (const p of this.byDid.values()) {
      if (p.controller === controller) out.push(p)
    }
    return out
  }
}

export class MemoryDelegationRepo implements DelegationRepo {
  private readonly bySubject = new Map<string, DelegationCredential>()

  async get(subjectDid: string): Promise<DelegationCredential | null> {
    return this.bySubject.get(subjectDid) ?? null
  }

  async put(subjectDid: string, delegation: DelegationCredential): Promise<void> {
    this.bySubject.set(subjectDid, delegation)
  }
}

export class MemoryRevocationRepo implements RevocationRepo {
  private readonly revoked = new Set<string>()

  async isRevoked(did: string): Promise<boolean> {
    return this.revoked.has(did)
  }

  async revoke(did: string): Promise<void> {
    this.revoked.add(did)
  }
}
