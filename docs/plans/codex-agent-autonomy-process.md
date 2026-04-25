# Agent Autonomy Process Upgrade

## Goal

Reduce review and merge friction in the autonomous agent pipeline by moving routine PRs to risk-tiered caps and automating common reviewer blockers, while keeping strict gates for security-sensitive changes.

## Risk tier

- `high`

This change touches CI workflow policy and reviewer rules, so it must use the high-risk tier and the `forbidden-path-approved` label.

## Out of scope

- Changing app runtime behavior.
- Changing branch protection settings in GitHub.
- Removing CI, secret scanning, migration checks, or merge queue requirements.

## Files to touch

- `AGENTS.md`
- `.codex/review.md`
- `.github/pull_request_template.md`
- `.github/workflows/ci.yml`
- `docs/contributing/agent-pipeline.mdx`
- `docs/contributing/pull-requests.mdx`
- `docs/contributing/testing.mdx`
- `docs/plans/_TEMPLATE.md`
- `docs/plans/codex-agent-autonomy-process.md`
- `scripts/check-plan.mjs`

## Acceptance criteria

- [x] Plan files require a `Risk tier` of `low`, `standard`, or `high`.
- [x] `diff-size` applies risk-based caps and keeps forbidden-path changes on the high-risk cap unless overridden.
- [x] `scope-check` permits committed visual proof under `docs/assets/<branch-slug>/`.
- [x] Policy checks fail missing UI proof, missing domain tests, environment file changes, and forbidden executable command patterns before review.
- [x] Reviewer guidance no longer requires the first commit to echo acceptance criteria.
- [x] Agent and PR documentation describe the same risk-tier workflow.

## Test plan

```
npm run check
npm run test:unit
node scripts/check-plan.mjs --mode=present
node scripts/check-plan.mjs --mode=scope
node scripts/check-plan.mjs --mode=size
node scripts/check-plan.mjs --mode=policy
```

## Rollback

This is a process and CI-policy change only. Revert the PR to restore the prior fixed-size review process and old documentation.

## Labels this PR needs

- `forbidden-path-approved` — touches `.github/workflows/ci.yml` to run the new policy checks inside an existing required job.
