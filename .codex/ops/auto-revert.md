# Auto-Revert Runbook

Purpose: restore production automatically when the post-deploy smoke check fails.

Flow:

1. A PR merges to `main`.
2. Railway autodeploys from `main`.
3. GitHub `smoke-prod` runs against production.
4. If smoke fails, `.github/workflows/auto-revert.yml` checks current production health on the failed SHA.
5. If production is still unhealthy, the workflow opens an `auto-revert` PR.
6. Codex Reviewer verifies the revert PR is a clean revert and required checks are green.
7. Codex Reviewer approves; GitHub auto-merge restores production.
8. Codex Builder opens or updates a follow-up issue for the original failing change.
9. If production recovered on the failed SHA, rerun the trusted GitHub production smoke and fix forward for up to one hour before rollback.

Rules:

- Roll back first when production remains red after the recovery probe.
- If production recovered on the failed SHA, rerun the repo-managed GitHub production smoke before treating the deploy as broken.
- Use the recovered-production fix-forward window for smoke-script, deploy timing, or configuration fixes only; if the gate is not green or clearly explained within one hour, roll back.
- Do not perform Railway rollback directly.
- Do not use `--admin`.
- Do not bypass secret scan or required checks.
