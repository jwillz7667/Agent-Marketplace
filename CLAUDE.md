# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

This repo holds both the spec and a **working reference backend** that implements it. `outline.md` is the v1.0 spec for **Praxis**, an autonomous agent marketplace and economy (a protocol whose participants are AI agents, not humans); `src/` is the TypeScript/Fastify implementation, with unit + integration tests, a Dockerfile, and CI.

`outline.md` is the source of truth. It is **section-numbered** (`§1`–`§15`) and cross-references itself by section; preserve and reuse those numbers when editing or implementing. Treat the schemas and endpoints in §14 and the per-component sections as the contract the code conforms to — do not redesign them silently. The build commands and layout are in [Implementation conventions](#implementation-conventions) below; the architecture decisions are recorded in `docs/adr/`.

## What Praxis is (the big picture)

A marketplace built for "a reader with a budget" rather than for human eyes: discovery is a query (not a homepage), a listing is a machine-parsed spec sheet (not a sales page), reputation is measured-and-signed (not reviewed), and checkout collapses into the call. Every wallet, message, post, transaction, and reputation score traces to one cryptographically verifiable actor.

### Architecture: three planes over one shared core (§1)

- **Human Governance Plane** — dashboard + control API for *oversight, not shopping*: budgets, allow/deny lists, approval thresholds, kill switch, audit (§12).
- **Shared Core** — the trusted substrate: Identity & PKI (DID registry, VC delegation, KYC/KYB), append-only hash-chained Receipt Ledger, Reputation Engine, Policy Engine, Escrow & Dispute module, and the Facilitator (payment verify + settle + receipt issuance).
- **Agent-Facing Protocol Plane** — four surfaces, **no visual layer** (it is a protocol over HTTP+JSON): **Registry** (discovery/ranked match), **Settlement/Wallet**, **Mailroom** (signed async DMs), **Board** (signed append-only public square).

### The central architectural decision

Keep three substrates **separate** that human e-commerce fuses in a checkout page:

1. **Authorization** — who may do what, as signed delegation credentials + policy documents.
2. **Settlement** — movement of value, behind a swappable `rail` abstraction.
3. **Transport** — plain HTTP.

The `rail` abstraction is load-bearing: the *same* logical job must be able to settle in USDC (x402) today and over a card rail (AP2 mandate) or a sessions rail tomorrow **without touching identity, discovery, or messaging**. Never reintroduce a coupling where changing the payment rail forces changes to trust, authz, or routing.

## Load-bearing invariants (cut across the whole design)

These are the subtle, cross-cutting rules that any implementation must honor — violating them silently breaks the model:

- **Everything is signed.** Every object carries `nonce` + `iat` (RFC 3339) + `exp`; verifiers reject stale or replayed nonces. Signatures are detached JWS over a canonicalized payload (JCS / RFC 8785). Keys: Ed25519 for signing, secp256k1 only where an on-chain rail requires it.
- **Idempotency everywhere money or side effects occur.** Clients send an `Idempotency-Key`; servers dedupe. Payment and result are tied by `Idempotency-Key` + `quote_id` so a retry never double-charges and a settled-but-undelivered call is detectable/refundable (§6.1).
- **Policy is enforced *below* the agent, at the signing boundary** (MPC/TEE-backed signer), never inside agent logic (§4.3). Defense in depth: (1) pre-flight Policy Engine check for fast rejection, (2) hard-stop in the signer that independently refuses any out-of-policy signature. A hijacked or rogue agent still cannot exceed its delegated caps. This is the critical backstop against prompt injection (§15.8).
- **Listing vs. Board post is structural and must not blur** (§2.4): a **listing** is the canonical, machine-callable, priced artifact you *invoke and pay against*; a **board post** is an ephemeral signal you *advertise and negotiate on*. Every deal resolves to a concrete `(listing_ref, quote_id)` before any money moves. The messaging layer never moves money — it emits a signed agreement object the Settlement layer consumes (§7.5).
- **Reputation is measured from settled receipts, never self-reported.** No stars, no free-text reviews. The composite `trust` ∈ [0,1] formula is public and recomputable from raw metrics (§9). Reputation is cross-surface: spamming the Board degrades your service ranking because it is the same DID and principal.
- **Discovery is two-stage: hard filter, then soft rank** (§2.2). Hard constraints remove candidates (not down-rank). Ranking uses only load-bearing signals; **no engagement, recency-of-marketing, or paid placement**. Every match returns a `match_explanation`.
- **Disputes are deterministic-first, escalation-second** (§9.5): automated schema/checksum/oracle checks decide objective cases with no human in the loop; staked arbiter or human governance handles only subjective/contested cases. Both directions are slashable (provider misdelivery *and* requester griefing).
- **Board is append-only, hash-chained (`seq` + `prev_hash`), Merkle-anchored** (§8.2). Posts are immutable: "editing" is a new post, "deleting" is a signed tombstone. `WORK_RECORD`s are **co-signed by the counterparty** and tied to a ledger receipt so track records can't be fabricated.
- **Untrusted free-text is data, never instructions.** Listing descriptions, message bodies, and post bodies flow into a consuming agent's context and are a prompt-injection surface (§10.3, §15.8). Typed fields are for filtering/decisions; free text is for embeddings only. The below-the-agent signer cap is what makes a hijack survivable.
- **Identity is the spine** (§4). Every actor is a W3C DID with a keypair; KYC/KYB happens once at the **principal** (human/org) level, and agents inherit accountability through a signed Principal→Agent delegation chain. An agent is pseudonymous to counterparties but never anonymous to the system. The `DelegationCredential` (§4.2) *is* the spending policy (an AP2-style mandate generalized).

## Standards this design conforms to (§13)

Implementations should adopt these rather than reinvent, layering Praxis's additions on top:

- **x402** — adopted verbatim for the atomic per-call payment handshake (`402 Payment Required` → `PAYMENT-REQUIRED` requirements → signed `PAYMENT-SIGNATURE` payload → facilitator verify+settle → `PAYMENT-RECEIPT`), gasless USDC via EIP-3009 (§5.3).
- **AP2 mandates** (Intent → Cart → Payment, as W3C VCs) — the model for delegated authorization and larger jobs; the `DelegationCredential` and quote/commit objects map onto it.
- **MCP** — a listing may declare itself MCP-invocable (`endpoint.mcp_tool`); the invocation surface of a paid service can be an MCP tool.
- **A2A** — the Agent Passport aligns with A2A Agent Cards; messaging/negotiation/delegation models A2A task semantics.

Praxis deliberately *extends beyond* all of these in four areas none of them cover: measured cross-surface reputation from receipts, the signed append-only metered Board, micro-postage anti-spam on messaging, and stake/trust-bound ranking + machine-to-machine dispute adjudication (§13.4).

## Canonical reference map (where things are defined)

| Need | Section |
|---|---|
| Core data models index | §14.1 |
| Full API endpoint list | §14.2 |
| End-to-end flows (atomic x402; escrow negotiation) | §14.3, §14.4 |
| Listing schema | §3 |
| Agent Passport / DelegationCredential | §4.1 / §4.2 |
| CapabilityQuery / ranking | §2.1 / §2.3 |
| Quote / 402 handshake objects | §5.2 / §5.3 |
| Message schema + type table + thread state machine | §7 |
| Board post types + provenance | §8 |
| EscrowContract + lifecycle | §6.2 |
| ReputationSnapshot + dispute resolution | §9.2 / §9.5 |
| Receipt | §11 |
| Threat model & explicitly unsolved problems | §15 |

§15 lists problems the design does **not** fully solve (cold-start trust, sybil/collusion, settlement-risk window, the oracle problem for subjective work, griefing, prompt injection, key compromise, privacy-vs-auditability, regulatory exposure). Treat these as known open issues, not bugs to "fix" casually — each notes its residual risk after mitigations.

## Implementation conventions

Stack: **TypeScript (ESM) · Fastify v5 + Zod · Vitest · pnpm**, Node ≥ 20. Strict TS (`noUncheckedIndexedAccess`), Ed25519 detached JWS over JCS (RFC 8785), SHA-256 hash chains. The user's global conventions in `~/.claude/CLAUDE.md` apply (feature-first layout, strict inward layer direction, public-API-per-module barrels, Conventional Commits).

### Commands

```bash
pnpm install                 # install (lockfile is pnpm v9.0; use pnpm 10/11)
pnpm dev                     # run server with hot reload (tsx watch) on :8080
pnpm typecheck               # tsc --noEmit (strict) — must be clean
pnpm test                    # full Vitest suite (currently 304 tests, 20 files)
pnpm exec vitest run <path>  # run a single file/dir, e.g. src/features/board
pnpm exec vitest run -t "<name>"   # run tests matching a name
pnpm lint                    # eslint (rules are warnings, not errors)
pnpm build                   # tsup → dist/server.js (ESM; runtime deps external)
docker build -t praxis .     # multi-stage image; runs node dist/server.js as non-root
docker compose up --build    # memory persistence by default (set GOV_API_KEY)
```

CI (`.github/workflows/ci.yml`) runs lint · typecheck · test · build on Node 20 & 22, plus a Docker image build + `/health` smoke test. Keep `pnpm typecheck` and `pnpm test` green before declaring work done.

### Layout & wiring

- **Foundation** (do not casually redesign): `src/domain/` (pure value types + invariants, no framework imports), `src/shared/` (config, crypto, errors, http envelope, **ports**, time, logger), `src/infrastructure/` (in-memory persistence adapters, rail registry).
- **Core substrate**: `src/core/{identity,ledger,policy,reputation}/`. **Features**: `src/features/{registry,settlement/*,mailroom,board,governance}/` — each a self-contained module with a single `index.ts` barrel and a `buildXxx(deps)` factory. No deep cross-feature imports.
- Cross-module collaborators are **ports** in `src/shared/ports/index.ts`; the composition root `src/container.ts` is the only place that knows concrete implementations and wires the two dependency cycles (policy↔settlement usage; settlement↔governance approvals) with lazy port proxies. No module reads `process.env` — config is validated once in `src/shared/config/index.ts` and injected.
- `BUILD_CONTRACT.md` is the precise per-module build contract (ports, signing conventions, factory/route shapes); read it before adding or changing a module.

### Persistence

Default `PERSISTENCE=memory` is fully self-contained (no DB needed to run or test). The production target is **Prisma + PostgreSQL** (`prisma/schema.prisma`); it is documented and scaffolded but not yet wired into the container — adding it is a new adapter behind the existing ports plus a `container.ts` branch, with no feature-code changes (see `docs/adr/0005-*`). Run `pnpm prisma:generate` only when working on that path.
