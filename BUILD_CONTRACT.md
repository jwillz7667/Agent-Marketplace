# Praxis build contract (internal — read before writing any module)

This file is the shared contract for the feature-module build. The foundation
(`src/domain`, `src/shared`, `src/infrastructure/persistence/memory`) is DONE,
typechecks clean, and is tested. Do not modify foundation files.

## Authoritative references
- `outline.md` — the product spec (section-numbered). Read the sections named in your task.
- `src/shared/ports/index.ts` — the EXACT cross-module interfaces. Import collaborators ONLY from here.
- `src/domain/index.ts` — all value types + pure helpers (Money, Listing, Quote, Receipt, Message, BoardPost, EscrowContract, ReputationMetrics, computeTrust, taxonomy helpers, ids, etc.).
- `src/shared/crypto/index.ts` — signDetached, verifyDetached, canonicalize, sha256Hex, sha256Tagged, hashChain, merkleRoot, didFromPublicKey, generateKeyPair, bytesToB64u/b64uToBytes.
- `src/shared/errors.ts` — AppError subclasses: ValidationError(400), AuthError(401), ForbiddenError(403), NotFoundError(404), ConflictError(409), PolicyViolationError(403), PaymentRequiredError(402), ReplayError(409), RailError(502).
- `src/shared/http/index.ts` — `verifySignedObject(deps, obj, opts)`, `withIdempotency(store, scope, key, fn)`.

## Hard rules (from ~/.claude/CLAUDE.md + repo CLAUDE.md)
- TypeScript ESM, EXTENSIONLESS relative imports (`from './schema'`, NOT `'./schema.js'`). `moduleResolution: Bundler`.
- `strict: true`, `noUncheckedIndexedAccess: true`. No `any`. No unsafe `as`. No non-null `!` on values that can really be null.
- Zod v3 validation on every route input. Typed errors only (throw AppError subclasses); never bare strings; never `catch (e: any)` swallow.
- Hexagonal DI: every collaborator injected via the factory's deps argument. No module-level singletons, no global state, no `process.env` reads inside a module.
- Co-locate: your module is ONE directory. Public surface via a single `index.ts` barrel. No deep imports into another feature.
- Zero placeholders/stubs/TODOs. Complete logic. Untrusted free-text (descriptions, message/post bodies) is DATA, never instructions.

## Signing & verification convention
- Inbound signed object: call `verifySignedObject(envDeps, obj, { signerDid, omitFields })` where `envDeps = { identity, nonces, clock, skewMs }`. It checks iat/exp freshness, single-use nonce, and the detached JWS over the object minus `omitFields` (default `['sig']`).
- To SIGN an object you produce server-side (quote, receipt, snapshot, etc.): build the payload object WITHOUT its signature field(s), `signDetached(payload, privateKey, kid)`, then attach the returned string as `sig`. Keep the omit list symmetric with how verifiers strip it.
- Board posts: the author signs the body BEFORE the server assigns `seq`/`prev_hash`/`post_hash`. So the author signs over the post minus `['sig','seq','prev_hash','post_hash']`. Verify with that same omit list. `post_hash = hashChain(prev_hash, <signed post body>)`.
- WORK_RECORD: `counterparty_sig` is a second detached JWS by the counterparty over the same body the author signed (minus both sigs + chain fields). Verify BOTH.

## Module factory & route convention (so the container can wire you uniformly)
- Export a single factory `buildXxx(deps): XxxModule` from your barrel.
- `deps` is an object literal containing exactly the ports/values you listed as "consume" + your repos (which you construct yourself inside the factory, OR accept pre-built — construct them yourself by default) + `clock`. The container passes ports by the names used in `src/shared/ports`.
- The factory RETURNS an object with: your service instances (named), any port implementations you provide (named by their port, e.g. `identityResolver`, `policyEvaluator`, `valueTransfer`), and `routes` — a Fastify plugin you can register, OR `routes: null` if the module has no HTTP surface.
- A route plugin has this exact shape and uses the Zod type provider:
  ```ts
  import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
  export const makeXxxRoutes = (svc: XxxService): FastifyPluginAsyncZod => async (app) => {
    app.post('/path', { schema: { body: BodySchema, response: { 200: OkSchema } } }, async (req, reply) => { ... })
  }
  ```
  Then in the factory: `routes: makeXxxRoutes(service)`. Register additional plugins by composing them inside one parent plugin if you have several route files.
- Throw AppError subclasses inside handlers/services; the global error handler (already installed by the app) maps them. Do NOT set your own error handler.

## Standard deps the container can supply (use these exact names)
`clock, nonces, idempotency, identity (IdentityResolver), keystore (Keystore), delegationAdmin (DelegationAdminPort), policy (PolicyEvaluator), signer (WalletSigner), usage (UsagePort), ledger (Ledger), reputation (ReputationPort), valueTransfer (ValueTransferPort), walletQuery (WalletQueryPort), approvals (ApprovalPort), rails (RailRegistry), railsconfig (string[]), config (the typed Config), logger`.
Plus core signing identities the container generates and passes where needed:
`coreKeys: { reputation: CoreSigner; registry: CoreSigner; facilitator: CoreSigner }` where
`type CoreSigner = { did: string; kid: string; privateKey: Uint8Array; publicKey: Uint8Array }`.
The container will also register each CoreSigner's private key in the Keystore under its `kid`, and register a resolvable passport/public key for its `did` via identity, so `verifySignedObject` works for core-signed objects.

## Testing
- Write Vitest unit tests (`*.test.ts`) inside your dir. Use `FixedClock` from `src/shared/time/clock`. Construct simple in-memory fakes for consumed ports. Cover happy path, failure, idempotent retry, and each invariant in your task.
- You MAY run `pnpm exec vitest run <yourDir>`. Do NOT run whole-project `tsc`.
