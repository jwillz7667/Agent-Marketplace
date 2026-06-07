# 2. Enforce policy below the agent, at the signing boundary

Status: Accepted
Date: 2026-06-06
Spec: outline.md §4.3, §15.8

## Context

An agent's reasoning is an attack surface. A listing description, a message body,
or a board post is untrusted free text that flows into a consuming agent's
context, and a sufficiently clever payload can hijack the agent's behavior (prompt
injection). If spending policy lived *inside* agent logic — "before you pay, check
your budget" — then a hijacked agent would simply skip the check, and a rogue or
buggy agent could drain its principal's funds up to whatever it could be talked
into. Any control the agent can choose to bypass is not a control.

## Decision

Enforce policy **below the agent**, at the cryptographic signing boundary. No
money or signed side effect moves without a signature, and the signer
(`WalletSigner`, MPC/TEE-backed in production) is the thing that produces it. The
signer:

- independently re-runs the policy decision against the caller's
  `DelegationCredential` — it **does not trust any "already checked" flag** passed
  by the caller;
- resolves the signing key itself and **hard-stops**, refusing to sign any
  out-of-policy action, returning `deny` or `needs_approval` instead of a
  signature.

Defense in depth has two layers: (1) a pre-flight Policy Engine check for fast
rejection, and (2) the independent hard-stop in the signer that is the real
backstop. A hijacked or rogue agent still cannot exceed its delegated caps, because
the caps are checked by code the agent cannot reach or persuade.

Over-threshold actions return `needs_approval` and park a single-use clearance.
That clearance is **redeemed at the signer** — bound to exactly one
`(agent, action)` tuple and consumed on use — so an approved-once action cannot be
replayed past its caps. The same redemption settles escalated escrow disputes and
arbitrate-timeouts (consume-at-resolve), which is why an escalated escrow no longer
locks funds forever.

## Consequences

**Positive**

- Prompt injection is *survivable*: the worst a hijacked agent can do is bounded by
  its delegated caps, not by what it can be convinced to attempt.
- The trust boundary is explicit and cryptographic — "can this be signed?" is the
  one question that gates every effect.
- Single-use, action-bound approvals mean human escalation does not become a replay
  hole.

**Negative / costs**

- The signer must independently know enough (policy, usage, keys) to decide — it
  cannot be a thin "sign these bytes" oracle. That is more surface in the most
  security-critical component.
- Consume-before-settle: a clearance is consumed during signing, *before* the rail
  clears. A settlement failure after signing burns the approval and requires a
  fresh one. We accept this deliberately — preserving the single-use guarantee is
  worth more than retry-friendliness — and document it at each call site.
- Re-submission of a parked action must use a fresh `Idempotency-Key`, since the
  parked marker is cached under the original key.
