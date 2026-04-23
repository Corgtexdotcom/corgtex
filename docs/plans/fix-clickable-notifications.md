# Plan: Make dashboard notifications and approvals clickable

## Goal

Enhance the workspace dashboard's "Attention" section by making notification items and pending approval items clickable. Currently they are plain text, forcing users to manually navigate to the relevant entity. We will use the existing `entityType`/`entityId` and `subjectType`/`subjectId` fields to construct deep links using Next.js `<Link>`.

## Out of scope

- Creating dedicated detail pages (e.g., `/proposals/[id]`). We will link to the existing list pages.
- Changing any backend notification creation logic.
- Modifying the Prisma schema.

## Files to touch

- `apps/web/app/workspaces/[workspaceId]/page.tsx`
- `docs/plans/fix-clickable-notifications.md`
- `docs/assets/clickable-notifications-demo.png`

## Acceptance criteria

- [x] A URL resolution helper is added to map `entityType` + `entityId` to workspace routes.
- [x] Notification items in the dashboard wrap their title in a `<Link>` pointing to the correct entity type's list.
- [x] Notifications without a resolvable entity type fall back to plain text.
- [x] Approval pending items wrap their `subjectType` string in a `<Link>` pointing to the relevant entity list.
- [x] The "Approve" button remains a separate action and is unaffected by the link.

## Test plan

```
npm run check
```

## Rollback

This is a pure UI change. Reverting the PR will simply remove the links and return the items to plain text. No state or schema changes are involved.

## Labels this PR needs

