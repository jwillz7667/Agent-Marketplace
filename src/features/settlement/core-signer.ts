// CoreSigner: a core signing identity injected into the settlement module (the facilitator's
// signing key here). The container registers its public key under `did` via identity (so verifiers
// can check facilitator-signed receipts) and the private key in the keystore under `kid`. This
// mirrors the registry's CoreSigner shape so the container can wire both uniformly.
export interface CoreSigner {
  readonly did: string
  readonly kid: string
  readonly privateKey: Uint8Array
  readonly publicKey: Uint8Array
}
