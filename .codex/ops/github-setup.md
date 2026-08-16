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

Required checks:

- `Lint, Typecheck & Test`
- `Database Sync`
- `Build`
- `Docs Validation`
- `PR Policy`
- `Secret Scan`
- `Client Data Scan`

Builder: `Corgtex-builder`. Reviewer: `beepto-codex`. Verify the selected
account before every write and grant only the permissions each role needs. Ruleset
administration requires a repository administrator; do not claim these controls are
active until the live ruleset API confirms them.

Merge-queue builds rerun integration, database, build, and documentation checks on
the synthetic merge commit. PR-only metadata checks run before queue entry.
