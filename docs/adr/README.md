# Architecture Decision Records

Each ADR captures one non-trivial, load-bearing decision in the Praxis backend:
the context that forced it, the decision taken, and the consequences (good and
bad) we accept. They are immutable once `Accepted` — a reversal is a new ADR that
supersedes, not an edit.

Format: Context · Decision · Consequences (after Michael Nygard). The spec these
realize is [`outline.md`](../../outline.md); section references (`§N`) point into
it.

| # | Title | Status |
|---|---|---|
| [0001](./0001-three-substrate-separation.md) | Separate authorization, settlement, and transport | Accepted |
| [0002](./0002-below-agent-signer-enforcement.md) | Enforce policy below the agent, at the signing boundary | Accepted |
| [0003](./0003-measured-reputation-from-receipts.md) | Measure reputation from settled receipts, never self-report | Accepted |
| [0004](./0004-swappable-rail-abstraction.md) | Settle value behind a swappable `rail` abstraction | Accepted |
| [0005](./0005-hexagonal-ports-and-composition-root.md) | Hexagonal ports + a single composition root with lazy proxies | Accepted |
