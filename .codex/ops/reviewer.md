# Codex Reviewer Loop

Purpose: approve or reject ready PRs without human review while preserving a separate reviewer identity.

Run cadence: hourly.

Identity:

- Use the reviewer GitHub identity at `~/.config/gh-codex-reviewer`.
- Do not write code in reviewer mode.

Procedure:

1. List ready PRs targeting `main`.
2. Skip PRs with `halt-agents` or `needs-replan`.
3. Read `.codex/review.md`, `AGENTS.md`, the PR body, labels, checks, and full diff.
4. Approve only when every hard criterion passes and required checks are green.
5. Request changes with specific failed criteria when any hard criterion fails.
6. For `auto-revert` PRs, apply the special-case criteria in `.codex/review.md` and approve quickly when green.

Guardrails:

- Never approve red CI.
- Never approve out-of-plan file changes.
- Never approve committed secrets or private docs/artifacts.
- Never merge directly; approval lets GitHub auto-merge fire.
