# Codex Reviewer Loop

Purpose: approve or reject ready PRs without human review while preserving a separate reviewer identity.

Run cadence: hourly.

Identity:

- Use the reviewer GitHub identity at `~/.config/gh-codex-reviewer`.
- Do not write code in reviewer mode.

Procedure:

1. List ready PRs targeting `main`.
2. Skip PRs with `halt-agents` or `needs-replan`.
3. Snapshot the exact `headRefOid`, `baseRefOid`, and the complete PR
   body as returned by GitHub. The body may be compared byte-for-byte or
   through a SHA-256 digest of the exact returned UTF-8 content, with no
   normalization before hashing. Review only that exact head/base/body
   snapshot.
4. Read `.codex/review.md`, `AGENTS.md`, the PR body, labels, checks, and full diff.
5. Approve only when every hard criterion passes and required checks are green.
6. Immediately before approval, re-fetch the complete PR state and
   compare the current `headRefOid`, `baseRefOid`, and exact PR body
   with the snapshot, and recheck open/ready state, blocking labels,
   required checks, and actionable threads. Both OIDs and the body must
   equal the snapshot and no new actionable thread may have appeared; a
   PR-body change invalidates the review even when neither Git OID
   changes and CI does not rerun. Any change discards the review and
   requires a full restart from step 1.
7. Request changes with specific failed criteria when any hard criterion fails.
8. For `auto-revert` PRs, apply the special-case criteria in `.codex/review.md` and approve quickly when green.

Guardrails:

- Reviewer mode is fully read-only: never edit files, commit, push,
  change the PR body, resolve builder-owned threads, implement fixes,
  merge, deploy, or run operational actions.
- After approval, any later head, base, or PR-body change makes the
  approval stale and requires a fresh independent review.
- Never approve red CI.
- Never approve out-of-plan file changes.
- Never approve committed secrets or private docs/artifacts.
- Never merge directly; approval lets GitHub auto-merge fire.
