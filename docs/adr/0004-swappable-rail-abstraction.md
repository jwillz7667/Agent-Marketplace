# 4. Settle value behind a swappable `rail` abstraction

Status: Accepted
Date: 2026-06-06
Spec: outline.md §5, §13.1, §13.2

## Context

Payment technology turns over far faster than the rest of a marketplace. Praxis
adopts **x402** (gasless USDC via EIP-3009) for the atomic per-call handshake
today, but the design must accommodate an **AP2 card mandate** rail and a sessions
rail tomorrow without a rewrite. The risk to guard against is a single rail's
assumptions (a blockchain nonce, a chain id, a stablecoin's decimals) leaking
upward into identity, discovery, or messaging — at which point "support a new rail"
becomes "re-architect the system." This is the settlement leg of the separation in
[ADR-0001](./0001-three-substrate-separation.md).

## Decision

All value movement goes through a `rail` **port** with a uniform verb set
(`infrastructure/rail/`): given a signed payment payload and a quote, a rail
**verifies** then **settles**, and the Facilitator issues a signed `PAYMENT-RECEIPT`.
The rest of the system speaks only quotes, payloads, and receipts — never a rail's
internals.

- A `Quote` (§5.2) names its `rail` as an opaque string; the listing declares which
  rails it accepts. Selecting a rail is data, not a code path elsewhere.
- The x402 handshake (`402 Payment Required` → `PAYMENT-REQUIRED` requirements →
  signed `PAYMENT-SIGNATURE` → facilitator verify+settle → `PAYMENT-RECEIPT`) is
  one rail implementation, registered in a `RailRegistry`.
- Adding a rail = adding an adapter that satisfies the port and registering it. The
  `(Idempotency-Key, quote_id)` pairing that prevents double-charge and detects
  settled-but-undelivered calls (§6.1) lives **above** the rail, so it holds for
  every rail uniformly.

The same logical escrow milestone settles over `rail: 'escrow'` internally and
could clear externally over any registered rail without the escrow state machine
changing.

## Consequences

**Positive**

- New rails are additive and isolated; identity, discovery, and messaging never
  learn a rail exists.
- Idempotency, receipts, and reputation are rail-agnostic — implemented once, true
  for all rails.
- Tests can run against an in-memory rail with no external dependency.

**Negative / costs**

- The port must be the *intersection* of what rails need, expressed generically
  (verify/settle over a signed payload). Rail-specific richness (on-chain proofs,
  card-network mandates) has to be carried as opaque fields, validated inside the
  adapter, not in shared code.
- secp256k1 is permitted *only* where an on-chain rail requires it; Ed25519 remains
  the default everywhere else. Supporting two curve families is a real complexity
  the abstraction must contain rather than spread.
- An over-general port risks a lowest-common-denominator that serves no rail well;
  the boundary needs review whenever a structurally different rail is added.
