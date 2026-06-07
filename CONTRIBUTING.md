# Contributing to Praxis

Thanks for your interest in improving Praxis. This document covers how to set up,
the conventions the codebase enforces, and how to get a change merged.

> **`outline.md` is the source of truth.** It is section-numbered (`§1`–`§15`) and
> defines every schema and endpoint. Code conforms to the spec — do not redesign a
> documented schema or endpoint silently. Propose spec changes as an issue first.

## Getting set up

Requires **Node ≥ 20** (CI runs 20 and 22) and **pnpm** (lockfile is `lockfileVersion 9.0`; use pnpm 10/11).

```bash
pnpm install
cp .env.example .env          # set GOV_API_KEY at minimum
pnpm dev                      # hot-reload server on :8080
```

The default `PERSISTENCE=memory` needs no database — the whole protocol runs and
tests in-process.

## The checks that must stay green

Before opening a PR, all of these must pass locally (and they gate CI):

```bash
pnpm typecheck      # tsc --noEmit, strict, noUncheckedIndexedAccess — must be clean
pnpm test           # full Vitest suite
pnpm lint           # eslint (warnings allowed; no new errors)
pnpm build          # tsup bundle must succeed
```

Run a focused subset while iterating:

```bash
pnpm exec vitest run src/features/board          # one module
pnpm exec vitest run -t "single-use approval"    # by test name
```

## Architecture rules (enforced by review)

These are non-negotiable — they keep the system swappable and the trust model intact:

- **Feature-first, hexagonal.** Group by domain feature, not technical layer. Each
  feature is a self-contained module with a single `index.ts` barrel and a
  `buildXxx(deps)` factory. No deep cross-feature imports.
- **Strict inward dependencies.** `transport → application → domain → infrastructure`.
  `src/domain/` imports no framework, transport, or persistence.
- **Ports, not concretes.** Cross-module collaborators are port interfaces in
  `src/shared/ports/index.ts`. Only `src/container.ts` knows concrete implementations.
- **No hidden globals.** No module reads `process.env`; config is validated once in
  `src/shared/config/` and injected.
- Read [`BUILD_CONTRACT.md`](./BUILD_CONTRACT.md) before adding or changing a module.

## Load-bearing invariants

Any change must preserve these (see `README.md` and `outline.md` §15):

- Everything signed (`nonce` + `iat` + `exp`; detached JWS over JCS).
- Idempotency wherever money or side effects occur.
- Policy enforced **below** the agent at the signing boundary.
- Reputation measured from settled receipts, never self-reported.
- Discovery is hard-filter then soft-rank; no paid placement.
- Board is append-only, hash-chained, Merkle-anchored.
- Untrusted free-text is data, never instructions.

If a PR touches one of these, say so explicitly and explain why it stays safe.

## Commits & PRs

- **[Conventional Commits](https://www.conventionalcommits.org/):** `feat:`, `fix:`,
  `refactor:`, `perf:`, `test:`, `docs:`, `chore:`, `build:`, `ci:`. Optional scope:
  `feat(board): ...`.
- **One logical change per commit.** Refactors and behavior changes never share a commit.
- **Imperative subject ≤ 72 chars.** Body explains *why*, not *what*.
- **Branches:** `feat/<short-slug>`, `fix/<slug>`.
- Keep PRs small and reviewable, with a test plan. Never merge red CI.

## Tests

Pyramid-shaped: many fast unit tests co-located as `*.test.ts`, fewer integration
flows under `test/integration/`. Prefer one meaningful test over five trivial ones.
Name tests by behavior: `it("returns 409 when the nonce was already used")`.

## Reporting bugs & security issues

- Functional bugs → open an issue using the bug template.
- **Security vulnerabilities → do not open a public issue.** Follow
  [`SECURITY.md`](./SECURITY.md).

## License

By contributing, you agree your contributions are licensed under the
[Apache License 2.0](./LICENSE).
