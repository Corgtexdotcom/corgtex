# Plan 3: Proposal Governance UX Refinement

## Goal

Refine the proposal workflow to align with self-management governance principles. Replace the current Support/Question/Concern buttons with a unified **Reactions** thread (for questions, concerns, suggestions) and formal **Objections** (blocking). Add author resolution flow, circle-scoped visibility, and auto-approval timer.

> **Stakeholder quote**: *"A concern is a reaction… you can have the space for questions and reactions being reactions, concerns, suggestions, and in the end we have a final box saying okay my proposal I decided to change something."*

## Context & What Exists

The codebase is at `/Users/janbrezina/Development /CORGTEX`.

### Current state
- **proposals/page.tsx** — Full proposal lifecycle: DRAFT → SUBMITTED → reactions (SUPPORT/QUESTION/CONCERN as buttons) → ADVICE_GATHERING → APPROVED/REJECTED → ARCHIVED
- **ProposalReaction model** — Stores `reaction` as a string (`SUPPORT`, `QUESTION`, `CONCERN`). Has `@@unique([proposalId, userId])` — only one reaction per user per proposal.
- **Objection model** — Already exists, linked to `ApprovalFlow` (not directly to proposals). Has `bodyMd`, `resolvedAt`.
- **ApprovalFlow model** — Manages consent/approval workflows. Already has `closesAt` for time-based closure.
- **ApprovalPolicy model** — Has `decisionWindowHours` (default 72) — the auto-approval timer concept exists in the schema.
- **AdviceProcess** — Fully implemented with advisor suggestions, endorsements, concerns, execute/withdraw.
- **Domain files**: `proposals.ts`, `reactions.ts`, `approvals.ts`, `objection-validation.ts`

