import type { Keystore } from '../../shared/ports/index'

// In-memory Keystore: maps a JWS `kid` to the raw Ed25519 private key bytes.
//
// KID CONVENTION (load-bearing — see index.ts barrel doc): the `kid` is
// `${did}${keyId}` where `keyId` is the passport key id (which already begins with
// "#", e.g. "#sign-1"). So an agent signing kid looks like
// "did:praxis:agent:7f3a...#sign-1". A consumer (e.g. WalletSigner) resolves the
// passport via IdentityResolver, takes the first (or named) key's `id`, and rebuilds
// the same kid to fetch the private key here. This keeps kids globally unique.
//
// In production this is fronted by an MPC/TEE-backed signer (§4.3); the in-memory map
// exists for core identities seeded by the container and for tests.
export class MemoryKeystore implements Keystore {
  private readonly keys = new Map<string, Uint8Array>()

  async register(kid: string, privateKey: Uint8Array): Promise<void> {
    this.keys.set(kid, privateKey)
  }

  async getSigningKey(kid: string): Promise<Uint8Array | null> {
    return this.keys.get(kid) ?? null
  }
}

// Build the canonical signing kid for a given DID + passport key id.
export const signingKid = (did: string, keyId: string): string => `${did}${keyId}`
