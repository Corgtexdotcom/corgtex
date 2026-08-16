# Corgtex agent guide

This file is the repository source of truth for delivery. Use it with the global
agent policy. Product invariants below are mandatory; process should stay as light
as the risk permits.

## Delivery model

1. **Own the outcome.** One delivery owner may plan, implement, test, publish, and
   fix the task. Use a separate identity for protected review.
2. **Start clean.** New work uses a fresh task branch/worktree from current
   `origin/main`. Never reset, stash, overwrite, or mix unrelated work. Continue an
   existing branch/PR only when the user names that work.
3. **Prefer one coherent PR.** Split only when every part is independently useful,
   safe, testable, deployable, and rollbackable. Diff size alone never forces a
   split. Do not land unused APIs or partial safety contracts.
4. **Use one proportional contract.** The PR body records outcome, risk, file scope,
   acceptance, tests, proof where relevant, and rollback. Update it when the actual
   scope changes; do not create a separate planner handoff by default.
5. **Act autonomously inside scope.** Routine edits, tests, commits, pushes, and PR
   updates do not need repeated approval. Ask before material scope expansion,
   unapproved irreversible production/customer-data operations, paid spend,
   external communication, or protection bypass.
6. **Stop loops early.** After two unsuccessful correction cycles, reassess and
   report the evidence. A second replan or more implementation PRs needs explicit
   user approval.

## Risk and review

Use the smallest honest tier; tiers change review and evidence depth, not permitted
diff size:

- `low`: docs, copy, styles, or a tightly scoped non-security change.
- `standard`: ordinary product or domain behavior.
- `high`: broad shared behavior, workflows, external effects, or operational risk.
- `critical`: auth, permissions, tenant isolation, secrets, migrations, deploy,
  destructive production data work, or agent/CI protection policy.

Protected paths (`deploy/**`, `.github/workflows/**`, `prisma/migrations/**`,
`packages/domain/src/auth*.ts`, `apps/web/lib/auth.ts`) require `critical` risk and
an explicit justification in the PR body. They do not require a size exception or
special label.

The independent reviewer reads the complete current diff and blocks only objective
correctness, security, privacy/data, acceptance, test, proof, or CI failures. Do not
block on taste, speculative architecture, plan wording, or size alone. A push or
base change invalidates prior approval; native GitHub rules provide the exact-head
approval, thread-resolution, required-check, and merge-queue boundary.

## Build and test

- Dev: `npm run dev`
- Static checks: `npm run check` (lint, typecheck, Prisma validate)
- Unit tests: `npm test` or `npm run test:unit`
- Integration: `npm run test:integration`; all tests: `npm run test:all`
- Build: `env -u DATABASE_URL npm run build`
- Prisma generation: `npm run prisma:generate`

Run targeted checks while iterating, then the PR's required broad checks once the
diff is stable. Domain source changes under `packages/domain/**` need corresponding
same-package `*.test.ts` coverage. Do not rerun expensive unchanged evidence.

## Architecture and code

- Next.js 15 App Router, React 19, strict TypeScript, Tailwind CSS 3.
- `apps/web/` serves UI/routes; `apps/worker/` runs outbox/workflow processing.
- Business logic belongs in `packages/domain/`; shared env/db/types in
  `packages/shared/`; orchestration in `packages/workflows/`; retrieval in
  `packages/knowledge/`; model gateways in `packages/models/`; execution in
  `packages/agents/`.
- Route handlers use `NextResponse.json`; convert `AppError` with
  `handleRouteError()` from `apps/web/lib/http.ts`.
- Imports: `@/*` for web modules and `@corgtex/*` for packages. Use type-only
  imports, double quotes, semicolons, two-space indentation, and no `.js` files.
- Monetary values are integer `*Cents`; IDs are UUIDs; use Prisma compound unique
  keys for compound lookups.
- UI uses shared workspace primitives and tokenized `nr-*` classes. Improve the
  shared spine when that produces a better user result; avoid page-local control
  families and emoji icons.

## Security and data invariants

- Every webhook under `apps/web/app/api/webhooks/**` authenticates its origin before
  mutation by signature, secret, or bearer token.
- Every workspace-scoped mutating server action verifies workspace membership;
  login alone is not authorization.
- Cross-app routes implement `OPTIONS` and allow only `NEXT_PUBLIC_SITE_URL`, never
  wildcard CORS.
- Never hardcode, print, commit, or place in PR metadata any secret, credential, raw
  private/client content, or `.env` file.
- An authorized exact-target deletion still requires fresh target identity, zero-data
  or stated precondition checks, cross-tenant checks, and the smallest available
  dry-run/backup/rollback mechanism. Do not repeat the approval unless scope changes.

## Prisma and build invariants

- Schema changes use `npm run prisma:migrate -- --name <name>` and commit the
  migration. Validate changed migrations against a database.
- Never use `prisma db push` in agent work, CI, Dockerfiles, or deploy flows. Run no
  migration command when schema and migrations did not change.
- Builds must remain database-independent. Prisma-dependent App Router pages,
  layouts, and metadata functions that are not already request-bound export
  `const dynamic = "force-dynamic"`.
- Migrations apply at container startup through `deploy/entrypoint.sh`; do not move
  them into generic build steps. Inside production containers invoke root scripts
  with absolute paths such as `node /app/scripts/...`.

## Evidence, demos, and release

- Frontend changes under `apps/web/app/**`, `apps/web/components/**`, or
  `apps/web/lib/components/**` need actual running visual proof. Store captures in
  ignored `.artifacts/` and upload through `scripts/upload-build-artifacts.mjs`;
  never commit generated proof.
- For customer-visible changes, update `scripts/seed-jnj-demo.mjs` when safe seeded
  state is needed or explain why public demo exposure is unsafe or inapplicable.
- `docs/` is public documentation only. Keep client/partner notes, handoffs, plans,
  screenshots, recordings, Slack manifests, and generated QA outside Git history.
- A merge is not a release claim. Required proof is current-main CI, deployment,
  serving SHA/no drift, named smoke, observation where risk warrants it, and rollback
  readiness. If production remains red, use the protected auto-revert path; if it
  recovered on the same SHA, rerun the trusted production smoke before rollback.

## GitHub roles

- Builder: `Corgtex-builder` using `$HOME/.config/gh-corgtex-builder`.
- Reviewer: `beepto-codex` using `$HOME/.config/gh-codex-reviewer`.
- Verify `api user --jq .login` immediately before every GitHub write. The builder
  never approves its own PR; the reviewer never edits, fixes, pushes, or merges.
- Never push directly to `main`, use `--no-verify`, or bypass protection unless the
  user explicitly directs a specific emergency bypass. Record any bypass publicly.

See `.agents/plan-template.md`, `.codex/review.md`, and
`docs/contributing/agent-pipeline.mdx` for the short operational forms.
