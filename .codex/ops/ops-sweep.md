# Corgtex Ops Sweep

Purpose: detect production, demo, worker, and client readiness failures cheaply before paid monitoring is required.

Run cadence: hourly.

Railway continuous layer:

- `deploy/railway.ops-monitor.toml` runs the lightweight health sweep every 15 minutes.
- Configure the Railway cron service with `OPS_CREATE_GITHUB_ISSUES=true`, `OPS_GITHUB_REPOSITORY`, `OPS_GITHUB_TOKEN`, and the health target environment variables.
- Configure Railway deployment and volume webhooks to `POST /api/webhooks/railway` with `RAILWAY_WEBHOOK_SECRET`; Slack fan-out is optional through `OPS_SLACK_WEBHOOK_URL`.

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
