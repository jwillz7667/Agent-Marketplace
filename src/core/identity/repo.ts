import type { DelegationCredential, Passport } from '../../domain/index'

// Persistence ports for the identity module. The factory constructs the in-memory
// adapters (memory.ts) by default; a Prisma adapter can be slotted in later without
// touching the service. Storage is keyed by DID; all reads are point lookups.

export interface PassportRepo {
  get(did: string): Promise<Passport | null>
  put(passport: Passport): Promise<void>
  // Principals are the controllers; this scans by controller DID for listByPrincipal.
  listByController(controller: string): Promise<Passport[]>
}

export interface DelegationRepo {
  get(subjectDid: string): Promise<DelegationCredential | null>
  put(subjectDid: string, delegation: DelegationCredential): Promise<void>
}

export interface RevocationRepo {
  isRevoked(did: string): Promise<boolean>
  revoke(did: string): Promise<void>
}
