# AGENTS.md

## Agent API Access (E2E Testing)

When `AGENT_API_KEY` is set in `.env`, the agent can authenticate to the API for end-to-end testing:

- **Header:** `Authorization: Bearer agent-<AGENT_API_KEY>`
- **Base URL:** `http://localhost:3000` (or `NEXT_PUBLIC_APP_URL`)

**Setup:**
1. Add `AGENT_API_KEY="your-secret-key"` to `.env` (never commit)
2. Run `AGENT_API_KEY="your-secret-key" npm run prisma:seed` to create the agent user
3. Use the header above when making API requests

The agent user has ADMIN role in the default org. Wallet-dependent flows (e.g. voting) require additional setup.

## Frontend Browser Access (E2E UI Testing)

When spinning up a browser subagent for end-to-end testing, **NEVER hardcode testing passwords or credentials directly in your prompts or output.**

Instead, ALWAYS securely retrieve the credentials from the local `.env` file first:
- Read `AGENT_E2E_EMAIL`
- Read `AGENT_E2E_PASSWORD`

Pass these retrieved string values directly into the browser subagent's task description parameter.

*Note: For testing against local development instances, the default seed is `system+corgtex@corgtex.local`. For testing against the production `app.corgtex.com` dashboard, use the credentials as they exist in your `.env`.*

## Build & Test Commands
- **Dev server:** `npm run dev` | **Build:** `npm run build` | **Lint:** `npm run lint` | **Typecheck:** `npm run typecheck`
- **All checks:** `npm run check` (lint + typecheck + prisma validate)
- **Unit tests:** `npm test` or `npm run test:unit` | **Single test:** `npx vitest run packages/domain/src/runtime.test.ts`
- **Integration / E2E:** no dedicated `npm run test:integration` script exists today. For end-to-end coverage, run the app locally with `npm run dev` and use the agent API flow above. `docker-compose.yml` is available for local services, but there is no separate `docker-compose.test.yml`.
- **Prisma:** `npm run prisma:generate` (required before tests), `npm run prisma:migrate`, `npm run prisma:migrate:deploy`

## Prisma Workflow Rules
- **Schema changes:** If you change `prisma/schema.prisma`, proactively run `npm run prisma:migrate -- --name <descriptive_name>` and commit the generated migration.
- **Migration changes:** If you change `prisma/migrations/**`, validate the migration path against a database before finishing, but do not create or apply schema changes with `prisma db push`.
- **No Prisma diff, no Prisma commands:** If neither `prisma/schema.prisma` nor `prisma/migrations/**` changed, do not run Prisma migration commands.
- **Build contract:** `npm run build` must stay database-independent. Never hide schema mutation inside generic scripts like `npm run build`.
- **Forbidden contexts for `db push`:** Never use `prisma db push` in CI, Dockerfiles, production deploy flows, or as part of routine agent work in this repo.

## Next.js Build Guardrails
- If a page, layout, or `generateMetadata()` touches Prisma and is not already request-bound through `cookies()`, `headers()`, auth, or a route handler, make it runtime-only before merging.
- Preferred fix: add explicit runtime-only behavior such as `export const dynamic = "force-dynamic"` when appropriate.
- Build-time database fallbacks are not an acceptable substitute. The web build must continue to succeed without `DATABASE_URL`.

## Architecture
- **Framework:** Next.js 15 (App Router) + React 19 + TypeScript (strict) + Tailwind CSS 3
- **Runtime split:** `apps/web/` serves the UI and route handlers; `apps/worker/` runs the outbox / workflow worker loop
- **Packages:** `packages/domain/` for business logic, `packages/shared/` for env/db/types, `packages/workflows/` for event/job orchestration, `packages/knowledge/` for retrieval, `packages/models/` for model gateways, and `packages/agents/` for agent execution
- **Database:** PostgreSQL via Prisma ORM (`prisma/schema.prisma`) covering workspaces, members, circles, proposals, approval flows, finance records, events, workflow jobs, agent runs, and retrieval artifacts
- **Auth:** session-cookie auth and agent bearer auth are resolved in [apps/web/lib/auth.ts](apps/web/lib/auth.ts); workspace/agent authorization lives in [packages/domain/src/auth.ts](packages/domain/src/auth.ts) and [packages/domain/src/agent-auth.ts](packages/domain/src/agent-auth.ts)
- **API routes:** `apps/web/app/api/**` use `NextResponse.json`; convert domain `AppError`s with `handleRouteError()` from [apps/web/lib/http.ts](apps/web/lib/http.ts)
- **Tests:** Vitest runs `packages/**/*.test.ts` and `apps/**/*.test.ts` in a Node environment (`vitest.config.mts`)

## Code Style
- **Imports:** Use `@/*` for `apps/web` modules and `@corgtex/*` for shared package entrypoints. Use `type` imports for type-only imports (`import type { X }`)
- **Formatting:** Double quotes, no semicolons omission (semicolons used), 2-space indent
- **Naming:** camelCase for variables/functions, PascalCase for types/components, UPPER_SNAKE for constants/enums
- **Errors:** Throw `AppError(status, code, message)` from domain logic and convert it in route handlers with `handleRouteError()`. No `.js` allowed (`allowJs: false`)
- **DB:** All monetary values stored as `*Cents: Int`. UUIDs for all IDs. Use Prisma compound unique keys for lookups

## Git & Branching Strategy
- **Branching:** Every new feature or development should be on a new branch so there is no overlaps in PRs.
- **Testing & PRs:** All new features must be end-to-end tested. Once complete, push the branch and ALWAYS open a pull request immediately using the GitHub CLI (`gh`). You must generate the PR using the `gh` tool automatically instead of providing manual web links. Note: The `gh` CLI is installed via Homebrew; if it's not in your PATH, invoke it explicitly via `/opt/homebrew/bin/gh`.
- **PR Content Requirements:** Every PR MUST include the original implementation plan and the final walkthrough in its description to provide clear guidance for whoever is merging it. Furthermore, for ANY frontend-related changes, you must attach screen recordings and screenshots proving that the functionality works on your local branch.

## Deployment Invariants
- **Database Page Caching:** All Prisma-dependent App Router pages MUST have `export const dynamic = "force-dynamic"`. Do not let Next.js attempt static database queries during build.
- **Migration Execution:** Migrations are explicitly applied automatically at container startup via the `deploy/entrypoint.sh` script.
- **Railway Configuration:** The `preDeployCommand` in Railway TOML files is **not reliable** when paired with `builder = "DOCKERFILE"`. Rely on the `entrypoint.sh`.
- **Smoke Testing:** Any PR merging to `main` must pass a post-deploy smoke routine to ensure continuous availability.
- **Docker Workspace Execution:** When executing root-level package.json scripts inside the production Docker container (e.g., in `entrypoint.sh`), ALWAYS invoke `node /app/scripts/...` directly with absolute paths. Do NOT use `npm run <script>`, as npm resolves the execution context into the child workspace (e.g., `@corgtex/web`) and will crash with a "Missing script" error.
