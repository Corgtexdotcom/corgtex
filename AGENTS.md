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
6. **Stop loops early.** After the first unsuccessful correction cycle, stop
   editing and reassess with the read-only GPT-6 planner. After the second
   unsuccessful cycle, or before adding additional implementation PRs, get explicit
   user approval. A cycle is a bounded corrective change followed by relevant
   validation, not an individual tool call or a wait for infrastructure.

## Model routing and delegation

- GPT-6 Astra (`gpt-6-astra`) is the default delivery owner and model for Codex
  planning, execution, subagents, and review. Preserve configured reasoning.
  Protected review uses a separate identity and a fresh assessment of the complete
  current diff; the delivery owner never approves its own work.
- Routine settled work stays with the delivery owner without a separate planning
  handoff. Use the read-only GPT-6 `sol_planner` agent (legacy name) for material
  ambiguity, cross-cutting architecture, security/privacy/auth, tenant isolation,
  migrations, production risk, or a failed correction cycle. It returns a compact
  contract covering outcome, non-goals, surfaces, behavior, acceptance, tests,
  risks, rollback, and stop conditions. It does not edit or perform delivery.
- Optional external helpers are authorized within these lanes without a separate
  request for each call. Delegate when the benefit exceeds setup and verification
  cost; keep trivial or tightly coupled work in GPT-6. Announce the bounded purpose
  and use the corresponding CLI skill for authentication and model preflight.
- **Composer 2.5** (`composer-2.5`): boilerplate, scaffolding, fixtures, repetitive
  edits, and mechanical refactors following established patterns.
- **Gemini 3.8 Flash** (`gemini-3.8-flash-medium` through `agy`): bounded small
  features, tests, refactors, and deterministic build fixes with settled behavior.
  Do not use Gemini Pro or silently substitute another Gemini model.
- **Claude Opus** (`opus` through the Claude CLI): bounded read-only advice on a
  concrete plan, decision, or diff. Advisory output is not protected review.
- External helpers use subscription CLIs and the skill's privacy checks, with no
  secrets, private/client data, paid overages, or external writes. Editing workers
  receive bounded files/tests and sole edit ownership in a clean isolated worktree.
  They never commit, push, review, merge, or deploy. GPT-6 inspects the complete
  output and runs relevant validation before integrating it.
- If an optional helper is unavailable, report why and continue in GPT-6. If the
  user mandates a model, stop that delegation on model, identity, access, quota,
  or billing failure. Follow current task-specific model instructions; model
  selection never grants additional data, spend, merge, or production authority.

## Risk and review

Use the smallest honest tier; tiers change review and evidence depth, not permitted
diff size:

- `low`: docs, copy, styles, or a tightly scoped non-security change.
- `standard`: ordinary product or domain behavior.
- `high`: broad shared behavior, workflows, external effects, or operational risk.
- `critical`: auth, permissions, tenant isolation, secrets, migrations, deploy,
  destructive production data work, or agent/CI protection policy.

Protected paths (`AGENTS.md`, `.agents/plan-template.md`, `.codex/review.md`,
`.codex/ops/**`, `.github/pull_request_template.md`, `.github/workflows/**`,
`scripts/check-plan.mjs`, `scripts/review-snapshot-integrity.mjs`, `deploy/**`, `prisma/migrations/**`,
`packages/domain/src/auth*.ts`, and `apps/web/lib/auth.ts`) require `critical` risk
and an explicit justification in the PR body. They do not require a size exception
or special label.

The independent reviewer reads the complete current diff and blocks only objective
correctness, security, privacy/data, acceptance, test, proof, or CI failures. Do not
block on taste, speculative architecture, plan wording, or size alone. A push or
base change invalidates prior approval; native GitHub rules provide the exact-head
approval, thread-resolution, required-check, and merge-queue boundary. A trusted
metadata workflow publishes the distinct `PR Metadata Policy` context for head,
PR-body, label, draft-state, and merge-group changes without rerunning expensive
code checks, and removes an invalid PR from the queue. Keep the legacy Review
Snapshot Integrity gate until both replacement contexts are live and proven; its
removal is a later protected cleanup, not part of the activation merge.

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

Choose local validation for the changed behavior: prose-only work uses the relevant
documentation and policy validators, not an application build or new unit tests.
Code changes use focused regression tests plus the applicable static, integration
and build checks. The PR contract names the commands and why they are sufficient;
all required hosted CI and independent exact-head review still apply.

## Execution and completion

- Define the acceptance evidence and completion condition before substantial work.
  Once they and required checks pass, finish delivery. Record optional polish
  separately rather than extending the current task.
- Each discretionary check answers an unresolved question. Reuse evidence only
  while relevant code, dependencies, configuration, images and tested assumptions
  remain unchanged. Metadata-only edits do not require another local code suite.
  Refresh the live target, writer/lease and authorization before relevant mutations.
- For an observed runtime/provider failure, reproduce the failing boundary early
  with the actual candidate image and sanitized configuration or representative
  existing fixtures. Test the producer/consumer interaction and applicable failure
  path before another live attempt; passing unrelated unit tests is not that proof.
  Use existing test and artifact paths rather than creating a new framework.
- Retain a bounded sanitized failure receipt through the existing diagnostic path:
  failed stage/code, relevant non-secret identity and the original cause when safe.
  Never emit credentials or raw client content. Record missing evidence explicitly.
- Keep one current checkpoint with the working outcome, missing acceptance, exact
  blocker and next action. Older snapshots remain historical, not competing current
  instructions. During waits, continue independent authorized work and use bounded
  backoff rather than repeated unchanged checks or duplicate handoffs.

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
