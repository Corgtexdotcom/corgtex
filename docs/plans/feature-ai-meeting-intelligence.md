# Plan 2: AI-Powered Meeting Intelligence

## Goal

Build an AI pipeline that automatically extracts decisions, tensions, action items, and proposals from meeting transcripts — and presents them to a facilitator for quick review and confirmation. This eliminates the need for a human "secretary" role and is the #1 differentiator vs. competitors.

> **Stakeholder quote**: *"The next evolutionary step for tools like this would be I don't need the secretary anymore. I can just have the AI processing and getting all those topics and summarizing stuff and automatically updating what is inside the tool."*

## Context & What Exists

The codebase is at `/Users/janbrezina/Development /CORGTEX`.

### Current state
- **meetings.ts (domain)** — `createMeeting()`, `getMeeting()`, `listMeetings()`, `deleteMeeting()`. Meetings store `transcript`, `summaryMd`, and link to proposals/tensions.
- **Meeting model** — Has `transcript` (text), `summaryMd` (text), `participantIds` (string array). FK relations to `proposals[]` and `tensions[]`.
- **meetings/page.tsx** — Lists meetings, has "Ingest New Meeting" form (title, source, recordedAt, transcript, summary)
- **meetings/[meetingId]/page.tsx** — Shows meeting summary, linked tensions, linked proposals, and full transcript
- **Brain/AI infrastructure** — `packages/models/` has model gateways. `packages/agents/` has agent execution. The chat system can already query meeting context.
- **Existing extraction patterns** — The `brain.ts` domain file (~25KB) handles article synthesis, suggesting the AI extraction pattern already exists for articles. We should follow the same pattern.

