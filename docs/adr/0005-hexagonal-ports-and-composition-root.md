# 5. Hexagonal ports + a single composition root with lazy proxies

Status: Accepted
Date: 2026-06-06
Spec: outline.md §1; BUILD_CONTRACT.md

## Context

Praxis is one process composed of many modules (identity, ledger, policy,
reputation, registry, settlement, mailroom, board, governance) that must call each
other, plus swappable persistence (in-memory default, Prisma/Postgres target) and
swappable rails. Two failure modes had to be designed out:

1. **Hidden coupling** — a module reaching a global, a singleton, or `process.env`
   directly, so its dependencies are invisible and it cannot be tested or swapped.
2. **Construction-order deadlock** — genuine cyclic dependencies between modules
   that make "build A, then B" impossible in either order.

The cycles are real, not accidental: the policy signer needs settlement's
`UsagePort` (to know spend-to-date), while settlement needs the signer; and
settlement parks `needs_approval` actions into governance's `ApprovalPort`, while
governance reads settlement's `WalletQueryPort`.

## Decision

Adopt a **hexagonal** structure with one **composition root**.

- Every cross-module collaborator is a **port** interface declared in
  `src/shared/ports/index.ts`. Modules import collaborators *only* as ports, never
  concrete classes; each feature exposes a single `index.ts` barrel and a
  `buildXxx(deps)` factory.
- Domain (`domain/`) imports no framework, transport, or persistence. Dependencies
  flow inward only (transport → application → domain → infrastructure).
- `src/container.ts` is the **only** place that knows concrete implementations. It
  constructs every module, injects ports by name, and wires the graph. No module
  reads `process.env`; config is validated once at the boundary and passed in.
- The two dependency cycles are broken with **lazy port proxies**: the container
  builds `policy` against a lazy `UsagePort` and a lazy `ApprovalPort`, constructs
  `settlement` and `governance`, then `bind()`s the proxies to the real
  implementations. The proxies throw if used before binding — safe because requests
  only arrive after wiring completes.

## Consequences

**Positive**

- Swapping persistence (`memory` ↔ `prisma`) or a rail is a container change; no
  feature code moves, because everything is behind a port.
- Modules are unit-testable with trivial in-memory fakes (the test suite does
  exactly this with `FakeApprovals`, `FakeLedger`, `FixedClock`, …).
- Dependencies are explicit and grep-able: a module's needs are exactly its `deps`
  argument.

**Negative / costs**

- The lazy proxies add a small amount of indirection and one failure mode
  ("used before wiring") that exists only to make the cycles constructible. They
  are documented in `container.ts` precisely because they are non-obvious.
- A single composition root grows with the system; it is the one file that must
  understand every module's wiring. We accept that concentration as the price of
  keeping every *other* file free of wiring concerns.
- Ports must stay minimal and stable — they are the contract the whole graph
  depends on. Widening a port ripples to every implementor and fake.
