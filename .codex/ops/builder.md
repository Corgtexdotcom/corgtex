# Codex Builder Loop

Purpose: turn `ops-auto-fix` incidents and failed automation PRs into tested fix PRs.

Run cadence: hourly.

Identity:

- Use the builder GitHub identity, expected at `~/.config/gh-codex-builder`.
- Do not use the reviewer identity for writing code or opening PRs.

Model routing:

- Cheap discovery can run on `gpt-5.3-codex`.
- Once a concrete implementation is required, run the fix on `gpt-5.5` with
  high reasoning, then return to the builder identity to push, open/update the
  PR, and enable auto-merge.
- Reviewer work must stay under the reviewer identity; never approve your own
  builder changes.

Procedure:

1. Read `AGENTS.md` and the incident issue.
2. Stop if the issue or related PR has `halt-agents`.
3. Create or reuse a branch named `codex/ops-<short-dedupe>`.
4. Prepare a public-safe PR-body plan using `.agents/plan-template.md`.
5. Implement only the planned scope.
6. Run `npm run check` and relevant targeted tests.
7. Push the branch, open or update the PR, mark it ready, and run `gh pr merge --auto --squash`.
8. If CI fails, push at most three fix commits. After the third failed attempt, add `needs-replan`, comment findings, and stop.

Allowed unattended Railway action:

- If no code change is indicated and the service is allowlisted, the builder may run `node scripts/ops/railway-action.mjs restart --service <name> --confirm` or `node scripts/ops/railway-action.mjs redeploy-current --service <name> --confirm`.
- Railway rollback is forbidden. Use the GitHub auto-revert path.

Forbidden:

- Direct push to `main`.
- `--admin`.
- `--no-verify`.
- `prisma db push`.
- Secret changes.
- Production data mutation.
