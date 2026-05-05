# Railway Restart and Redeploy Rules

Purpose: allow Codex to perform narrowly scoped Railway recovery actions without direct rollback access.

Supported commands:

- `node scripts/ops/railway-action.mjs inspect --service <name>`
- `node scripts/ops/railway-action.mjs restart --service <name> --confirm`
- `node scripts/ops/railway-action.mjs redeploy-current --service <name> --confirm`

Required environment:

- `RAILWAY_API_TOKEN`
- `RAILWAY_OPS_ALLOWLIST_JSON`
- `RAILWAY_WEBHOOK_SECRET` for Railway webhook ingestion.
- `OPS_SLACK_WEBHOOK_URL` if Railway webhooks should also notify Slack.
- `OPS_GITHUB_REPOSITORY` and `OPS_GITHUB_TOKEN` if Railway webhooks or cron checks should open GitHub incidents without the GitHub CLI.

Allowlist shape:

```json
[
  {
    "service": "web",
    "serviceId": "railway-service-id",
    "environmentId": "railway-environment-id",
    "deploymentId": "optional-current-deployment-id"
  }
]
```

Rules:

- Always run with `--dry-run` first.
- Mutations require `--confirm`.
- Only allowlisted service names may be targeted.
- `restart` uses `deploymentRestart`.
- `redeploy-current` uses `serviceInstanceDeployV2` for the allowlisted service/environment.
- Rollback is forbidden; use the GitHub auto-revert path.
- Railway webhook ingestion must use the shared secret; do not expose an unauthenticated webhook URL.
