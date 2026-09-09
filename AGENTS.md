# Corgtex delivery guide

Build substantive, cohesive outcomes. Complete a useful feature or workflow in one
PR, including its integration and QA. Optimize for delivered value and elapsed time;
accept manageable, reversible risk and ordinary follow-up fixes.

## Own delivery

- One GPT-6 Astra owner plans, builds, integrates, fixes, and delivers the outcome.
  Make reasonable assumptions and act autonomously within the user's intent.
- Keep related work together. Split only when separate releases have a concrete
  operational benefit; file count, diff size, and internal stages are not reasons.
  Do not expand the requested outcome into unrelated work.
- Start new work in a clean branch/worktree from current `origin/main`. Preserve
  unrelated edits. Continue an existing task branch when that is the user's intent.
- Use a short PR description: outcome, acceptance, validation, and relevant risk.
  Scope is the intended behavior, not a file allowlist. Update the description to
  reflect what was built; no separate plan document or planner handoff is required.
- Use planning help only when it resolves a consequential uncertainty. Ordinary
  errors are part of implementation, not a reason for mandatory replanning or approval.
- Continue corrections while they produce progress. If the same approach fails
  without new evidence, change approach or seek focused help. Report a concrete
  blocker when an external dependency or user decision prevents further progress.
  Do not repeat unchanged checks, status polls, handoffs, or speculative hardening.
- Once acceptance, QA, and required CI pass, deliver through the normal merge queue.
  Do not ask again for routine edits, commits, pushes, PR updates, fixes, or merge.
  Ask only for new scope or authority: access changes, paid spend, external messages,
  unapproved irreversible production/data operations, or protection bypass.

## Build, then independent QA

- After the integrated outcome is ready, a separate GPT-6 agent reviews the complete
  diff and acceptance evidence, exercises relevant behavior, and reports concrete
  blockers together. The owner fixes them in the same PR.
- QA focuses on correctness, usability, integration, and realistic security/data
  risks. Accept minor imperfections; do not block on taste, speculative edge cases,
  diff size, or paperwork wording. Recheck affected behavior after fixes and reuse
  unchanged evidence. QA may also perform protected review using the reviewer identity.
- Run focused tests during development. Add tests for meaningful uncovered behavior
  or regressions; existing coverage can be sufficient. A source edit does not require
  a matching test-file edit. Do not test trivial changes just to satisfy a checklist.
- Validate the integrated result once with applicable broader checks. Reuse hosted
  CI instead of duplicating it locally where it covers the same behavior. All required
  GitHub checks still apply. Expand checks only for new code, failures, or a specific
  unresolved concern. For incidents, reproduce the observed failing boundary early.
- Visible UI changes need evidence from the running application. API-only changes,
  tests, and nonvisual refactors do not need screenshots. QA judges proof adequacy.
  Keep captures in ignored `.artifacts/`; use `scripts/upload-build-artifacts.mjs` or
  CI artifacts, with private links for private content. Never commit generated proof.

## Commands and code map

- Dev: `npm run dev`; static checks: `npm run check`; unit: `npm run test:unit`.
- Integration: `npm run test:integration`; build: `env -u DATABASE_URL npm run build`.
- Policy/docs changes: relevant script tests, `node scripts/check-public-docs.mjs`,
  and `node scripts/check-private-boundary.mjs`; no local application build needed.
- `apps/web/`: Next.js App Router UI/routes; `apps/worker/`: background processing.
  `packages/domain/`: business logic; `shared/`: env/db/types; `workflows/`: jobs;
  `knowledge/`: retrieval; `models/`: gateways; `agents/`: agent execution.
- Follow existing TypeScript, shared UI primitives, and tokenized styles. Use type
  imports, double quotes, semicolons, two-space indentation, and no emoji UI icons.
  Route handlers convert domain `AppError` with `handleRouteError()`.
- Optional helpers follow the global model routing; use them when they save time
  or add useful judgment. The owner integrates their output.

## Product and authority boundaries

- Authenticate webhook origins before writes. Workspace mutations require membership
  authorization; login alone is insufficient. Preserve tenant isolation.
- Cross-app routes use `OPTIONS` and CORS scoped to `NEXT_PUBLIC_SITE_URL`.
- Never expose or commit secrets, `.env` files, or private/client content. `docs/` is
  public documentation; keep private material and generated artifacts out of Git.
- Schema changes include migrations validated against a database. Never use
  `prisma db push`; do not run migrations when schema/migrations did not change.
  Builds stay database-independent. Preserve required `force-dynamic` boundaries.
  Startup migrations remain in `deploy/entrypoint.sh`.
- Before an authorized destructive action, verify its actual target and the relevant
  recovery/preconditions once. Production writes use the existing single-writer and
  release mechanisms; an instruction to implement is not a data-deletion permission.
- Claim a release only after the intended runtime/version and relevant smoke pass.
  Observation depth follows risk. Use existing rollback/recovery paths on failure.

## GitHub delivery

- Builder: `Corgtex-builder` via `$HOME/.config/gh-corgtex-builder`.
  Independent reviewer: `beepto-codex` via `$HOME/.config/gh-codex-reviewer`.
  Verify `api user --jq .login` immediately before each GitHub write.
- The owner never self-approves. The reviewer does not edit, push, or merge.
  Native approval, required checks, conversation resolution, and merge queue govern
  delivery. Never push directly to `main`, skip hooks, or bypass protection without
  an explicit instruction for that operation.
- Risk tiers (`low`, `standard`, `high`, `critical`) guide QA depth, not PR size.
  Auth, migrations, deploy, and agent/CI policy are `critical`; state the reason in
  Scope. The executable protected-path list lives in `scripts/check-plan.mjs`.
- Mutable PR metadata is validated automatically. Review approvals need no custom
  attestation; valid metadata edits alone do not require another full code review.
  New code requires review of the changes and integration; reuse unaffected findings.

See `.codex/review.md` for QA/review and `.github/pull_request_template.md` for the
short PR form. GitHub setup details live in `.codex/ops/github-setup.md`.
