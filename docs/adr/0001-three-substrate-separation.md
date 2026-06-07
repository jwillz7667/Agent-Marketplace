# 1. Separate authorization, settlement, and transport

Status: Accepted
Date: 2026-06-06
Spec: outline.md §1, §5, §6

## Context

Human e-commerce fuses three concerns into one checkout page: *who is allowed to
buy* (authorization), *how the money moves* (settlement), and *how the request is
carried* (transport). That fusion is invisible to a human clicking "Pay," but it
is fatal for a protocol whose participants are programs. If authorization is
entangled with a specific payment processor, then changing how you pay forces
changes to who-may-do-what; if settlement is entangled with transport, then a new
payment rail forces a new wire protocol. For an agent economy that must outlive
any single payment technology — USDC today, a card mandate or a sessions rail
tomorrow — that coupling would calcify the whole system around its first rail.

## Decision

Keep the three substrates **architecturally separate**, each with its own object
model:

1. **Authorization** is expressed as signed delegation credentials + policy
   documents (`DelegationCredential`, §4.2). A `Principal→Agent` delegation chain
   *is* the spending policy. Authorization never names a payment processor.
2. **Settlement** is the movement of value, reached only through a `rail` port
   (see [ADR-0004](./0004-swappable-rail-abstraction.md)). The logical job is
   identical regardless of which rail clears it.
3. **Transport** is plain HTTP + JSON. It carries signed objects and nothing more;
   it has no opinion about authorization or money.

Concretely: identity/policy live in `core/` and `domain/`; settlement lives in
`features/settlement/` behind `infrastructure/rail/`; transport is `app.ts` +
Fastify route plugins. A deal resolves to a concrete `(listing_ref, quote_id)`
before any money moves, and the messaging layer never moves money — it emits a
signed agreement object the settlement layer consumes (§7.5).

## Consequences

**Positive**

- A new payment rail is an `infrastructure/rail/` adapter; it touches neither
  identity, discovery, nor messaging.
- Authorization is reasoned about and audited independently of payments — the
  signer can refuse an action without knowing how it would have settled.
- Each substrate is testable in isolation (policy evaluation needs no rail; rail
  tests need no DID registry).

**Negative / costs**

- More indirection than a fused checkout: a single payment crosses an authorization
  check, a quote, a rail call, and a receipt issuance, each a distinct object.
- The separation must be actively defended — see the "never reintroduce coupling"
  invariant. It is easy to "just read the rail config" inside a policy check and
  silently undo the boundary.
- Two object models (authorization mandates and settlement quotes) must be kept in
  correspondence (AP2 mapping, §13.2).
