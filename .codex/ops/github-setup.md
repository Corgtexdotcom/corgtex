# GitHub protection setup

The repository policy assumes an active ruleset for `main` with:

- pull requests required;
- one independent approval;
- stale approvals dismissed on push;
- approval of the most recent reviewable push;
- conversations resolved;
- required status checks;
- merge queue enabled;
- direct pushes and force pushes blocked; and
- no agent bypass of these protections.

`.github/workflows/pr-policy-metadata.yml` must remain enabled. It revalidates live
PR metadata from trusted default-branch code, publishes the distinct
`PR Metadata Policy` status on PR and merge-group SHAs, and removes invalid PRs from
the merge queue without rerunning build and test jobs.

Target required checks after staged activation:

- `Lint, Typecheck & Test`
- `Database Sync`
- `Build`
- `Docs Validation`
- `PR Policy`
- `PR Metadata Policy`
- `Secret Scan`
- `Client Data Scan`

Builder: `Corgtex-builder`. Reviewer: `beepto-codex`. Verify the selected
account before every write and grant only the permissions each role needs. Ruleset
administration requires a repository administrator; do not claim these controls are
active until the live ruleset API confirms them.

Activation order is mandatory:

1. Land and observe the replacement PR and merge-group publishers while Review
   Snapshot Integrity remains required.
2. Replace the legacy `Plan Present`, `Scope Check`, and `Diff Size` requirements
   with `PR Policy`; add `PR Metadata Policy`; then read back the live settings.
3. Prove a valid PR can enter the queue and an invalid metadata edit fails and
   dequeues it.
4. Remove Review Snapshot Integrity in a later protected cleanup PR.

Merge-queue builds rerun integration, database, build, documentation, and metadata
checks on the synthetic merge commit.