### Key gaps
1. Reactions are limited to one-per-user enum buttons — no threaded discussion
2. No inline text for reactions (just a button click, no body/comment)
3. Objections exist but are only on ApprovalFlow, not surfaced in the proposal UI
4. No author resolution flow (author can't respond to concerns or mark them addressed)
5. Circle-scoped visibility: any user can see all proposals regardless of circle
6. Auto-approval timer logic exists in schema but isn't wired up in the proposal UI

## Out of scope

- Changes to the Advice Process flow (already well-implemented)
- Proposal templates or AI-assisted proposal drafting
- Notification system for proposals (separate concern)

## Files to touch

- `prisma/schema.prisma`
- `prisma/migrations/**`
- `packages/domain/src/proposals.ts`
- `packages/domain/src/reactions.ts`
- `packages/domain/src/index.ts`
- `apps/web/app/workspaces/[workspaceId]/proposals/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/proposals/ProposalReactionsThread.tsx`
- `apps/web/app/workspaces/[workspaceId]/proposals/actions.ts`
- `apps/web/app/api/workspaces/[workspaceId]/proposals/[proposalId]/reactions/route.ts`
- `apps/worker/src/index.ts`
- `docs/plans/feature-proposal-governance-ux.md`
- `AGENTS.md`
- `docs/contributing/agent-pipeline.mdx`

## Schema changes

### Update ProposalReaction model

Replace the single-reaction-per-user constraint with a threaded comment system:

```prisma
model ProposalReaction {
  id         String   @id @default(uuid())
  proposalId String
  userId     String
  reaction   String   // "SUPPORT", "REACTION", "OBJECTION"
  bodyMd     String?  @db.Text  // [NEW] Comment body for reactions/objections
  resolvedAt DateTime?           // [NEW] When author resolved this
  resolvedNote String?           // [NEW] Author's resolution note
  createdAt  DateTime @default(now())

  proposal Proposal @relation(fields: [proposalId], references: [id], onDelete: Cascade)
  user     User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  // REMOVE the @@unique([proposalId, userId]) constraint
  // Users should be able to post multiple reactions
  @@index([proposalId, createdAt])
}
```

### Add auto-approval fields to Proposal

```prisma
model Proposal {
  // ... existing fields ...
  autoApproveAt  DateTime?  // [NEW] When to auto-approve if no objections
}
```

## Detailed Implementation

### Part A: Unified Reactions Thread

**ProposalReactionsThread.tsx** [NEW] — Client component:

Replace the three buttons (Support/Question/Concern) with:

1. **Support button** (keep, as Dachi explicitly approved):
   - Quick one-click action, no text needed
   - Shows count of supports: "5 members support this"

2. **Reactions section** (replaces Question + Concern):
   - A comment input field: "Share a reaction, question, or suggestion..."
   - Submit creates a `ProposalReaction` with `reaction: "REACTION"` and `bodyMd`
   - Displayed as a threaded list below the proposal, sorted by createdAt
   - Each reaction shows: author name, time, body, and a "Resolve" button (visible only to proposal author)

3. **Objection section** (new, formal blocking):
   - Red-tinted button: "Raise Objection"
   - Opens a form requiring text explanation (bodyMd required)
   - Creates a `ProposalReaction` with `reaction: "OBJECTION"` and `bodyMd`
   - Objections are displayed prominently with a red border
   - Author can "Resolve" an objection (adds resolvedNote, sets resolvedAt)
   - **If any unresolved objections exist, the proposal cannot be approved**

### Part B: Author Resolution Flow

When a proposal author views reactions and objections:
- Each reaction/objection has a "Respond & Resolve" button
- Clicking opens an inline form: author writes a resolution note
- Submitting marks the reaction as resolved (sets `resolvedAt`, `resolvedNote`)
- For objections, resolving is mandatory before approval can proceed
- The author can optionally update the proposal body after addressing reactions

**New server actions:**

```typescript
// Post a reaction (replaces the old reactToProposalAction)
export async function postReactionAction(formData: FormData)
// formData: workspaceId, proposalId, reaction (SUPPORT|REACTION|OBJECTION), bodyMd

// Resolve a reaction (author only)
export async function resolveReactionAction(formData: FormData)
// formData: workspaceId, reactionId, resolvedNote

// Submit proposal for approval (with auto-approve timer)
export async function submitProposalForApprovalAction(formData: FormData)
// formData: workspaceId, proposalId, autoApproveHours (optional)
```

### Part C: Auto-Approval Timer

When submitting a proposal for approval:
1. Author can set an auto-approval window (default: 48h, configurable)
2. Sets `proposal.autoApproveAt = now() + autoApproveHours`
3. Display a countdown on the proposal: "Auto-approves in 23h 45m if no objections"
4. The worker/cron job (in `apps/worker/`) should pick up proposals where `autoApproveAt < now()` and `status = SUBMITTED` and no unresolved objections → set `status = APPROVED`

**Note**: The worker loop already exists in `apps/worker/`. Add a simple query to check for auto-approvable proposals.

### Part D: Circle-Scoped Visibility

Update the proposals list to filter by circle:
1. Add a circle filter dropdown at the top of the proposals page
2. Show "All Circles" by default, but allow filtering to specific circles
3. The `Proposal` model already has `circleId` — just filter on it
4. When creating a proposal, the circle selector is already present — keep it

**Domain changes** (`packages/domain/src/proposals.ts`):
- Update `listProposals()` to accept optional `circleId` filter
- Add validation: only circle members can raise objections on circle-scoped proposals

### Part E: Update Proposal Page UI

**proposals/page.tsx changes**:

Replace the current reaction buttons section with:
```
┌─────────────────────────────────────────┐
│ Proposal Title                   STATUS │
│ Summary text...                         │
│ Author · Date · 5 supports             │
│                                         │
│ ┌─ Objections (1 unresolved) ─────────┐ │
│ │ ⚠️ Dachi: This conflicts with...    │ │
│ │    [Resolve]                         │ │
│ └──────────────────────────────────────┘ │
│                                         │
│ ┌─ Reactions (3) ─────────────────────┐ │
│ │ 💬 Jan: What about the budget?      │ │
│ │    ✅ Resolved: Budget updated.     │ │
│ │ 💬 Andy: Great idea, +1             │ │
│ │ 💬 Daniel: Consider timeline        │ │
│ └──────────────────────────────────────┘ │
│                                         │
│ [👍 Support] [💬 React] [⚠️ Object]    │
│                                         │
│ Auto-approves in 23h if no objections   │
│ [Submit for Approval] [Start Advice]    │
└─────────────────────────────────────────┘
```

## Acceptance criteria

- [ ] ProposalReaction model updated: bodyMd, resolvedAt, resolvedNote fields added; unique constraint removed
- [ ] Proposal model updated: autoApproveAt field added
- [ ] Migration generated and applied successfully
- [ ] Support button works (one-click, no text needed)
- [ ] Reaction form allows posting text-based reactions (questions, concerns, suggestions)
- [ ] Objection form requires text and creates a blocking objection
- [ ] Reactions displayed as a threaded list with author, time, and text
- [ ] Unresolved objections prevent proposal approval
- [ ] Proposal author can resolve reactions and objections with a note
- [ ] Auto-approval timer: submitting with a time window sets autoApproveAt
- [ ] Auto-approval countdown displayed on the proposal
- [ ] Circle filter works on the proposals list page
- [ ] No TypeScript errors (`npm run typecheck`)
- [ ] No lint errors (`npm run lint`)

## Test plan

```
npm run prisma:migrate -- --name refine_proposal_governance
npm run prisma:generate
npm run check
npm run dev
# Manually verify:
# 1. Create a proposal
# 2. Post a reaction with text → appears in thread
# 3. Raise an objection with text → blocks approval
# 4. Author resolves objection with note → marked resolved
# 5. Support button → count updates
# 6. Submit with auto-approve → countdown shown
# 7. Circle filter on proposals page works
```

## Rollback

Schema changes require a revert migration. The changes are additive (new columns, removed unique constraint). Revert by adding the constraint back and dropping the new columns.

## Technical notes for the executor

- **Removing `@@unique([proposalId, userId])`** requires a migration that drops the unique index. Prisma handles this automatically.
- The existing `reactToProposalAction` in `apps/web/app/workspaces/[workspaceId]/actions.ts` should be refactored to the new `postReactionAction`.
- Keep backward compatibility: treat existing SUPPORT/QUESTION/CONCERN reactions as valid reads in the UI, but new reactions should use the SUPPORT/REACTION/OBJECTION vocabulary.
- The `Objection` model (lines 600-612 in schema) on `ApprovalFlow` is separate from ProposalReaction objections. Keep both — the ApprovalFlow `Objection` is for the formal approval flow, while `ProposalReaction` objections are the proposal-level discussion.
- Worker auto-approval: check `apps/worker/` for the existing job loop pattern. Add a simple periodic check.
- `AGENTS.md`
