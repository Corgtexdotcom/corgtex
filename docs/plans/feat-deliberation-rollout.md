# Plan: Deliberation Rollout — Finance, Tensions, Meetings + Data Migration

## Goal

Roll out the `DeliberationThread` component to finance (spend requests), tensions, and meetings. Create tension detail pages. Migrate existing `ProposalReaction` and `SpendComment` data into the unified `DeliberationEntry` table. After this PR, all deliberation across the platform uses a single model and a single UI component.

**Depends on:** `feat/deliberation-ui` (PR 2) must be merged first.

## Out of scope

- Removing old `ProposalReaction` and `SpendComment` models from schema (do in a follow-up cleanup PR after verifying data integrity)
- AI advisor recommendations (separate feature PR)
- Brain article discussions (already has `BrainDiscussionThread` — migrate in a follow-up)

## Files to touch

- `apps/web/app/[locale]/workspaces/[workspaceId]/finance/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/finance/actions.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/tensions/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/tensions/[tensionId]/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/tensions/actions.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/meetings/[meetingId]/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/meetings/actions.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/actions.ts`
- `packages/domain/src/tensions.ts`
- `packages/domain/src/tensions.test.ts`
- `packages/domain/src/deliberation.ts`
- `packages/domain/src/finance.ts`
- `scripts/migrate-to-deliberation.ts`
- `docs/plans/feat-deliberation-rollout.md`
- `docs/assets/deliberation_flow_test.mp4`

## Acceptance criteria

- [x] `packages/domain/src/tensions.ts` has a `getTension` function that returns the tension and author info.
- [x] Tension titles in the `tensions/page.tsx` list are clickable and route to the new detail page.
- [x] `apps/web/app/workspaces/[workspaceId]/tensions/[tensionId]/page.tsx` renders the `DeliberationThread` and `DeliberationComposer` below the tension description.
- [x] Tension deliberation server actions (`postTensionDeliberationAction` and `resolveTensionDeliberationAction`) are exported from `tensions/actions.ts` and `workspaces/.../actions.ts`.
- [x] `finance/page.tsx` uses `DeliberationThread` and `DeliberationComposer` instead of the old `fin-thread` markup.
- [x] Finance deliberation server actions (`postSpendDeliberationAction` and `resolveSpendDeliberationAction`) are implemented alongside the existing `addSpendCommentAction` for backward compatibility.
- [x] `meetings/[meetingId]/page.tsx` renders the `DeliberationThread` and `DeliberationComposer` below the summary.
- [x] Meeting deliberation server actions (`postMeetingDeliberationAction` and `resolveMeetingDeliberationAction`) are implemented and exported.
- [x] `scripts/migrate-to-deliberation.ts` exists and correctly ports legacy `ProposalReaction` and `SpendComment` records into `DeliberationEntry` with proper types.
- [x] The `migrate-to-deliberation.ts` script is idempotent (can be run multiple times safely).
- [x] The application builds successfully (`npm run check` passes).
- [x] Screen recording captured showing: deliberation on finance spend, tension detail page, meeting discussion.

## Test plan

```
npm run check
npm run test:unit
```

Manual: run `npm run dev`, test deliberation on a spend request, a tension, and a meeting. Run migration script against local DB and verify data integrity.

## Rollback

The migration script creates new data alongside old data. If reverted, the old `SpendComment`-based finance UI works again. New `[tensionId]` route simply 404s. The migration script's data can be cleaned up with `DELETE FROM "DeliberationEntry"`. Safe to revert.

## Labels this PR needs

_(none — no forbidden paths unless the LOC cap is exceeded, in which case `large-change-approved`)_

## Implementation notes for Executor

### Finance integration

In `finance/page.tsx`, replace the inline `fin-thread` section (lines ~240-265) with the `DeliberationThread` component:

```tsx
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { listDeliberationEntries } from "@corgtex/domain";
```

For each spend in SUBMITTED/OBJECTED status, fetch entries: `listDeliberationEntries(workspaceId, "SPEND", spend.id)` and render the thread.

