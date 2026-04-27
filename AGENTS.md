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
- **Integration tests:** `npm run test:integration` (starts `docker-compose.test.yml`, runs the Vitest `integration` project, tears it down) | **All tests:** `npm run test:all`
- **E2E agent flow:** `npm run prisma:seed`, `npm run seed:e2e`, set `AGENT_API_KEY`, run `npm run dev`, then use the Agent API flow below.
- **Prisma / seeds:** `npm run prisma:generate` (required before tests), `npm run prisma:migrate`, `npm run prisma:migrate:deploy`, `npm run prisma:seed`, `npm run seed:e2e`, `npm run seed:pilot-tester`, `npm run seed:demo`, `npm run seed:jnj-demo`

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
- **Icons:** Never use emoji characters (🌙, 🤖, 💾, etc.) in UI code. Use monochrome Unicode glyphs consistent with `apps/web/lib/nav-config.ts`. The ESLint `no-restricted-syntax` rule enforces this.
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
- Production bootstrap seed: `npm run prisma:seed` provisions the configured workspace/admin/system baseline only. It does not create demo, JNJ, or E2E fixture users.
- E2E UI credentials: read `AGENT_E2E_EMAIL` and `AGENT_E2E_PASSWORD` from the local `.env`. Defaults are `system+corgtex@corgtex.local` / `corgtex-test-agent-pw` if unset. Run `npm run seed:e2e` after `npm run prisma:seed` to provision the E2E UI user.
- Agent API (E2E backend testing): set `AGENT_API_KEY` in `.env`. Use header `Authorization: Bearer agent-<AGENT_API_KEY>` against `http://localhost:3000`. `AGENT_API_KEY` is runtime auth config, not startup seed data. The bootstrap agent has ADMIN-equivalent access to allowed workspaces; wallet-dependent flows need extra setup.

### Public docs hygiene

- `docs/` is only for public documentation-site files. Do not commit private/client/partner notes, handoff docs, agent plans, Slack manifests, screenshots, recordings, or generated QA output under `docs/`.
- Generated proof belongs in PR attachments, CI artifacts, private artifact links, or ignored local `.artifacts/` output.
- Local pre-PR plan drafts belong under ignored `.agents/plans/`; the reviewed plan contract lives in the PR body and remains visible as GitHub PR metadata.
- PR-body plans must be public-safe. Do not include private keys, API tokens, passwords, raw credentials, secret values, or customer-private facts. `scripts/check-plan.mjs` blocks obvious credential patterns in PR-body plans, but agents are still responsible for keeping plan prose sanitized.

---

## For Planners (Claude)

Your job is to produce a PR-body plan contract and nothing else. Do not write
implementation code.

1. Create a new branch: `git checkout -b <type>/<short-slug>` (e.g. `feat/optimistic-finance`, `fix/login-crash`).
2. Copy [.agents/plan-template.md](.agents/plan-template.md) into the draft PR body. For local checks before a PR exists, copy it to `.agents/plans/<branch>.md`; that directory is ignored and must not be committed.
3. Fill every section, including **Risk tier** (`low`, `standard`, or `high`). The **Files to touch** section is a hard allowlist — the Executor cannot modify files outside it without first updating the PR body plan.
4. Pick the smallest honest risk tier:
   - `low`: docs, copy, styles, or tightly scoped non-security changes. Cap: ≤ 1200 non-doc LOC and ≤ 50 files.
   - `standard`: normal product or domain work. Cap: ≤ 800 non-doc LOC and ≤ 25 files.
   - `high`: auth, permissions, migrations, deploy, workflows, security-sensitive logic, or broad shared behavior. Cap: ≤ 400 non-doc LOC and ≤ 15 files.
5. If the plan touches forbidden paths (`deploy/**`, `.github/workflows/**`, `prisma/migrations/**`, `packages/domain/src/auth*.ts`, `apps/web/lib/auth.ts`), state the justification in the plan and note that the PR will need the `forbidden-path-approved` label.
6. Push the branch and open a **draft** PR whose body is the completed public-safe plan. Do not commit local plan files. Do not mark ready-for-review.

Stop there. Hand off to the Executor.

---

## For Executors (Gemini in Antigravity)

Your job is to implement the plan. You do not plan, and you do not
merge.

