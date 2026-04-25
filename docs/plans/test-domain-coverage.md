# Plan: Domain test coverage for critical untested modules

## Goal

25 of 50 domain modules (50%) have zero unit test coverage. This includes
security-critical modules like `auth.ts` (login, registration, authorization),
`members.ts` (member CRUD, role assignment), and `roles.ts` (governance
permissions). The AGENTS.md rule explicitly states tests must be added when
`packages/domain/**` changes — but no tests exist for the most foundational
modules, meaning every future change to them will either skip testing or
require writing tests from scratch under time pressure.

This plan adds unit tests for the six highest-criticality untested domain
modules: `auth.ts`, `members.ts`, `roles.ts`, `workspaces.ts`,
`notifications.ts`, and `meetings.ts`. Together these cover the core user
lifecycle (auth → workspace → membership → roles → notifications → meetings).

## Risk tier

- `standard`

## Out of scope

- Integration tests (database-backed) — this plan uses mocked Prisma only.
- Tests for lower-criticality modules (`agent-memory.ts`, `expertise.ts`,
  `storage-metrics.ts`, `advice-process.ts`, etc.).
- Tests for `brain.ts` (910 lines, needs its own dedicated plan).
- Refactoring domain module code — tests are additive only.
- Changes to any non-test source file.

## Files to touch

- `docs/plans/test-domain-coverage.md`
- `packages/domain/src/auth.test.ts`
- `packages/domain/src/members.test.ts`
- `packages/domain/src/roles.test.ts`
- `packages/domain/src/workspaces.test.ts`
- `packages/domain/src/notifications.test.ts`
- `packages/domain/src/meetings.test.ts`

## Acceptance criteria

- [ ] `auth.test.ts` covers: `loginUserWithPassword` (success, wrong password, missing email), `registerUser` (success, duplicate, short password), `resolveSessionActor` (valid, expired, null), `requireWorkspaceMembership` (user member, user non-member, agent allowed, agent blocked, global operator), `clearSession`, `isGlobalOperator`, `listActorWorkspaces` (user, agent, operator).
- [ ] `members.test.ts` covers: `listMembers`, `createMember` (success, existing user/member upsert path), `inviteMember` (success, existing user/member path), `updateMember` (role change, missing member guard), `deactivateMember` (success, already deactivated guard), `getMemberProfile`.
- [ ] `roles.test.ts` covers: `listRoles`, `createRole` (success, missing circle/name guards), `updateRole`, `deleteRole` (success, missing role guard), `assignRole` (success, missing member guard), `unassignRole`, `listRoleAssignments`.
- [ ] `workspaces.test.ts` covers: `createWorkspace` (success, missing name), `listWorkspaces`.
- [ ] `notifications.test.ts` covers: `listNotifications`, `countUnreadNotifications`, `markNotificationRead`, `markAllNotificationsRead`.
- [ ] `meetings.test.ts` covers: `listMeetings`, `getMeeting` (found, not found), `createMeeting` (success, missing fields), `deleteMeeting`.
- [ ] All tests use `vi.mock("@corgtex/shared")` with Prisma mocks, consistent with the existing test pattern in `auth.session.test.ts` and `circles.test.ts`.
- [ ] `npm run test:unit` passes with 0 failures.
- [ ] `npm run check` (lint + typecheck + prisma validate) passes.

## Test plan

```
npm run check
npx vitest run --project unit packages/domain/src/auth.test.ts
npx vitest run --project unit packages/domain/src/members.test.ts
npx vitest run --project unit packages/domain/src/roles.test.ts
npx vitest run --project unit packages/domain/src/workspaces.test.ts
npx vitest run --project unit packages/domain/src/notifications.test.ts
npx vitest run --project unit packages/domain/src/meetings.test.ts
npm run test:unit
```

## Rollback

Pure additive test files — no source code changes, no schema changes, no
migration. Safe to revert by deleting the test files. No ordering constraints.

## Labels this PR needs

(none)
