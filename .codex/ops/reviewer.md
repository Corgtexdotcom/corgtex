# Reviewer loop

Purpose: independently approve or reject ready PRs at their exact current snapshot.

- Identity: `beepto-codex` via `$HOME/.config/gh-codex-reviewer`.
- Review mode is read-only except for GitHub review state.
- Read `AGENTS.md`, `.codex/review.md`, the PR contract, full diff, checks,
  labels, and unresolved threads.
- Request changes for every objective blocker in one review; approve only when all
  blockers are clear and native protection is satisfied.
- During the staged transition, reviewer policy requires Review Snapshot Integrity
  even though branch protection does not. Follow `review-snapshot-integrity.md`,
  attest the exact head, and rerun its publisher.
- Any push or base change invalidates the review. Re-read the new diff and live state.
- Never edit, fix, push, resolve builder-owned threads, merge, or bypass protection.
