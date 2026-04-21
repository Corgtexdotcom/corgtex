# Plan: Agentic development pipeline (Plan → Execute → Review)

## Goal

Establish the guardrails and canonical docs for a fully autonomous three-agent development pipeline:

- **Planner** — Claude (here or in Antigravity). Writes plans to `docs/plans/<branch>.md`.
- **Executor** — Gemini in Antigravity. Reads the plan, implements, opens the PR.
- **Reviewer** — Codex. Reviews against plan + diff + CI, approves or rejects.

Safety comes from structural separation (three different vendors) plus mechanical CI gates — not human review.

## Out of scope

- GitHub branch protection configuration (must be done by the human operator in the repo settings UI; this PR documents the required settings but cannot apply them).
- Provisioning Codex as a GitHub App on the repo (human operator step; documented).
- Creating separate bot accounts (not needed — the three vendors provide identity separation).
- Any runtime / product code changes.
- Cypress / Playwright E2E scaffolding (testing guidance stays as-is).

## Files to touch

- `AGENTS.md`
- `CONTRIBUTING.md`
- `docs/contributing/pull-requests.mdx`
- `docs/contributing/testing.mdx`
- `docs/contributing/agent-pipeline.mdx`
- `docs/plans/_TEMPLATE.md`
- `docs/plans/claude-hopeful-goldstine-6c0150.md`
- `docs/docs.json`
- `scripts/check-plan.mjs`
- `.github/workflows/ci.yml`
- `.github/workflows/auto-revert.yml`
- `.codex/review.md`

## Acceptance criteria

- [x] `AGENTS.md` restructured with explicit `## For Planners`, `## For Executors`, `## For Reviewers` sections; stale `npm run test:integration` claim fixed.
- [x] `docs/plans/_TEMPLATE.md` exists with the Goal / Out of scope / Files to touch / Acceptance / Test plan / Rollback format.
- [x] `docs/contributing/agent-pipeline.mdx` is the canonical spec for the three-agent flow (roles, handoff, labels, halt procedure, branch-protection requirements, rollback).
- [x] `CONTRIBUTING.md`, `docs/contributing/pull-requests.mdx`, `docs/contributing/testing.mdx` no longer duplicate rules — they link to AGENTS.md / agent-pipeline.
- [x] `scripts/check-plan.mjs` verifies (a) plan file exists for the branch and (b) changed files ⊆ plan's "Files to touch" allowlist. Exits non-zero on failure.
- [x] New CI jobs in `.github/workflows/ci.yml`: `plan-present`, `scope-check`, `gitleaks`, `diff-size`. Each runs only on pull requests.
- [x] `.github/workflows/auto-revert.yml` opens a revert PR when `smoke-prod` fails on `main`.
- [x] `.codex/review.md` contains the rejection criteria the Reviewer uses.
- [x] `docs/docs.json` navigation includes the new `agent-pipeline` page.
- [x] `npm run check` passes.
- [x] The scope-check script, when run locally against this branch, passes against this plan.

## Test plan

- `npm run check` (lint + typecheck + prisma validate).
- `node scripts/check-plan.mjs` against the current branch — should pass.
- Manual inspection: open `docs/contributing/agent-pipeline.mdx` and verify all referenced paths exist.
- YAML lint of both workflow files (verify valid GitHub Actions syntax by shape — no new executable paths yet that need live CI to validate).

## Rollback

Pure docs + CI additions. Revert the PR; no database, no runtime, no user-facing behavior affected. The auto-revert workflow is dormant until `smoke-prod` fails, so adding it is safe.

## Labels this PR needs

- `forbidden-path-approved` — this PR modifies `.github/workflows/ci.yml` and adds `.github/workflows/auto-revert.yml`. That is the canonical justification: the whole point of this PR is to establish the CI gates that enforce the pipeline, which necessarily requires workflow changes. Subsequent PRs will not need this label unless they again touch CI, deploy, migrations, or auth.

Within the scope caps otherwise (12 files, 387 code LOC vs. caps of 15 / 400).
