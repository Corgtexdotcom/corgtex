# Auto-Revert Runbook

Purpose: restore production automatically when the post-deploy smoke check fails.

Flow:

1. A PR merges to `main`.
2. Railway autodeploys from `main`.
3. GitHub `smoke-prod` runs against production.
4. If smoke fails, `.github/workflows/auto-revert.yml` opens an `auto-revert` PR.
5. Codex Reviewer verifies the revert PR is a clean revert and required checks are green.
6. Codex Reviewer approves; GitHub auto-merge restores production.
7. Codex Builder opens or updates a follow-up issue for the original failing change.

Rules:

- Revert first, investigate second.
- Do not perform Railway rollback directly.
- Do not use `--admin`.
- Do not bypass secret scan or required checks.
