# Plan: Pilot ship hardening and practical support access

## Goal

Make pilot support and agent testing access explicit, reliable, and auditable without relying on hidden hardcoded developer access or production startup seeding. Global operator access remains available for support, tester accounts can exercise real workspace flows, and production boots run migrations without surprise demo/test seed data.

## Out of scope

- Metadata-only support mode or content redaction.
- SAML, SCIM, MFA, or broader enterprise identity work.
- Agent/bootstrap credential redesign beyond tester login support.
- Retrieval, worker scaling, model-cost, or queue architecture changes.

## Files to touch

- `apps/web/app/[locale]/workspaces/[workspaceId]/admin/actions.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/admin/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/layout.tsx`
- `apps/web/lib/markdown.ts`
- `apps/web/lib/markdown.test.ts`
- `apps/web/package.json`
- `docs/pilot-testing.md`
- `docs/plans/codex-pilot-ship-hardening.md`
- `package-lock.json`
- `package.json`
- `packages/domain/src/actions.ts`
- `packages/domain/src/admin.test.ts`
- `packages/domain/src/admin.ts`
- `packages/domain/src/auth.agent-workspaces.test.ts`
- `packages/domain/src/auth.ts`
- `packages/domain/src/privacy.ts`
- `packages/domain/src/proposals.test.ts`
- `packages/domain/src/proposals.ts`
- `packages/domain/src/tensions.test.ts`
- `packages/domain/src/tensions.ts`
- `packages/shared/src/pilot-testing.integration.test.ts`
- `packages/shared/src/types.ts`
- `prisma/schema.prisma`
- `prisma/migrations/20260425011405_add_global_operator_role/**`
- `prisma/seed.mjs`
- `scripts/cleanup-test-artifacts.mjs`
- `scripts/e2e-agent-tests.mjs`
- `scripts/seed-pilot-tester.mjs`
- `scripts/start-web.mjs`

## Acceptance criteria

- [x] Global operator access is stored on users via a Prisma-backed role and no app code checks a personal email address.
- [x] `ADMIN_EMAIL` seed promotes the seeded admin to global operator.
- [x] Production web startup runs migrations by default and only runs seed scripts when explicitly configured.
- [x] Pilot tester seed script creates or updates a full-access workspace admin tester with explicit credentials.
- [x] Test artifact cleanup archives matching tester proposals and cancels matching tester tensions without hard deletes.
- [x] Markdown rendering strips unsafe HTML and scriptable URL attributes before `dangerouslySetInnerHTML`.
- [x] Private proposal and tension detail fetches apply the same privacy rules as list fetches.
- [x] Unit and integration coverage exists for operator access, private detail access, Markdown sanitization, tester seeding, and cleanup.

## Test plan

```
npm run check
npm test
npm run test:integration
npm run build
```

## Rollback

This includes a schema migration adding `User.globalRole`. To roll back before deployment, revert the PR normally. To roll back after deployment, first ensure no production users depend on `OPERATOR`, then deploy a follow-up migration that removes the `globalRole` column and `GlobalRole` enum before reverting the code.

## Labels this PR needs

- `forbidden-path-approved` — touches `packages/domain/src/auth.ts` and `prisma/migrations/**` to replace hardcoded support access with explicit operator access.
- `large-change-approved` — exceeds the 400 LOC / 15 file cap because this bundles the schema/auth change, seed/startup split, scripts, docs, and tests needed for a complete pilot support workflow.
