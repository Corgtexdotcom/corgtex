# GitHub Automation Setup

Purpose: keep builder and reviewer powers separated while allowing unattended auto-merge.

Required identities:

- `corgtex-codex-builder`: creates branches, commits, PRs, issue comments, labels, and auto-merge requests.
- `beepto-codex`: reviews PRs and approves or requests changes.

Required branch protection for `main`:

- Require pull request before merge.
- Require one approval.
- Require approval of the most recent reviewable push.
- Require status checks.
- Require merge queue.
- Restrict direct pushes to `main`.
- Do not allow agents to bypass branch protection.

Required checks:

- `Lint, Typecheck & Test`
- `Database Sync`
- `Build`
- `Docs Validation`
- `Plan Present`
- `Scope Check`
- `Secret Scan`
- `Diff Size`
- `Client Data Scan`
- `Review Snapshot Integrity`

Required merge-queue settings:

- Grouping strategy: `ALLGREEN`; merge method: `MERGE`.
- `max_entries_to_build: 1` and `max_entries_to_merge: 1`.
- Preserve strict required-status mode, one required approval, `dismiss_stale_reviews: true`, `require_last_push_approval: true`, required conversation resolution, and the merge-queue requirement.
- Preserve the pre-existing `enforce_admins: false` setting and ruleset `15359360`'s `RepositoryRole` `pull_request` bypass actor exactly; this change neither removes nor widens either.

After the gate PR merges, an authorized human administrator adds the new context and changes both queue maxima in one settings action. Before and after that write, use read-only `gh api` calls for `repos/{owner}/{repo}/branches/main/protection` and `repos/{owner}/{repo}/rulesets/15359360`; normalize and compare the complete required-context set, strict mode, review settings, conversation resolution, queue grouping/method/maxima, `enforce_admins`, and bypass actors. Stop and roll back the settings action on any unexpected difference. No agent may bypass protection to make this change.

Required secrets:

- Codex Builder: GitHub credentials for `corgtex-codex-builder`.
- Codex Reviewer: GitHub credentials for `beepto-codex`.
- Railway cron/webhook incident creation: `OPS_GITHUB_TOKEN` with repository issue access and `OPS_GITHUB_REPOSITORY=owner/repo`.
- Railway webhook authentication: `RAILWAY_WEBHOOK_SECRET`.
- Optional Slack notification fan-out: `OPS_SLACK_WEBHOOK_URL`.

Operational labels:

- `ops-auto-fix`
- `ops-incident`
- `severity-p1`
- `severity-p2`
- `severity-p3`
- `halt-agents`
- `needs-replan`
- `auto-revert`

Rules:

- Builder identity never approves.
- Reviewer identity never writes code.
- Auto-merge is set by the builder, but the merge only happens after reviewer approval and green required checks.