1. **First action:** Verify your branch state (`git branch --show-current`) before working. Multiple agents run simultaneously in this repo. If you are on the wrong branch, checkout or create it (`git checkout -b <branch>`). Once on the correct branch, read the PR body plan. If the PR does not exist yet, read `.agents/plans/<branch>.md`.
2. **Stay in scope:** only modify files listed in the plan's "Files to touch" section. If you discover the plan is wrong or incomplete, update the PR body plan before writing code. `scripts/check-plan.mjs` enforces this in CI.
3. **Run the test plan locally** before pushing. Run `npm run check` and whatever the plan's "Test plan" specifies. Wait for it to exit with code `0`. Fix any TypeScript or ESLint errors before proceeding.
4. **Open the PR as ready-for-review** once all acceptance criteria are ticked. Use `gh pr create`. If `gh` isn't on `PATH`, invoke `/opt/homebrew/bin/gh`. The PR body must explicitly include the completed acceptance criteria checklist in Markdown.
5. **Frontend changes:** add actual visual proof links in the PR body's **Visual Proof** section. Use PR attachments, CI-uploaded artifacts, or another private artifact link. Any change under `apps/web/app/**`, `apps/web/components/**`, or `apps/web/lib/components/**` requires proof. **You must run the app locally and capture actual proof of the feature running. Do not submit AI-generated mockups or generic placeholders. Do not commit screenshots, recordings, or generated QA output under `docs/assets/`.**
6. **CI fix loop cap:** if CI is red, you may push up to 3 fix commits. After the 3rd failed attempt, label the PR `needs-replan`, comment a summary, and stop. The human will re-prompt the Planner.
7. **Never (default):** merge your own PR, use `--admin`, skip hooks with `--no-verify`, or run `prisma db push`. Never remove `export const dynamic = "force-dynamic"` from a Prisma-touching page. Never commit `.env` or any secret.
8. **Human-directed bypass:** If the human explicitly instructs you via prompt to force-merge a specific PR, you may: (a) add the `force-merge` label, (b) run `gh pr merge <number> --admin --squash`, (c) add a PR comment: `⚠️ Human-directed bypass: merged with --admin per explicit instruction.` This is the **only** exception to rule 7's ban on `--admin` and self-merging. You must still never skip `--no-verify`, run `prisma db push`, or commit secrets.

Stop when the PR is open and CI is green locally. Hand off to the Reviewer.

---

## For Reviewers (Codex via `beepto-codex`)

Your job is to approve or reject the PR based on mechanical criteria and to flag objective logic or security flaws.
Do not write code. Do not merge if any criterion fails.

**GitHub identity:** The Reviewer runs as [`beepto-codex`](https://github.com/beepto-codex), a dedicated bot account with `write` access to the repository. This is a separate identity from the Executor (`puncar-dev`), which allows the Reviewer to submit formal GitHub approvals on PRs authored by the Executor.

**Authentication:** Codex must be configured with a PAT belonging to `beepto-codex` (stored in the Codex environment, never committed). The PAT needs `repo` scope.

Canonical checklist lives in [.codex/review.md](.codex/review.md).
Summary:

1. **Plan exists** in the PR body.
2. **Scope intact:** all changed files are in the plan's "Files to touch" allowlist (`scripts/check-plan.mjs` enforces).
3. **Acceptance criteria all ticked** and each is reflected in code or CI output.
4. **No forbidden-path changes** without the `forbidden-path-approved` label.
5. **Diff within risk-tier caps** unless `large-change-approved` is set.
6. **No secrets** (gitleaks green), no `prisma db push`, no `--no-verify`, no `force-dynamic` removed from Prisma pages. `--admin` is forbidden unless the `force-merge` label is present and the PR comment trail documents the human directive.
7. **Tests added** when `packages/domain/**` changed.
8. **PR-body visual proof present** for any frontend-path change.
9. **All required CI checks green.**
10. **No objective logic flaws** (e.g., race conditions, unhandled rejections, security vulnerabilities).

If all pass, approve the PR using `gh pr review <number> --approve`. You may leave non-blocking advisory comments for stylistic or minor architectural improvements, but they must not block approval. Auto-merge (set by the Executor via `gh pr merge --auto --squash`) will fire once the approval lands. If any fail, request changes with a comment pointing to the specific criterion; do not approve partially.

---

## Human override

The human prompter can intervene at any time using PR labels:

- `halt-agents` — Reviewer will not merge; Executor will not push further commits.
- `force-merge` — human override. Logged in the PR and in the daily digest. When applied by an agent acting on explicit human instruction, the agent must add a PR comment documenting the directive and may use `--admin` to merge.
- `needs-replan` — Executor sets this when stuck; Planner picks up.

### Human-directed agent bypass

When a human explicitly instructs an agent (via prompt) to force-merge a PR:

1. The agent adds the `force-merge` label to the PR.
2. The agent adds a PR comment: `⚠️ Human-directed bypass: merged with --admin per explicit instruction.`
3. The agent runs `gh pr merge <number> --admin --squash`.
4. This is logged in the daily digest alongside all other `force-merge` events.

**Scope:** This bypass covers branch protection (required reviews, status checks). It does **not** exempt the PR from secret scanning, `prisma db push` bans, or `--no-verify`.