### Key gaps
1. No automatic extraction of decisions/tensions/actions from transcripts
2. No facilitator review UI ("AI suggests, human confirms")
3. No structured decisions model (decisions happen in meetings but aren't captured)
4. No carry-forward items for next meetings
5. Meeting ingestion is manual (paste transcript) — no post-ingestion AI processing

## Out of scope

- External meeting tool API integration (Read AI, Fireflies, etc.) — that's a separate plan
- Real-time transcription during meetings
- Meeting scheduling or calendar integration
- Automatic participant matching to workspace members (just use participantIds for now)

## Files to touch

- `packages/domain/src/meetings.ts`
- `packages/domain/src/meeting-intelligence.ts`
- `packages/domain/src/meeting-intelligence.test.ts`
- `packages/domain/src/index.ts`
- `packages/domain/src/tensions.ts`
- `packages/domain/src/proposals.ts`
- `apps/web/app/workspaces/[workspaceId]/meetings/[meetingId]/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/meetings/[meetingId]/MeetingIntelligence.tsx`
- `apps/web/app/workspaces/[workspaceId]/meetings/actions.ts`
- `apps/web/app/workspaces/[workspaceId]/actions.ts`
- `prisma/schema.prisma`
- `prisma/migrations/20260421224945_add_meeting_insights/migration.sql`
- `prisma/migrations/20260421225310_add_meeting_insights/migration.sql`
- `docs/plans/feature-ai-meeting-intelligence.md`

## Schema changes

Add a `MeetingInsight` model to store AI-extracted items before they are confirmed:

```prisma
enum MeetingInsightType {
  DECISION
  TENSION
  ACTION_ITEM
  PROPOSAL
  FOLLOW_UP
}

enum MeetingInsightStatus {
  SUGGESTED    // AI extracted, awaiting review
  CONFIRMED    // Facilitator confirmed
  DISMISSED    // Facilitator dismissed
  APPLIED      // Created as actual tension/action/proposal
}

model MeetingInsight {
  id          String               @id @default(uuid())
  meetingId   String
  workspaceId String
  type        MeetingInsightType
  status      MeetingInsightStatus @default(SUGGESTED)
  title       String
  bodyMd      String?              @db.Text
  assigneeHint String?             // AI-suggested assignee (display name or role name)
  confidence  Float                @default(0.0)   // 0-1 confidence score
  sourceQuote String?              @db.Text  // Relevant transcript excerpt
  appliedEntityType String?        // "Tension", "Action", "Proposal"
  appliedEntityId   String?        // ID of created entity
  reviewedByUserId  String?
  reviewedAt  DateTime?
  createdAt   DateTime             @default(now())
  updatedAt   DateTime             @updatedAt

  meeting   Meeting   @relation(fields: [meetingId], references: [id], onDelete: Cascade)

  @@index([meetingId, status])
  @@index([workspaceId, type])
}
```

Also add to the `Meeting` model:
```prisma
model Meeting {
  // ... existing fields ...
  insights    MeetingInsight[]
  decisionsJson Json?            // Structured JSON of confirmed decisions
  aiProcessedAt DateTime?        // When AI processing completed
}
```

## Detailed Implementation

### Part A: AI Extraction Pipeline

**meeting-intelligence.ts** [NEW] — Domain service:

```typescript
export async function extractMeetingInsights(
  actor: AppActor,
  params: { workspaceId: string; meetingId: string }
): Promise<MeetingInsight[]>
```

This function:
1. Fetches the meeting transcript
2. Calls the LLM (use model gateway from `packages/models/`) with a structured extraction prompt
3. The prompt should ask the AI to extract, for each item:
   - Type (DECISION, TENSION, ACTION_ITEM, PROPOSAL, FOLLOW_UP)
   - Title (concise, one-line)
   - Body (detailed description in markdown)
   - Assignee hint (who was mentioned as responsible)
   - Confidence (how confident the AI is this is a real item)
   - Source quote (the transcript excerpt that supports this extraction)
4. Parse the structured JSON response
5. Batch-create `MeetingInsight` records with status `SUGGESTED`
6. Update the meeting's `aiProcessedAt` timestamp
7. Return the created insights

**Prompt design** — Use a system prompt like:
```
You are analyzing a meeting transcript for a self-managed organization.
Extract all:
- DECISIONS: Agreements or choices made during the meeting
- TENSIONS: Unresolved issues, concerns, or gaps identified
- ACTION_ITEMS: Tasks assigned to specific people with next steps
- PROPOSALS: New ideas or changes proposed for the organization
- FOLLOW_UPS: Items that need to be discussed in the next meeting

For each item, provide:
- type: one of DECISION, TENSION, ACTION_ITEM, PROPOSAL, FOLLOW_UP
- title: concise one-line summary
- body: detailed description in markdown
- assigneeHint: who is responsible (display name from transcript), or null
- confidence: 0.0-1.0 how confident you are
- sourceQuote: the relevant transcript excerpt (max 200 chars)

Return as a JSON array. Be conservative — only extract items you're confident about.
```

**Auto-trigger** — Optionally trigger extraction automatically when a meeting is created with a transcript. Add to `createMeeting()`:
```typescript
// After creating the meeting, queue AI extraction
await appendEvents(tx, [{
  type: "meeting.created",
  // ... existing event
}]);
// The worker can pick this up and run extractMeetingInsights
```

### Part B: Facilitator Review UI

**MeetingIntelligence.tsx** [NEW] — Client component for the review flow:

This component renders on the meeting detail page and shows:

1. **Banner**: "AI found X items from this meeting — review them below"
2. **Grouped sections** by type (Decisions, Tensions, Actions, Proposals, Follow-ups)
3. **Each insight card** shows:
   - Title (editable inline)
   - Body/description (editable)
   - Assignee hint
   - Confidence badge (high/medium/low with color)
   - Source quote (collapsible, highlighted)
   - Actions: ✅ Confirm, ✏️ Edit, ❌ Dismiss
4. **Bulk actions**: "Confirm All", "Confirm Decisions Only"
5. **Apply button**: For confirmed items, "Create as Tension / Action / Proposal" — which calls the domain function to actually create the entity and link it to the meeting

**Server actions** (in meetings actions.ts):

```typescript
// Trigger AI extraction
export async function extractInsightsAction(formData: FormData)

// Confirm a single insight
export async function confirmInsightAction(formData: FormData)

// Dismiss a single insight
export async function dismissInsightAction(formData: FormData)

// Apply a confirmed insight (create as tension/action/proposal)
export async function applyInsightAction(formData: FormData)

// Bulk confirm all suggested insights
export async function confirmAllInsightsAction(formData: FormData)
```

### Part C: Apply Insights → Create Entities

When a facilitator confirms and applies an insight:

**For ACTION_ITEM**:
- Call `createAction()` with title, bodyMd from the insight
- Try to match `assigneeHint` to a workspace member
- Set `meetingId` link (would need to add meetingId to Action model, or use a separate link)
- Update the insight: `status = APPLIED`, `appliedEntityType = "Action"`, `appliedEntityId = action.id`

**For TENSION**:
- Call `createTension()` with title, bodyMd
- Set `meetingId` (already exists on Tension model)
- Update insight status

**For PROPOSAL**:
- Call `createProposal()` with title, bodyMd
- Set `meetingId` (already exists on Proposal model)
- Update insight status

**For DECISION**:
- Store in `meeting.decisionsJson` as structured data
- Or create as an approved proposal (depends on workflow preference)
- Update insight status

**For FOLLOW_UP**:
- Create as an action item with a note that it's a follow-up for next meeting

### Part D: Meeting Detail Page Updates

Update `meetings/[meetingId]/page.tsx` to:
1. Fetch meeting insights along with existing data
2. Show the `<MeetingIntelligence>` component if there are SUGGESTED insights
3. Show confirmed/applied insights in a "Decisions & Outcomes" section
4. Add a "Run AI Extraction" button if no insights exist yet and a transcript is present
5. Show "AI Confidence Summary" — e.g. "12 items extracted, 10 confirmed, 2 dismissed"

## Acceptance criteria

- [x] New `MeetingInsight` model added with proper migration
- [x] `extractMeetingInsights()` domain function works: takes a meeting with transcript → creates SUGGESTED insights via LLM
- [x] Meeting detail page shows a "Run AI Extraction" button when transcript exists but no insights
- [x] After extraction, facilitator sees grouped insight cards with Confirm/Dismiss controls
- [x] Confirming an insight marks it as CONFIRMED
- [x] Applying a confirmed insight creates the corresponding entity (tension/action/proposal) linked to the meeting
- [x] Dismissed insights are hidden from the default view
- [x] Meeting detail page shows a "Decisions & Outcomes" section for confirmed/applied items
- [x] No TypeScript errors (`npm run typecheck`)
- [x] No lint errors (`npm run lint`)
- [x] Meeting model gets `aiProcessedAt` field via migration

## Test plan

```
npm run prisma:migrate -- --name add_meeting_insights
npm run prisma:generate
npm run check
npm run dev
# Manually verify:
# 1. Navigate to a meeting with a transcript
# 2. Click "Run AI Extraction"
# 3. AI insight cards appear grouped by type
# 4. Confirm an insight → status changes to CONFIRMED
# 5. Apply a tension insight → Tension is created, linked to meeting
# 6. Dismiss an insight → it disappears from view
# 7. Decisions section shows confirmed decisions
```

## Rollback

Schema changes require a revert migration. The `MeetingInsight` model is additive-only (no existing models modified destructively). Rolling back: drop the `MeetingInsight` table and remove the `aiProcessedAt`/`decisionsJson` columns from Meeting.

## Technical notes for the executor

- **Model gateway**: Check `packages/models/` for how to call the LLM. Look for patterns in `brain.ts` which already does AI extraction for articles.
- **Model selection**: The project currently uses **Gemma 4** as the primary model. For structured extraction tasks, prefer a model with strong JSON output capabilities. If Gemma 4 doesn't support structured output well, route through **OpenRouter** to a more capable model (e.g. Claude Sonnet or GPT-4o) for the extraction pipeline specifically — optimize for cost/performance.
- **JSON parsing**: Use structured output / JSON mode if available in the model gateway. Fall back to parsing markdown JSON blocks.
- **The meeting already has** `proposals[]` and `tensions[]` relations — extracted items should use these existing FK relationships when applied.
- **participantIds** is a string array — for assignee matching, compare against member display names fuzzy-matched.
- All new pages must have `export const dynamic = "force-dynamic"`.
- Follow existing server action patterns in `apps/web/app/workspaces/[workspaceId]/actions.ts`.
