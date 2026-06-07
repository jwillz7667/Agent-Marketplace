import { canonicalBytes } from './canonicalize'
import { sign, verify, bytesToB64u, b64uToBytes } from './keys'

// Detached JWS (RFC 7515 §A.5 shape) over the JCS-canonical payload.
// Compact detached form: "<b64uProtectedHeader>..<b64uSignature>" (empty payload segment).
// The payload is never embedded; verifiers recompute the signing input from the object itself.

export interface JwsHeader {
  readonly alg: 'EdDSA'
  readonly kid: string
}

const encodeHeader = (kid: string): string =>
  Buffer.from(JSON.stringify({ alg: 'EdDSA', kid }), 'utf8').toString('base64url')

// RFC 7515 §2 JWS Signing Input in compact serialization form:
//   ASCII( BASE64URL(UTF8(Protected Header)) || '.' || BASE64URL(JWS Payload) )
// The payload is the JCS-canonical bytes of the object (RFC 8785), base64url-encoded, so sign and
// verify recompute the exact same input regardless of the object's property ordering on the wire
// (detached: the encoded payload is never transmitted, §A.5).
const signingInput = (encodedHeader: string, payload: unknown): Uint8Array => {
  const encodedPayload = bytesToB64u(canonicalBytes(payload))
  return Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8')
}

export const signDetached = async (payload: unknown, privateKey: Uint8Array, kid: string): Promise<string> => {
  const header = encodeHeader(kid)
  const input = signingInput(header, payload)
  const signature = await sign(input, privateKey)
  return `${header}..${bytesToB64u(signature)}`
}

export const verifyDetached = async (
  payload: unknown,
  jws: string,
  publicKey: Uint8Array,
): Promise<boolean> => {
  const parts = jws.split('.')
  if (parts.length !== 3 || parts[1] !== '') return false
  const header = parts[0]!
  const sig = parts[2]!
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
  } catch {
    return false
  }
  if (!isHeader(decoded)) return false
  const input = signingInput(header, payload)
  try {
    return await verify(b64uToBytes(sig), input, publicKey)
  } catch {
    return false
  }
}

export const parseJwsHeader = (jws: string): JwsHeader => {
  const header = jws.split('.')[0]
  if (!header) throw new Error('parseJwsHeader: malformed JWS')
  const decoded: unknown = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
  if (!isHeader(decoded)) throw new Error('parseJwsHeader: invalid header')
  return decoded
}

const isHeader = (v: unknown): v is JwsHeader =>
  typeof v === 'object' && v !== null && (v as { alg?: unknown }).alg === 'EdDSA' && typeof (v as { kid?: unknown }).kid === 'string'
