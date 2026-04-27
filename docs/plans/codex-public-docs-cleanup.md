# Plan: Public docs cleanup and forward rules

## Goal

Keep the public repository's `docs/` tree limited to public documentation-site content, remove tracked internal docs and generated proof artifacts, and keep future agent plans/proof artifacts in PR metadata or CI artifacts instead of committed public files.

This branch includes this one committed plan file as a transitional exception because the active reviewer rules on `main` still require `docs/plans/<branch>.md` until this PR merges. After this PR lands, future plans should live in the PR body and ignored local `.agents/plans/<branch>.md` drafts, not in committed `docs/plans/` files.

## Risk tier

- high

## Out of scope

- Running the public history rewrite or force-pushing rewritten branches/tags.
- Rotating any secrets; no confirmed real secret is changed here.
- Relocating removed private/client/partner documents elsewhere inside this public repo.
- Changing product behavior outside docs governance, proof output paths, and example placeholder values.

## Files to touch

- `.agents/**`
- `.codex/**`
- `.github/**`
- `.gitignore`
- `AGENTS.md`
- `CONTRIBUTING.md`
- `docker-compose.selfhost.yml`
- `docs/**`
- `package.json`
- `scripts/**`

## Walkthrough

Remove tracked private/internal docs, agent plans, screenshots, recordings, PR assets, handoff notes, and generated QA artifacts from `docs/`. Replace the committed plan/proof contract with PR-body plans and PR/CI artifact proof for future work, add a public-docs guard, move local generated outputs to `.artifacts/`, document the separate coordinated history purge procedure, and add a PR-body plan guard that blocks obvious credential material before the plan checks pass.

## Acceptance criteria

- [x] `docs/` contains only the public docs-site allowlist plus this transitional `docs/plans/codex-public-docs-cleanup.md` plan required by the active reviewer rules.
- [x] Tracked historical `docs/assets/**`, `docs/pr-assets/**`, `docs/plans/**`, client readiness docs, handoff docs, pilot docs, industrial handoff docs, and Slack manifest docs are removed from the branch, except for this branch's transitional plan file.
- [x] `.gitignore` blocks private docs, generated proof artifacts, local plan drafts, and `.artifacts/` output going forward.
- [x] PR-body plans remain the normal agent handoff artifact in GitHub after this PR merges, while committed plan files are removed from the public repo workflow.
- [x] Plan policy docs state that PR-body plans must be public-safe and must not contain credentials, private keys, raw secrets, or customer-private material.
- [x] `scripts/check-plan.mjs` reads the plan contract from the PR body in CI, with ignored `.agents/plans/<branch>.md` local fallback.
- [x] `scripts/check-plan.mjs` rejects obvious credential material in PR-body plans, including private key blocks and common token formats.
- [x] `.agents/plan-template.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.codex/review.md`, public contributing docs, and the PR template describe the PR-body plan/proof contract.
- [x] UI proof policy requires a non-empty PR-body **Visual Proof** section for UI path changes and no longer permits committed `docs/assets/` proof.
- [x] Smoke/client readiness output defaults and client smoke package scripts write to `.artifacts/` instead of `docs/assets/`.
- [x] Public docs examples use explicit placeholder values instead of real-looking API keys or passwords.
- [x] `scripts/check-public-docs.mjs` and the Docs Validation CI job fail if tracked `docs/` content falls outside the public docs allowlist and the transitional plan exception.
- [x] `.agents/history-purge-runbook.md` documents the coordinated `git-filter-repo` history purge, verification, force-push, collaborator reset, and GitHub cache/support steps.

## Test plan

```bash
node scripts/check-public-docs.mjs
git check-ignore -v docs/partner-analysis/test.md docs/assets/test.png docs/pilot-testing.md docs/industrial-vilassarenca-eu-handover.md .artifacts/test.png .agents/plans/codex-public-docs-cleanup.md
PR_BODY=<sample public-safe plan body> PR_LABELS=forbidden-path-approved,large-change-approved node scripts/check-plan.mjs --mode=present
PR_BODY=<sample public-safe plan body> PR_LABELS=forbidden-path-approved,large-change-approved node scripts/check-plan.mjs --mode=scope
PR_BODY=<sample public-safe plan body> PR_LABELS=forbidden-path-approved,large-change-approved node scripts/check-plan.mjs --mode=policy
PR_BODY=<sample public-safe plan body> PR_LABELS=forbidden-path-approved,large-change-approved node scripts/check-plan.mjs --mode=size
PR_BODY=<sample plan body containing a fake common-token pattern> node scripts/check-plan.mjs --mode=present # expected failure
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/corgtex_test?schema=public" npm run check
npx mint validate
npx mint broken-links
git diff --check origin/main...HEAD
```

## Visual proof

Not applicable; this PR does not change frontend UI paths.

## Rollback

Revert the PR to restore the previous committed docs/plans/proof-artifact workflow. Do not run the history purge runbook until this PR has merged and the team has explicitly frozen merges, made a private mirror backup, and accepted the force-push coordination plan.
