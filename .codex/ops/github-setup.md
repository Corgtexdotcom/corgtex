# GitHub protection

Use native protection for `main`: one independent approval, stale-approval dismissal,
latest-push approval, resolved conversations, required checks, and merge queue.
Agents cannot push directly to main, force-push, or bypass these controls.

Required checks:

- `Lint, Typecheck & Test`
- `Database Sync`
- `Build`
- `Docs Validation`
- `PR Policy`
- `PR Metadata Policy`
- `Secret Scan`
- `Client Data Scan`

The metadata workflow executes trusted base code, validates live PR metadata, and
removes invalid PRs from the queue. Its merge-group evaluator validates actual queue
membership, current heads/bases, approvals, and metadata drift. The evaluator retains
its historical filename `scripts/review-snapshot-integrity.mjs`; there is no custom
attestation or separate snapshot publisher. Valid metadata changes do not dismiss
code approvals. The independent reviewer still assesses substantive scope changes.

When updating required contexts, verify the replacement already succeeds on PR and
merge-group SHAs, save current settings, update only the intended contexts, and read
back the result. Preserve existing review and queue controls. Compatibility aliases
may remain during rollout; they are inexpensive wrappers, not extra review stages.
Restore saved settings if activation fails. Never bypass protection to repair it.

Builder: `Corgtex-builder`; reviewer: `beepto-codex`. Verify the selected identity
immediately before each GitHub write. The owner queues the approved PR; the reviewer
never edits or merges. Live GitHub configuration is authoritative.
