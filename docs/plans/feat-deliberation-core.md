# Plan: Deliberation Core — Unified Schema & Domain Layer

## Goal

Create a unified, entity-agnostic deliberation system that enables structured consent-based discussion (questions, reactions, concerns, objections, support, advice requests) on any entity in Corgtex. This replaces the current fragmented approach where proposals, finance, and brain articles each have separate, incompatible discussion models.

The `DeliberationEntry` model uses a polymorphic `parentType` + `parentId` pattern so any current or future entity can have a discussion thread attached with zero schema changes. The domain module exposes a clean CRUD API that is easy to integrate from any page or external system.

## Out of scope

- UI components (PR 2: `feat/deliberation-ui`)
- Cross-entity rollout to finance, tensions, meetings (PR 3: `feat/deliberation-rollout`)
- Removing old models (`ProposalReaction`, `SpendComment`) — done after migration in PR 2/3
- AI-powered advisor recommendations (requires model gateway calls; will be a workflow job triggered by events emitted here)

## Files to touch

- `prisma/schema.prisma`
- `prisma/migrations/**`
- `packages/domain/src/deliberation.ts`
- `packages/domain/src/deliberation.test.ts`
- `packages/domain/src/index.ts`
- `packages/domain/src/proposals.ts`
- `docs/plans/feat-deliberation-core.md`

## Acceptance criteria

- [ ] `DeliberationEntry` model exists in schema with `parentType`, `parentId`, `entryType`, `bodyMd`, `targetMemberId`, `resolvedAt`, `resolvedNote`, author relation, workspace relation
- [ ] Prisma migration is generated and applies cleanly
- [ ] `postDeliberationEntry(actor, params)` domain function validates input, enforces membership, creates entry + audit log + event
- [ ] `resolveDeliberationEntry(actor, params)` marks entry as resolved with note, restricted to parent entity author or workspace admin
- [ ] `listDeliberationEntries(workspaceId, parentType, parentId)` returns entries with author info, ordered chronologically
- [ ] `getProposal(actor, { workspaceId, proposalId })` function added to `proposals.ts` for fetching a single proposal with full relations
- [ ] `OBJECTION` entries require non-empty `bodyMd`
- [ ] `SUPPORT` entries are deduplicated per user per parent
- [ ] `ADVICE_REQUEST` entries accept a `targetMemberId` field
- [ ] All new functions are exported from `packages/domain/src/index.ts`
- [ ] Unit tests cover: post entry, resolve entry, list entries, objection validation, support dedup, advice request with target
- [ ] `npm run check` passes
- [ ] `npm run test:unit` passes

## Test plan

```
npm run prisma:generate
npm run check
npx vitest run packages/domain/src/deliberation.test.ts
npm run test:unit
```

## Rollback

No data is migrated in this PR — only a new table is created alongside existing ones. Revert is safe: drop the `DeliberationEntry` table via a rollback migration. No existing functionality is changed.

## Labels this PR needs

- `forbidden-path-approved` — touches `prisma/migrations/**`

## Implementation notes for Executor

### Schema addition (`prisma/schema.prisma`)

Add after the `ProposalReaction` model (around line 557):

```prisma
model DeliberationEntry {
  id              String    @id @default(uuid())
  workspaceId     String
  parentType      String    // "PROPOSAL" | "SPEND" | "TENSION" | "MEETING" | "BRAIN_ARTICLE"
  parentId        String
  authorUserId    String
  entryType       String    // "SUPPORT" | "QUESTION" | "CONCERN" | "OBJECTION" | "REACTION" | "ADVICE_REQUEST"
  bodyMd          String?   @db.Text
  targetMemberId  String?   // For ADVICE_REQUEST: which member is being asked
  resolvedAt      DateTime?
  resolvedNote    String?
  createdAt       DateTime  @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  author    User      @relation(fields: [authorUserId], references: [id], onDelete: Cascade)

  @@index([parentType, parentId, createdAt])
  @@index([workspaceId, parentType])
}
```

Add `deliberationEntries DeliberationEntry[]` to the `Workspace` model and `User` model relations.

### Domain module (`packages/domain/src/deliberation.ts`)

Valid entry types: `SUPPORT`, `QUESTION`, `CONCERN`, `OBJECTION`, `REACTION`, `ADVICE_REQUEST`.

Valid parent types: `PROPOSAL`, `SPEND`, `TENSION`, `MEETING`, `BRAIN_ARTICLE`.

Key behaviors:
- `postDeliberationEntry`: validate entryType + parentType, enforce workspace membership, if `OBJECTION` require non-empty bodyMd, if `SUPPORT` deduplicate (upsert pattern), create entry + auditLog + event (`deliberation.entry_posted`). Return the created entry.
- `resolveDeliberationEntry`: find entry, verify workspace, verify caller is the parent entity's author OR has ADMIN role, update resolvedAt + resolvedNote, create auditLog. Return updated entry.
- `listDeliberationEntries`: query by `parentType` + `parentId`, include author user `{ id, displayName, email }`, order by `createdAt asc`. Return array.

### `getProposal` addition (`packages/domain/src/proposals.ts`)

Add after `listProposals`:

```typescript
export async function getProposal(actor: AppActor, params: {
  workspaceId: string;
  proposalId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const proposal = await prisma.proposal.findUnique({
    where: { id: params.proposalId },
    include: {
      author: { select: { id: true, displayName: true, email: true } },
      circle: { select: { id: true, name: true } },
      tensions: { select: { id: true, title: true, status: true } },
      actions: { select: { id: true, title: true, status: true } },
      adviceProcess: {
        include: {
          records: {
            include: { member: { include: { user: { select: { displayName: true, email: true } } } } }
          }
        }
      },
    },
  });
  invariant(proposal && proposal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Proposal not found.");
  return proposal;
}
```

Note: This does NOT include `reactions` (old model). The detail page in PR 2 will query `listDeliberationEntries` separately.
