# Plan: Workspace Archive, Restore, and Restricted Purge

## Goal

Implement archive-first removal for customer-visible workspace artifacts so agent/test submissions can be hidden from normal customer views without losing recovery or audit history. Add a restricted purge path for eligible archived records when hard deletion is necessary, while preserving immutable finance, audit, event, workflow, and ledger history.

## Risk tier

- high

This touches Prisma schema/migrations, broad domain list/delete behavior, frontend recovery controls, MCP tool semantics, and cleanup automation. It also changes destructive semantics from hard delete to soft archive in several customer-visible areas.

## Out of scope

- Purging immutable audit logs, ledger entries, workflow jobs, events, model usage, sessions, or posted accounting records.
- Rewriting historical customer data into archived state.
- Adding bulk purge tools outside the restricted archived/recovery surface.
- Changing auth/session behavior beyond adding opt-in archive MCP scopes.

## Files to touch

- `docs/plans/codex-workspace-archive-purge.md`
- `apps/web/app/[locale]/workspaces/[workspaceId]/audit/**`
- `apps/web/app/[locale]/workspaces/[workspaceId]/finance/**`
- `apps/web/app/[locale]/workspaces/[workspaceId]/meetings/**`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/**`
- `apps/web/app/api/workspaces/[workspaceId]/**`
- `apps/web/messages/*`
- `packages/domain/src/**`
- `packages/mcp/src/server.ts`
- `packages/shared/src/pilot-testing.integration.test.ts`
- `prisma/schema.prisma`
- `prisma/migrations/**`
- `scripts/cleanup-test-artifacts.mjs`

## Acceptance criteria

- [x] Archive metadata exists on customer-visible workspace models and is indexed for active-only reads.
- [x] `WorkspaceArchiveRecord` stores archive, restore, and purge tombstone metadata.
- [x] Domain APIs support archive, restore, purge, and archived artifact listing.
- [x] Default list/read/update paths exclude archived records unless an archive filter explicitly asks otherwise.
- [x] Normal delete paths archive records instead of hard deleting them.
- [x] Finance spend requests and ledger accounts have frontend and backend archive paths.
- [x] Restricted purge requires admin access, a reason, and rejects immutable or ledger-backed finance records.
- [x] Audit includes an Archived recovery view with filters, restore controls, and purge controls behind a required reason.
- [x] MCP destructive tools archive by default and expose explicit privileged restore/purge tools.
- [x] Test cleanup archives `[TEST]` artifacts across workspace surfaces and optionally purges eligible draft finance rows only with an explicit flag.
- [x] Domain, finance, cleanup integration, Prisma, typecheck, and lint validation pass.
- [x] Visual proof is committed under `docs/assets/codex-workspace-archive-purge/`.

## Test plan

```
npm run prisma:generate
npm run typecheck
npm run prisma:validate
npm run check
npx vitest run packages/domain/src/archive.test.ts packages/domain/src/meetings.test.ts packages/domain/src/roles.test.ts
npx vitest run packages/domain/src/finance.test.ts
npx vitest run packages/shared/src/pilot-testing.integration.test.ts
```

## Rollback

Revert the PR to restore previous hard-delete behavior and active list queries. Because this includes a forward Prisma migration, production rollback should be code-first: deploy a revert that stops writing archive fields, then only consider a follow-up migration to drop archive columns/table after confirming no archived records are needed. Do not drop `WorkspaceArchiveRecord` while recovery or audit references are still needed.

## Labels this PR needs

- `forbidden-path-approved` — touches `prisma/migrations/**`; required because archive metadata and the recovery table require a schema migration.
- `large-change-approved` — broad cross-surface behavior change exceeds the high-risk file and LOC caps but is intentionally workspace-wide to keep removal semantics consistent.
