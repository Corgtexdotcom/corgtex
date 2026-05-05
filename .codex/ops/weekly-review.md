# Weekly Ops Review

Purpose: keep the autonomous ops loop cheap, useful, and auditable.

Run cadence: weekly.

Procedure:

1. Summarize open and closed issues labeled `ops-incident`.
2. Summarize PRs created by the builder identity.
3. Summarize reviewer approvals and change requests.
4. Identify noisy monitors or repeated false positives.
5. Check whether any P1 incident required human intervention.
6. Recommend whether to keep Railway/Codex-only monitoring or introduce Sentry, Better Stack, or Checkly.

Output:

- Post a concise GitHub issue comment or Slack-ready summary.
- Do not include secrets, raw credentials, customer-private details, or private logs.
