# Plan: Notification enrichment

## Goal

Notifications on the workspace dashboard are generic and not actionable — they say
"Proposal submitted for review" with no indication of which proposal. Additionally,
the domain emits `proposal.opened` / `spend.opened` events but the notification
derivation only listens for `proposal.submitted` / `spend.submitted`, so notifications
never fire. This change enriches event payloads with entity titles, fixes the event
name mismatch, and improves the dashboard notification UI with deep links and context.

## Risk tier

- `low`

## Out of scope

- Schema changes or migrations
- Email / push notification delivery
- New notification preference settings

## Files to touch

- `packages/domain/src/proposals.ts`
- `packages/domain/src/finance.ts`
- `packages/workflows/src/derive-notifications.ts`
- `packages/workflows/src/outbox.test.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/page.tsx`
- `packages/domain/src/proposals.test.ts`
- `packages/domain/src/finance.test.ts`
- `docs/plans/fix-notification-enrichment.md`

## Acceptance criteria

- [x] Notifications include the proposal/spend title when available
- [x] Notifications fall back to generic text when title is missing
- [x] Both `*.opened` and `*.submitted` event types produce notifications
- [x] Approval flow cards show the proposal/spend title instead of raw type
- [x] Notification cards deep-link to the specific entity page
- [x] Notification cards show body text and age
- [x] Domain tests prove proposal.opened and spend.opened payloads include title
- [x] All tests pass

## Test plan

```
npx vitest run packages/domain/src/proposals.test.ts packages/domain/src/finance.test.ts packages/workflows/src/outbox.test.ts
```

## Rollback

Pure code change, no migrations. Safe to revert with no side effects.

## Labels this PR needs

