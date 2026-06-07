export { canonicalize, canonicalBytes } from './canonicalize'
export { sha256Hex, sha256Canonical, hashChain, sha256Tagged } from './hash'
export { merkleRoot, merkleProof, verifyProof, type MerkleProofStep } from './merkle'
export {
  generateKeyPair,
  publicKeyFromPrivate,
  sign,
  verify,
  bytesToB64u,
  b64uToBytes,
  pubToB64u,
  b64uToPub,
  privToB64u,
  b64uToPriv,
  type KeyPair,
} from './keys'
export { signDetached, verifyDetached, parseJwsHeader, type JwsHeader } from './jws'
export { didFromPublicKey, parseDid, isPraxisDid, type DidRole, type ParsedDid } from './did'
