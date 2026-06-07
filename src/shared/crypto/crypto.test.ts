import { describe, it, expect } from 'vitest'
import {
  canonicalize,
  sha256Hex,
  hashChain,
  merkleRoot,
  merkleProof,
  verifyProof,
  generateKeyPair,
  signDetached,
  verifyDetached,
  parseJwsHeader,
  didFromPublicKey,
  parseDid,
  isPraxisDid,
  verify,
  canonicalBytes,
  bytesToB64u,
  b64uToBytes,
} from './index'

describe('canonicalize (RFC 8785)', () => {
  it('is independent of key insertion order', () => {
    const a = canonicalize({ b: 1, a: 2, nested: { y: 1, x: 2 } })
    const b = canonicalize({ a: 2, nested: { x: 2, y: 1 }, b: 1 })
    expect(a).toBe(b)
  })

  it('throws on non-serializable input', () => {
    expect(() => canonicalize(undefined)).toThrow()
  })
})

describe('hashing', () => {
  it('sha256Hex is stable and 64 hex chars', () => {
    const h = sha256Hex('praxis')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256Hex('praxis')).toBe(h)
  })

  it('hashChain is deterministic and order-sensitive', () => {
    const h1 = hashChain('00', { seq: 1, payload: 'x' })
    const h2 = hashChain('00', { payload: 'x', seq: 1 })
    expect(h1).toBe(h2)
    expect(hashChain('00', { seq: 2 })).not.toBe(h1)
  })
})

describe('merkle', () => {
  it('computes a deterministic root and verifies inclusion proofs', () => {
    const leaves = ['aa', 'bb', 'cc', 'dd', 'ee'].map((s) => sha256Hex(s))
    const root = merkleRoot(leaves)
    expect(root).toBe(merkleRoot(leaves))
    for (let i = 0; i < leaves.length; i++) {
      const proof = merkleProof(leaves, i)
      expect(verifyProof(leaves[i]!, proof, root)).toBe(true)
    }
  })

  it('rejects a tampered leaf', () => {
    const leaves = ['aa', 'bb', 'cc'].map((s) => sha256Hex(s))
    const root = merkleRoot(leaves)
    const proof = merkleProof(leaves, 1)
    expect(verifyProof(sha256Hex('zz'), proof, root)).toBe(false)
  })
})

describe('ed25519 detached JWS over canonical payload', () => {
  it('round-trips sign/verify and detects tampering', async () => {
    const { privateKey, publicKey } = await generateKeyPair()
    const payload = { from: 'a', to: 'b', amount: '1.00', nonce: 'n1' }
    const jws = await signDetached(payload, privateKey, '#sign-1')

    expect(parseJwsHeader(jws)).toEqual({ alg: 'EdDSA', kid: '#sign-1' })
    expect(await verifyDetached(payload, jws, publicKey)).toBe(true)

    // Reordered keys must still verify (canonical form).
    expect(await verifyDetached({ to: 'b', from: 'a', nonce: 'n1', amount: '1.00' }, jws, publicKey)).toBe(true)

    // Tampered payload must fail.
    expect(await verifyDetached({ ...payload, amount: '2.00' }, jws, publicKey)).toBe(false)

    // Wrong key must fail.
    const other = await generateKeyPair()
    expect(await verifyDetached(payload, jws, other.publicKey)).toBe(false)
  })

  it('rejects malformed JWS strings', async () => {
    const { publicKey } = await generateKeyPair()
    expect(await verifyDetached({ a: 1 }, 'not-a-jws', publicKey)).toBe(false)
    expect(await verifyDetached({ a: 1 }, 'h.payload.s', publicKey)).toBe(false)
  })

  it('signs the RFC 7515 §2 compact signing input: ASCII(header).BASE64URL(canonical payload)', async () => {
    const { privateKey, publicKey } = await generateKeyPair()
    const payload = { from: 'a', to: 'b', amount: '1.00', nonce: 'n1' }
    const jws = await signDetached(payload, privateKey, '#sign-1')

    const [header, emptyPayload, sig] = jws.split('.')
    expect(emptyPayload).toBe('') // detached: payload segment is empty on the wire (§A.5)

    // Independently reconstruct the signing input the spec mandates and confirm the detached
    // signature verifies against EXACTLY that — proving the format, not just that round-trip works.
    const encodedPayload = bytesToB64u(canonicalBytes(payload))
    const expectedInput = Buffer.from(`${header}.${encodedPayload}`, 'utf8')
    expect(await verify(b64uToBytes(sig!), expectedInput, publicKey)).toBe(true)

    // A signing input built the OLD (non-conformant) way must NOT verify.
    const wrongInput = canonicalBytes({ __jws_header: header, __jws_payload: encodedPayload })
    expect(await verify(b64uToBytes(sig!), wrongInput, publicKey)).toBe(false)
  })
})

describe('did:praxis', () => {
  it('derives deterministically from a public key', async () => {
    const { publicKey } = await generateKeyPair()
    const did = didFromPublicKey(publicKey, 'agent')
    expect(did).toBe(didFromPublicKey(publicKey, 'agent'))
    expect(isPraxisDid(did)).toBe(true)
    expect(parseDid(did)).toMatchObject({ method: 'praxis', role: 'agent' })
  })

  it('rejects non-praxis dids', () => {
    expect(isPraxisDid('did:web:example.com')).toBe(false)
    expect(isPraxisDid('nonsense')).toBe(false)
  })
})
