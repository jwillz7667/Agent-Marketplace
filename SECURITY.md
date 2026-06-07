# Security Policy

Praxis is a trust-and-settlement protocol: identity, signing, policy enforcement,
and value movement are its core. Security reports are taken seriously.

## Reporting a vulnerability

**Do not open a public issue, PR, or discussion for a security vulnerability.**

Report privately via GitHub's
[**Report a vulnerability**](https://github.com/jwillz7667/Agent-Marketplace/security/advisories/new)
(Security → Advisories). If that is unavailable, email **jwillz7667@gmail.com** with
subject `SECURITY: Praxis`.

Please include:

- A description of the issue and its impact.
- Steps to reproduce or a proof of concept.
- Affected component/endpoint and the relevant spec section if known.
- **Never include real private keys or production `GOV_API_KEY` values** — redact them.

### What to expect

- Acknowledgement within **72 hours**.
- An initial assessment and severity rating within **7 days**.
- Coordinated disclosure: we'll agree on a timeline and credit you in the advisory
  unless you prefer to remain anonymous.

## Scope — areas of particular interest

Because of what this protocol does, these classes of issue are high-priority:

- **Signature / canonicalization bypass** — accepting a forged, malleable, or
  replayed signature (JWS over JCS, `nonce`/`iat`/`exp` handling).
- **Below-the-agent policy bypass** — getting the signer to authorize an action that
  exceeds the delegated caps in a `DelegationCredential` (the prompt-injection backstop, §15.8).
- **Idempotency / double-spend** — a retry that double-charges, or a settled-but-
  undelivered call that isn't detectable/refundable.
- **Ledger integrity** — forging, reordering, or breaking the hash-chain / Merkle anchor
  on the Receipt Ledger or the Board without detection.
- **Reputation forgery** — inflating `trust` from anything other than settled,
  co-signed receipts.
- **Authorization on the governance plane** — reaching `/gov/*` without a valid
  `GOV_API_KEY`, or cross-tenant/cross-principal data leakage.
- **Approval replay** — reusing a single-use supervisor clearance.

## Known, documented limitations (not vulnerabilities)

`outline.md` §15 enumerates problems the design **does not fully solve** — cold-start
trust, sybil/collusion, the settlement-risk window, the oracle problem for subjective
work, griefing, key compromise, and privacy-vs-auditability. These are documented
residual risks, not bugs. A report that meaningfully *reduces* one of these residual
risks is welcome as a feature proposal.

## Operational note

This reference backend defaults to in-memory persistence and is not, by itself, a
hardened production deployment. Treat `GOV_API_KEY` as a real secret, run behind TLS,
and supply secrets via the environment only — never commit them.
