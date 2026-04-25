# Plan: Codebase Cleanup Boundaries

{/*
  This file is the canonical handoff from Planner (Claude) to Executor
  (Gemini in Antigravity) and to Reviewer (Codex).
*/}

## Goal

Make the codebase cleanup invariants enforceable instead of implicit: remove exported placeholder domain APIs, move the remaining app-layer writes behind domain services, keep production startup from running demo/test seed data by default, replace the current dummy integration test with meaningful DB-backed coverage, and update AGENTS/docs so agents run the scripts that actually exist.

## Risk tier

- high

## Out of scope

- Prisma schema or migration changes.
- New UI screens, component redesigns, or copy changes beyond any incidental server-action rewiring.
- Changing auth/session semantics or touching `apps/web/lib/auth.ts` / `packages/domain/src/auth*.ts`.
- Reworking the SQL connector implementation or adding new external database drivers.
- Expanding full browser E2E coverage; this plan only broadens Vitest integration coverage.

## Files to touch

- `docs/plans/chore-codebase-cleanup-plan.md`
- `package.json`
- `AGENTS.md`
- `docs/contributing/testing.mdx`
- `docs/contributing/development-setup.mdx`
- `docs/contributing/pull-requests.mdx`
- `docs/assets/chore-codebase-cleanup-plan/brain-proof.png`
- `prisma/seed.mjs`
- `scripts/start-web.mjs`
- `scripts/seed-e2e.mjs`
- `packages/domain/src/index.ts`
- `packages/domain/src/stubs.ts`
- `packages/domain/src/crm.ts`
- `packages/domain/src/integrations.ts`
- `packages/domain/src/codebase-cleanup.integration.test.ts`
- `packages/shared/src/dummy.integration.test.ts`
- `apps/web/app/api/demo-leads/route.ts`
- `apps/web/app/api/integrations/[provider]/callback/route.ts`
- `apps/web/app/api/integrations/[provider]/callback/route.test.ts`
- `apps/web/app/api/workspaces/[workspaceId]/data-sources/**`
- `apps/web/app/api/workspaces/[workspaceId]/conversations/[conversationId]/route.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/brain/[slug]/page.tsx`

## Implementation notes

Keep this as a cleanup PR, not a feature PR. If `large-change-approved` is not granted, split this into two plans before implementing: first the domain-boundary cleanup (`stubs`, app writes, integration tests), then the seed/docs alignment.

Suggested shape:

- Delete `packages/domain/src/stubs.ts` and remove its barrel export. Do not replace stubs with new no-op exports.
- Add real domain entrypoints in existing domain modules rather than creating broad new abstractions:
  - `packages/domain/src/crm.ts`: capture a demo lead and CRM contact in one idempotent service.
  - `packages/domain/src/integrations.ts`: persist OAuth provider connections, enqueue calendar sync jobs, and manage external data source CRUD/sync operations.
  - Existing `updateArticle()`, `ingestSource()`, and `renameConversation()` should replace the remaining direct app-layer writes for Brain and conversations.
- Keep route handlers responsible for HTTP parsing, rate limiting, redirects, provider token/profile fetches, and response shaping only.
- Keep production startup deterministic: migrations plus production/admin seed only. Demo/test fixtures and E2E users must be explicit script invocations.

## Acceptance criteria

- [x] `packages/domain/src/stubs.ts` is deleted and `packages/domain/src/index.ts` no longer exports `./stubs`.
- [x] A repository search finds no exported domain placeholder implementations using `null as any` / `(...args: any[])`.
- [x] The demo lead POST route delegates all workspace/demo lead/CRM contact persistence to a domain service.
- [x] The OAuth callback route delegates OAuth connection persistence and calendar sync job creation to domain service code.
- [x] External data source create/update/delete and manual sync writes are performed by domain service code, including knowledge chunk cleanup on delete.
- [x] Brain article inline edits use `updateArticle()`, data-source text ingest uses `ingestSource()`, and conversation auto-title uses `renameConversation()` instead of direct app-layer Prisma writes.
- [x] `apps/web/app/**` and `apps/web/lib/**` contain no Prisma write calls or `prisma.$transaction` calls outside tests.
- [x] `scripts/start-web.mjs` no longer runs demo/test fixture seed scripts by default; any extra startup seed scripts require an explicit environment variable.
- [x] `prisma/seed.mjs` no longer provisions E2E users or reads `AGENT_E2E_EMAIL` / `AGENT_E2E_PASSWORD`.
- [x] A dedicated E2E seed script is available through `package.json` and provisions the E2E UI user from `AGENT_E2E_EMAIL` / `AGENT_E2E_PASSWORD`.
- [x] Docs explain that `AGENT_API_KEY` is required at runtime for Agent API E2E calls, not as part of production startup seeding.
- [x] Integration test coverage includes at least two meaningful DB-backed checks beyond `SELECT 1`, exercising domain mutation behavior and persisted side effects.
- [x] The old dummy integration test body is removed or replaced with domain-owned coverage.
- [x] `AGENTS.md` and contributing docs accurately describe `npm run test:integration`, `docker-compose.test.yml`, the scope of `npm run check`, production seed behavior, demo seed behavior, and E2E seed behavior.
- [x] No Prisma schema or migration files are changed.
- [x] Because this touches `apps/web/app/**`, the PR description includes visual proof that the Brain article page still renders after the server-action rewiring.

## Test plan

```
npm run check
npm run test:unit
npm run test:integration
bash -lc 'if rg -n "prisma\\.(\\$transaction|[A-Za-z0-9_]+\\.(create|update|upsert|delete|createMany|updateMany|deleteMany))|tx\\.[A-Za-z0-9_]+\\.(create|update|upsert|delete|createMany|updateMany|deleteMany)" apps/web/app apps/web/lib --glob "!**/*.test.*"; then exit 1; fi'
bash -lc 'if rg -n "null as any|\\.\\.\\.args: any\\[\\]|export \\* from \\\"./stubs\\\"" packages/domain/src; then exit 1; fi'
```

Manual:

```
npm run dev
```

Open a Brain article page, submit a small body/type/authority edit, and capture visual proof for the PR.

## Rollback

This is a pure code/docs/script cleanup with no schema migration. Revert the PR to restore the previous startup seed behavior and route implementations. If a deployment relied on implicit demo/JNJ/E2E seeding from production startup, run the explicit seed scripts once after rollback or set the documented extra-seed environment variable before restart.

## Labels this PR needs

- `large-change-approved` — the cleanup intentionally crosses the normal 400-LOC / 15-file cap because the requested invariants span domain exports, route boundaries, startup scripts, tests, and docs. If this label is not approved, split the work as described in Implementation notes before coding.
