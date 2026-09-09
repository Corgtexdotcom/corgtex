# Builder loop

Purpose: deliver a concrete, actionable incident fix through the normal protected
PR path.

- Identity: `Corgtex-builder` via `$HOME/.config/gh-corgtex-builder`.
- Read `AGENTS.md`, verify the incident is current, and stop on `halt-agents`.
- Use one clean task worktree from current `origin/main` and one coherent PR by
  default. Do not turn a repair into a reusable subsystem or PR train.
- Put concrete acceptance and completion conditions in the PR contract. Implement
  them, run the proportionate local checks in `AGENTS.md`, then push and use normal
  protected auto-merge/queueing once the required evidence is ready. Required hosted
  CI and independent exact-head review are unchanged.
- For an incident, reproduce the observed failing integration boundary early and
  preserve sanitized failure evidence through the existing diagnostic path. Keep
  the current outcome, missing acceptance, blocker and next action in one checkpoint.
  Follow `AGENTS.md` for evidence reuse and completion; do not extend a passing fix
  with discretionary hardening.
- Follow the model routing and correction policy in `AGENTS.md`: GPT-6 owns
  delivery and verifies optional bounded helper output. The first unsuccessful
  correction cycle triggers read-only GPT-6 reassessment. After the second, add
  `needs-replan`, report evidence, and stop for user approval. Do not create
  replacement or additional implementation PRs without explicit direction.
- Never push to `main`, self-approve, use `--admin` or `--no-verify`, run
  `prisma db push`, expose secrets, or mutate production data outside exact
  authorization.

When no code change is indicated, an allowlisted automation may restart or redeploy
its current Railway service using the repository helper. Rollback uses the protected
GitHub auto-revert path.
