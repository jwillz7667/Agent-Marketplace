<!-- Keep PRs small and reviewable. One logical change per PR. -->

## What & why

<!-- What does this change do, and why? Link the issue or spec section (e.g. outline.md §6.2). -->

Closes #

## Type of change

- [ ] `feat` — new behavior
- [ ] `fix` — bug fix
- [ ] `refactor` — no behavior change
- [ ] `perf` — performance
- [ ] `docs` / `test` / `chore` / `build` / `ci`

## Spec alignment

<!-- outline.md is the source of truth. If this touches a schema or endpoint, cite the section. -->

- Spec section(s):
- Does this change a load-bearing invariant (signing, idempotency, below-agent enforcement, measured reputation, append-only board)? If so, explain why it's safe.

## Test plan

<!-- How did you verify this? Commands + expected results. -->

```bash
pnpm typecheck && pnpm test
```

## Checklist

- [ ] `pnpm typecheck` is clean
- [ ] `pnpm test` passes
- [ ] `pnpm lint` has no new errors
- [ ] No secrets or real credentials committed
- [ ] Conventional Commit message(s)
- [ ] Docs/ADR updated if architecture or public surface changed
