import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils'

// Binary Merkle tree over hex leaf hashes. On an odd count at any level, the last
// node is duplicated (Bitcoin-style), which keeps the root deterministic.

const hashPair = (a: string, b: string): string =>
  bytesToHex(sha256(concatBytes(hexToBytes(a), hexToBytes(b))))

export const merkleRoot = (leaves: readonly string[]): string => {
  if (leaves.length === 0) return bytesToHex(sha256(new Uint8Array(0)))
  let level = [...leaves]
  while (level.length > 1) {
    const next: string[] = []
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!
      const right = i + 1 < level.length ? level[i + 1]! : left
      next.push(hashPair(left, right))
    }
    level = next
  }
  return level[0]!
}

export interface MerkleProofStep {
  readonly sibling: string
  readonly position: 'left' | 'right'
}

// Inclusion proof for the leaf at `index`.
export const merkleProof = (leaves: readonly string[], index: number): MerkleProofStep[] => {
  if (index < 0 || index >= leaves.length) throw new Error('merkleProof: index out of range')
  const proof: MerkleProofStep[] = []
  let level = [...leaves]
  let idx = index
  while (level.length > 1) {
    const isRightNode = idx % 2 === 1
    const siblingIdx = isRightNode ? idx - 1 : idx + 1
    const sibling = siblingIdx < level.length ? level[siblingIdx]! : level[idx]!
    proof.push({ sibling, position: isRightNode ? 'left' : 'right' })
    const next: string[] = []
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!
      const right = i + 1 < level.length ? level[i + 1]! : left
      next.push(hashPair(left, right))
    }
    level = next
    idx = Math.floor(idx / 2)
  }
  return proof
}

export const verifyProof = (leaf: string, proof: readonly MerkleProofStep[], root: string): boolean => {
  let computed = leaf
  for (const step of proof) {
    computed = step.position === 'left' ? hashPair(step.sibling, computed) : hashPair(computed, step.sibling)
  }
  return computed === root
}
