# Plan: Chat Agent Permission Mirroring

## Goal
Make the Corgtex chat agent act on behalf of the logged-in user instead of as a generic agent and add tools for member and role management.

## Out of scope
- Invite/create member tools
- Circle CRUD tools
- Role CRUD tools

## Files to touch
- `packages/agents/src/conversation.ts`
- `packages/agents/src/tools/members.ts`
- `apps/web/app/api/workspaces/[workspaceId]/conversations/[conversationId]/route.ts`
- `docs/assets/permissions.png`
- `docs/plans/fix-agent-chat-permissions.md`

## Acceptance criteria
- [x] Pass the authenticated user's `AppActor` through the system.
- [x] Create tools for listing members and updating roles.
- [x] All writes are recorded under the user's audit trail.
- [x] Admin actions are prevented from non-admins.

## Test plan
```bash
npm run check
```
