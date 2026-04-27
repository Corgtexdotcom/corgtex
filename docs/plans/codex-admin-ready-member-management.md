# Plan: Admin-ready member management

## Goal

Make workspace member management safe and useful for Corgtex clients by closing authorization gaps, adding admin-controlled invite policy, supporting invite requests, and allowing scoped-safe admin edits for member names, emails, roles, active status, and access links.

## Risk tier

- high

## Out of scope

- Platform-operator tooling for changing shared or SSO-linked account emails.
- Full replacement of the settings UI design system.
- Email delivery provider changes beyond using the existing invitation email helper.

## Files to touch

- `docs/plans/codex-admin-ready-member-management.md`
- `apps/web/app/[locale]/workspaces/[workspaceId]/members/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/MembersTable.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/actions.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/page.tsx`
- `apps/web/app/api/workspaces/[workspaceId]/members/[memberId]/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/members/invite-requests/**`
- `apps/web/messages/en.json`
- `apps/web/messages/es.json`
- `packages/agents/src/tools/members.ts`
- `packages/domain/src/members.test.ts`
- `packages/domain/src/members.ts`
- `packages/mcp/src/server.ts`
- `prisma/schema.prisma`
- `prisma/migrations/**`
- `docs/assets/codex-admin-ready-member-management/**`

## Acceptance criteria

- [x] A signed-in non-member cannot view another workspace’s member directory or settings members tab.
- [x] Default invite policy is admins-only for all existing workspaces.
- [x] Admins can invite, bulk invite, edit name/email/role, deactivate, reactivate, and resend an access link.
- [x] Non-admins cannot add members under `ADMINS_ONLY`.
- [x] Non-admins can contributor-invite only under `MEMBERS_CAN_INVITE`.
- [x] Non-admins can submit invite requests, and admins can approve/reject them, under `MEMBERS_CAN_REQUEST`.
- [x] Email edit rejects duplicate emails, SSO-linked users, and users with memberships in other workspaces.
- [x] Email edit updates login email, writes audit metadata, and invalidates sessions.
- [x] API, MCP, and agent member tools match the new permission and update behavior.
- [x] Frontend visual proof is committed under `docs/assets/codex-admin-ready-member-management/`.

## Test plan

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/corgtex_test npm run prisma:migrate -- --name member_management_invite_requests
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/corgtex_test npm run prisma:migrate:deploy
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/corgtex_test npm run test:unit
npx vitest run packages/domain/src/members.test.ts
npm run check
npm run build
```

## Rollback

Revert this PR. The migration adds `MemberInviteRequestStatus` and `MemberInviteRequest`; if the migration has been applied in an environment, drop the invite request table and enum only after confirming no pending invite-request data must be retained.

## Labels this PR needs

- `forbidden-path-approved` — this PR includes a Prisma migration.
- `large-change-approved` — the member-management implementation exceeds the high-risk LOC cap but stays within a focused membership-management scope.
