# AGENTS.md

This file is loaded by every AI coding agent that works on this repo
(Claude Code, Antigravity with Claude or Gemini, Codex). It is the
single source of truth for how agents collaborate on Corgtex.

Corgtex uses a fully autonomous three-agent pipeline:

- **Planner** (Claude) writes plans.
- **Executor** (Gemini in Antigravity) implements and opens the PR.
- **Reviewer** (Codex) approves or rejects the PR.

A human prompts each stage and can intervene via labels. No human
reviews code line-by-line. The full specification lives in
[docs/contributing/agent-pipeline.mdx](docs/contributing/agent-pipeline.mdx).

---

## Shared context (all agents read this)

### Build, test, check

- **Dev server:** `npm run dev` | **Build:** `npm run build` | **Lint:** `npm run lint` | **Typecheck:** `npm run typecheck`
- **All static checks:** `npm run check` (lint + typecheck + prisma validate)
- **Unit tests:** `npm test` or `npm run test:unit` | **Single test:** `npx vitest run packages/domain/src/runtime.test.ts`
- **Integration / E2E:** no dedicated `npm run test:integration` script exists today. For end-to-end coverage, run the app locally with `npm run dev` and use the agent API flow above. `docker-compose.yml` is available for local services, but there is no separate `docker-compose.test.yml`.
- **Prisma:** `npm run prisma:generate` (required before tests), `npm run prisma:migrate`, `npm run prisma:migrate:deploy`

### Architecture

- **Framework:** Next.js 15 (App Router) + React 19 + TypeScript (strict) + Tailwind CSS 3
- **Runtime split:** `apps/web/` serves the UI and route handlers; `apps/worker/` runs the outbox / workflow worker loop
- **Packages:** `packages/domain/` for business logic, `packages/shared/` for env/db/types, `packages/workflows/` for event/job orchestration, `packages/knowledge/` for retrieval, `packages/models/` for model gateways, `packages/agents/` for agent execution
- **Database:** PostgreSQL via Prisma ORM (`prisma/schema.prisma`)
- **Auth:** session-cookie auth and agent bearer auth resolved in [apps/web/lib/auth.ts](apps/web/lib/auth.ts); workspace/agent authorization in [packages/domain/src/auth.ts](packages/domain/src/auth.ts) and [packages/domain/src/agent-auth.ts](packages/domain/src/agent-auth.ts)
- **API routes:** `apps/web/app/api/**` use `NextResponse.json`; convert domain `AppError`s with `handleRouteError()` from [apps/web/lib/http.ts](apps/web/lib/http.ts)

### Code style

- **Imports:** `@/*` for `apps/web` modules; `@corgtex/*` for shared package entrypoints. Use `import type { X }` for type-only imports.
- **Formatting:** double quotes, semicolons, 2-space indent.
- **Naming:** camelCase (variables/functions), PascalCase (types/components), UPPER_SNAKE (constants/enums).
- **No `.js`:** `allowJs: false`.
- **Errors:** throw `AppError(status, code, message)` from domain logic; convert in route handlers with `handleRouteError()`.
- **DB:** monetary values as `*Cents: Int`. UUIDs for all IDs. Use Prisma compound unique keys for lookups.

### Prisma workflow rules

- **Schema changes:** if you change `prisma/schema.prisma`, run `npm run prisma:migrate -- --name <descriptive_name>` and commit the generated migration.
- **Migration changes:** if you change `prisma/migrations/**`, validate against a database before finishing. Never use `prisma db push` to apply schema changes.
- **No Prisma diff, no Prisma commands:** if neither `prisma/schema.prisma` nor `prisma/migrations/**` changed, do not run Prisma migration commands.
- **Build contract:** `npm run build` must stay database-independent. Never hide schema mutation inside generic build scripts.
- **Forbidden contexts for `db push`:** never in CI, Dockerfiles, production deploy flows, or routine agent work.

### Next.js build guardrails

- All Prisma-dependent App Router pages, layouts, and `generateMetadata()` functions that are not already request-bound (via `cookies()`, `headers()`, auth, or a route handler) MUST export `const dynamic = "force-dynamic"`.
- Build-time database fallbacks are not an acceptable substitute. The web build must succeed without `DATABASE_URL`.

### Deployment invariants

- Migrations apply automatically at container startup via `deploy/entrypoint.sh`.
- Railway's `preDeployCommand` is unreliable with `builder = "DOCKERFILE"`. Rely on `entrypoint.sh`.
- Any PR merged to `main` must pass the post-deploy smoke routine; if it fails, `.github/workflows/auto-revert.yml` opens a revert PR.
- When invoking root-level scripts inside the production Docker container, always use absolute paths: `node /app/scripts/...`. Never `npm run <script>` — npm resolves the context into the child workspace and crashes.

### Secrets and credentials