New server actions in `finance/actions.ts`:
- `postSpendDeliberationAction` — calls `postDeliberationEntry` with `parentType: "SPEND"`
- `resolveSpendDeliberationAction` — calls `resolveDeliberationEntry`

Entry types for finance: `[{ value: "REACTION", label: "Comment" }, { value: "CONCERN", label: "Concern" }, { value: "OBJECTION", label: "Objection" }]`

### Tension detail page

New page at `tensions/[tensionId]/page.tsx` following the pattern from `proposals/[proposalId]/page.tsx`:
- Back link to tensions list
- Masthead: title, status badge, author, priority, date
- Body text
- `DeliberationThread` with entries from `listDeliberationEntries(workspaceId, "TENSION", tensionId)`
- Composer with types: Support, Question, Concern, Reaction

Add `getTension` to `packages/domain/src/tensions.ts`:
```typescript
export async function getTension(actor: AppActor, params: { workspaceId: string; tensionId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const tension = await prisma.tension.findUnique({
    where: { id: params.tensionId },
    include: {
      author: { select: { id: true, displayName: true, email: true } },
      circle: { select: { id: true, name: true } },
      proposal: { select: { id: true, title: true, status: true } },
      upvotes: true,
    },
  });
  invariant(tension && tension.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Tension not found.");
  return tension;
}
```

Update tensions list page to wrap each tension in an `<a>` link.

### Meeting integration

In `meetings/[meetingId]/page.tsx`, add a `DeliberationThread` section after the transcript:

```tsx
<section className="ws-section" style={{ marginBottom: 48 }}>
  <h2 className="nr-section-header">Discussion</h2>
  <DeliberationThread entries={meetingEntries} ... />
  <DeliberationComposer postAction={postMeetingDeliberationAction} ... />
</section>
```

Entry types for meetings: `[{ value: "QUESTION", label: "Question" }, { value: "REACTION", label: "Comment" }, { value: "CONCERN", label: "Concern" }]`

### Data migration script (`scripts/migrate-to-deliberation.ts`)

```typescript
// Run with: npx tsx scripts/migrate-to-deliberation.ts
// Idempotent: checks for existing entries before inserting

import { prisma } from "@corgtex/shared";

async function main() {
  // 1. Migrate ProposalReaction → DeliberationEntry (parentType: "PROPOSAL")
  const reactions = await prisma.proposalReaction.findMany({
    include: { proposal: { select: { workspaceId: true } } },
  });
  
  for (const r of reactions) {
    const existing = await prisma.deliberationEntry.findFirst({
      where: { parentType: "PROPOSAL", parentId: r.proposalId, authorUserId: r.userId, createdAt: r.createdAt },
    });
    if (!existing) {
      await prisma.deliberationEntry.create({
        data: {
          workspaceId: r.proposal.workspaceId,
          parentType: "PROPOSAL",
          parentId: r.proposalId,
          authorUserId: r.userId,
          entryType: r.reaction,  // Already matches: SUPPORT, OBJECTION, QUESTION, CONCERN, REACTION
          bodyMd: r.bodyMd,
          resolvedAt: r.resolvedAt,
          resolvedNote: r.resolvedNote,
          createdAt: r.createdAt,
        },
      });
    }
  }
  
  // 2. Migrate SpendComment → DeliberationEntry (parentType: "SPEND")
  const comments = await prisma.spendComment.findMany({
    include: { spend: { select: { workspaceId: true } } },
  });
  
  for (const c of comments) {
    const existing = await prisma.deliberationEntry.findFirst({
      where: { parentType: "SPEND", parentId: c.spendId, authorUserId: c.authorUserId, createdAt: c.createdAt },
    });
    if (!existing) {
      await prisma.deliberationEntry.create({
        data: {
          workspaceId: c.spend.workspaceId,
          parentType: "SPEND",
          parentId: c.spendId,
          authorUserId: c.authorUserId,
          entryType: c.isObjection ? "OBJECTION" : "REACTION",
          bodyMd: c.bodyMd,
          resolvedAt: c.resolvedAt,
          createdAt: c.createdAt,
        },
      });
    }
  }
  
  console.log(`Migrated ${reactions.length} proposal reactions and ${comments.length} spend comments.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
```
