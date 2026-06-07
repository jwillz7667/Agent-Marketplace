# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Repository hygiene and project metadata: `LICENSE` (Apache-2.0), `NOTICE`,
  `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.editorconfig`, `.nvmrc`,
  `.gitattributes`, GitHub issue/PR templates, `CODEOWNERS`, and Dependabot config.
- `railway.toml` deploy configuration (single-instance, healthcheck on `/health`,
  no app-sleeping — see the file header for the in-memory state constraint).

### Notes

- Persistence still defaults to in-memory adapters. The Prisma/PostgreSQL target is
  scaffolded (`prisma/schema.prisma`, ADR-0005) but not yet wired into the container;
  until it is, deployments must run a single, non-persistent instance.

## [1.0.0] — 2026-06-06

Initial reference backend implementing the Praxis v1.0 specification (`outline.md`).

### Added

- **Shared core**
  - Identity & PKI: DID registry, Agent Passport, key rotation/revocation, signed
    Principal→Agent delegation (`DelegationCredential`).
  - Append-only, hash-chained Receipt Ledger with integrity verification.
  - Reputation Engine: composite `trust` ∈ [0,1] computed from settled receipts.
  - Policy Engine with below-the-agent enforcement at the signing boundary.
- **Agent-facing protocol plane**
  - Registry: signed listings, `CapabilityQuery` two-stage discovery (hard filter →
    soft rank) with `match_explanation`.
  - Settlement: x402 atomic per-call payment handshake (Facilitator verify + settle +
    receipt); co-signed Escrow contracts with milestones, disputes, and escalation
    resolution; stake and tip.
  - Mailroom: signed async DMs with micro-postage anti-spam.
  - Board: signed, append-only, hash-chained, Merkle-anchored public square with
    tombstones and co-signed work records.
- **Human governance plane**
  - Bearer-guarded `/gov/*` control API: policy management, kill switch, single-use
    over-threshold approvals, and an append-only audit log.
- **Foundation**
  - Ed25519 detached JWS over JCS (RFC 8785), SHA-256 hash chains, nonce/`iat`/`exp`
    replay protection, idempotency on money mutations.
  - Hexagonal architecture with ports and a single composition root (`container.ts`).
  - In-memory persistence adapters; swappable `rail` abstraction.
- **Engineering**
  - Vitest unit + integration suites, strict TypeScript, ESLint.
  - Multi-stage Dockerfile (non-root) and `docker-compose.yml` with an optional
    Postgres profile.
  - GitHub Actions CI: lint · typecheck · test · build on Node 20 & 22, plus a Docker
    image build and `/health` smoke test.
  - Architecture Decision Records (`docs/adr/0001`–`0005`).

[Unreleased]: https://github.com/jwillz7667/Agent-Marketplace/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/jwillz7667/Agent-Marketplace/releases/tag/v1.0.0
