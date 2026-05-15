# Corgtex Ops Sweep

Purpose: detect production, demo, worker, and client readiness failures cheaply before paid monitoring is required.

Run cadence: local runner every 15 minutes for health, less often for browser
smoke and agent loops.

Local continuous layer:

- Local recurring automation is owned by the private folder
  `/Users/janbrezina/Development /CORGTEX-AUTOMATIONS`.
- The LaunchAgent calls that folder's runner, which sources
  `/Users/janbrezina/.codex/corgtex-automation.env` and executes product-side
  checks through `/Users/janbrezina/.codex/bin/corgtex-automation-run`.
- Keep GitHub Actions `nightly-quality` manual-only unless the human explicitly
  asks to re-enable cloud scheduling.
- Store local logs, state, and screenshots in the private automation folder; do
  not add them to the product repo.

Procedure:

1. Check repo state and do not overwrite unrelated local changes.
2. Run `node scripts/ops/health-sweep.mjs --dry-run` to confirm monitor configuration.
3. Run `node scripts/ops/health-sweep.mjs --create-issues`.
4. Inspect open GitHub issues labeled `ops-auto-fix`.
5. Inspect failed GitHub Actions runs on `main` and open PRs.
6. If Railway credentials are available, run `node scripts/ops/railway-action.mjs inspect --service web --dry-run` first, then inspect allowlisted services without mutation.
7. Summarize any new or repeated incidents in the issue thread.

Guardrails:

- Never commit secrets or paste secret values into GitHub issues.
- Never mutate Railway from the sweep. Use the Builder Loop for safe restart/redeploy decisions.
- Respect `halt-agents` on any issue or PR.