- Never hardcode secrets in code, commits, PR descriptions, or agent output.
- E2E credentials: read `AGENT_E2E_EMAIL` and `AGENT_E2E_PASSWORD` from the local `.env`. Defaults are `system+corgtex@corgtex.local` / `corgtex-test-agent-pw` if unset. Run `npm run prisma:seed` to provision the user.
- Agent API (E2E backend testing): set `AGENT_API_KEY` in `.env`, then run `AGENT_API_KEY="..." npm run prisma:seed`. Use header `Authorization: Bearer agent-<AGENT_API_KEY>` against `http://localhost:3000`. The agent user has ADMIN role in the default org; wallet-dependent flows need extra setup.

---

## For Planners (Claude)

Your job is to produce a plan file and nothing else. Do not write
implementation code.

1. Create a new branch: `git checkout -b <type>/<short-slug>` (e.g. `feat/optimistic-finance`, `fix/login-crash`).
2. Copy [docs/plans/_TEMPLATE.md](docs/plans/_TEMPLATE.md) to `docs/plans/<branch>.md`. The filename is the branch name, lowercased, with `/` replaced by `-`.
3. Fill every section. The **Files to touch** section is a hard allowlist — the Executor cannot modify files outside it without first updating this file.
4. Keep the diff small: target ≤ 400 LOC of code changes (docs don't count) and ≤ 15 files. If the work is bigger, split it into multiple plans.
5. If the plan touches forbidden paths (`deploy/**`, `.github/workflows/**`, `prisma/migrations/**`, `packages/domain/src/auth*.ts`, `apps/web/lib/auth.ts`), state the justification in the plan and note that the PR will need the `forbidden-path-approved` label.
6. Commit the plan file on the branch, push, and open a **draft** PR whose body is the contents of the plan file. Do not mark ready-for-review.

Stop there. Hand off to the Executor.

---

## For Executors (Gemini in Antigravity)

Your job is to implement the plan. You do not plan, and you do not
merge.

1. **First action:** `cat docs/plans/<branch>.md`. Echo the Acceptance criteria checklist into your first commit message so the Reviewer can diff intent vs. outcome.
2. **Stay in scope:** only modify files listed in the plan's "Files to touch" section. If you discover the plan is wrong or incomplete, commit an update to the plan file first (separate commit), then write code. `scripts/check-plan.mjs` enforces this in CI.
3. **Run the test plan locally** before pushing. Run `npm run check` and whatever the plan's "Test plan" specifies.
4. **Open the PR as ready-for-review** once all acceptance criteria are ticked. Use `gh pr create`. If `gh` isn't on `PATH`, invoke `/opt/homebrew/bin/gh`. The PR body must link back to `docs/plans/<branch>.md`.
5. **Frontend changes:** attach a screen recording (`.mp4` / `.webm`) or screenshots (`.png`) to the PR description. Any change under `apps/web/app/**` or `apps/web/components/**` requires visual proof.
6. **CI fix loop cap:** if CI is red, you may push up to 3 fix commits. After the 3rd failed attempt, label the PR `needs-replan`, comment a summary, and stop. The human will re-prompt the Planner.
7. **Never:** merge your own PR, use `--admin`, skip hooks with `--no-verify`, or run `prisma db push`. Never remove `export const dynamic = "force-dynamic"` from a Prisma-touching page. Never commit `.env` or any secret.

Stop when the PR is open and CI is green. Hand off to the Reviewer.

---

## For Reviewers (Codex)

Your job is to approve or reject the PR based on mechanical criteria.
Do not write code. Do not merge if any criterion fails.

Canonical checklist lives in [.codex/review.md](.codex/review.md).
Summary:

1. **Plan exists** at `docs/plans/<branch>.md` and is linked from the PR body.
2. **Scope intact:** all changed files are in the plan's "Files to touch" allowlist (`scripts/check-plan.mjs` enforces).
3. **Acceptance criteria all ticked** and each is reflected in code or CI output.
4. **No forbidden-path changes** without the `forbidden-path-approved` label.
5. **Diff within caps** (≤ 400 LOC of code, ≤ 15 files) unless `large-change-approved` is set.
6. **No secrets** (gitleaks green), no `prisma db push`, no `--no-verify`, no `--admin`, no `force-dynamic` removed from Prisma pages.
7. **Tests added** when `packages/domain/**` changed.
8. **Visual proof attached** for any frontend-path change.
9. **All required CI checks green.**

If all pass, approve the PR. Auto-merge (set by the Executor via `gh pr merge --auto --squash`) will fire. If any fail, request changes with a comment pointing to the specific criterion; do not approve partially.

---

## Human override

The human prompter can intervene at any time using PR labels:

- `halt-agents` — Reviewer will not merge; Executor will not push further commits.
- `force-merge` — human override. Logged in the PR and in the daily digest.
- `needs-replan` — Executor sets this when stuck; Planner picks up.
