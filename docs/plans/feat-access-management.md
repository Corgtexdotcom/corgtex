# Plan: Access Management

{/*
  This file is the canonical handoff from Planner (Claude) to Executor
  (Gemini in Antigravity) and to Reviewer (Codex).
*/}

## Goal

Centralize user/member management with invitation flows, bulk import, per-workspace admin controls, and a global admin dashboard scoped to the Corgtex workspace. Eliminates the insecure practice of admins setting passwords manually.

## Out of scope

- Single Sign-On (SSO) integration (deferred for now).
- Extensive email template redesigns beyond functional requirements.
- Changing session limits or existing auth schemas.

## Files to touch

- `apps/web/app/login/page.tsx`
- `apps/web/app/setup-account/[token]/SetupAccountForm.tsx`
- `apps/web/app/setup-account/[token]/actions.ts`
- `apps/web/app/setup-account/[token]/page.tsx`
- `apps/web/app/setup-account/[token]/state.ts`
- `apps/web/app/workspaces/[workspaceId]/admin/AdminDashboardClient.tsx`
- `apps/web/app/workspaces/[workspaceId]/admin/actions.ts`
- `apps/web/app/workspaces/[workspaceId]/admin/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/layout.tsx`
- `apps/web/app/workspaces/[workspaceId]/settings/MembersTable.tsx`
- `apps/web/app/workspaces/[workspaceId]/settings/actions.ts`
- `apps/web/app/workspaces/[workspaceId]/settings/page.tsx`
- `apps/web/app/api/workspaces/[workspaceId]/members/route.ts`
- `docs/plans/feat-access-management.md`
- `packages/domain/src/admin.ts`
- `packages/domain/src/admin.test.ts`
- `packages/domain/src/index.ts`
- `packages/domain/src/members.ts`

## Acceptance criteria

- [x] Reactivation button works directly from the UI without API/DB workarounds.
- [x] Admins can invite new users via email only (without having to set a password).
- [x] Users receive an invitation email and can set their password correctly via `/setup-account`.
- [x] Admins can paste a CSV into a bulk import tool on the Members tab to invite many users at once.
- [x] Any regular active member can invite a colleague to the workspace as a CONTRIBUTOR.
- [x] Global admin (`janbrezina@icloud.com`) has a dedicated Platform Admin interface inside the Corgtex workspace to govern all users and workspaces.

## Test plan

```
npm run check
npm run test:unit
```

## Rollback

Revert the PR and run DB/data cleanup manually if needed based on `isActive` / new domain states. No Prisma schema changes required.

## Labels this PR needs

- `forbidden-path-approved` — touches domain administration files.
- `large-change-approved` — may exceed 400 LOC due to new pages and bulk import UI.
