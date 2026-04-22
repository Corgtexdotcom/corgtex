# Plan: Strategic Goals — Schema & UI Foundation

## Goal

Add a goal alignment system that lets users create and visualize goals at three levels (Company → Circle → Personal) across multiple time cadences (Weekly through 10-Year). The workspace dashboard surfaces top-level goals with progress bars, and each member gets a "My Slice" view showing how their work connects upward to company objectives. This plan builds the data model, domain logic, UI pages, and a `GoalLink` bridge table that the future goal-pulse agent will use for automated progress tracking.

**Branch**: `feat/goals-schema-ui`

> **IMPORTANT — Rebase before starting**: Multiple open PRs (#20, #21, #22, #23) modify `prisma/schema.prisma`, `packages/domain/src/index.ts`, `apps/web/app/workspaces/[workspaceId]/page.tsx`, and `layout.tsx`. **Rebase onto the latest `main`** before starting work to avoid merge conflicts. If any of those PRs are still open when you start, resolve merge conflicts on the additive sections (they add lines to the same files in different places).

## Out of scope

- AI-powered gap analysis (future: `agent.goal-pulse`)
- Automated progress tracking via agents (future: `agent.goal-pulse`)
- Slicing Pie / equity allocation (CRINA-specific future work)
- Gantt charts, Kanban boards, or deep project management
- Integration with external PM tools (Jira/Linear/Asana)
- Cross-workspace goal aggregation
- Modification to the existing Cycle model (stays separate)

## Files to touch

- `prisma/schema.prisma`
- `prisma/migrations/**`
- `packages/domain/src/goals.ts`
- `packages/domain/src/index.ts`
- `apps/web/app/workspaces/[workspaceId]/goals/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/goals/actions.ts`
- `apps/web/app/workspaces/[workspaceId]/goals/GoalProgress.tsx`
- `apps/web/app/workspaces/[workspaceId]/goals/RecognitionCard.tsx`
- `apps/web/app/workspaces/[workspaceId]/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/layout.tsx`

## Schema changes

Add these enums and models to `prisma/schema.prisma`:

```prisma
enum GoalCadence {
  WEEKLY
  MONTHLY
  QUARTERLY
  ANNUAL
  FIVE_YEAR
  TEN_YEAR
}

enum GoalStatus {
  DRAFT
  ACTIVE
  ON_TRACK
  AT_RISK
  BEHIND
  COMPLETED
  ABANDONED
}

enum GoalLevel {
  COMPANY
  CIRCLE
  PERSONAL
}

model Goal {
  id              String      @id @default(uuid())
  workspaceId     String
  parentGoalId    String?
  circleId        String?
  ownerMemberId   String?
  title           String
  descriptionMd   String?     @db.Text
  level           GoalLevel   @default(COMPANY)
  cadence         GoalCadence @default(QUARTERLY)
  status          GoalStatus  @default(DRAFT)
  progressPercent Int         @default(0)
  targetDate      DateTime?
  startDate       DateTime?
  sortOrder       Int         @default(0)
  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt

  workspace     Workspace      @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  parentGoal    Goal?          @relation("GoalTree", fields: [parentGoalId], references: [id], onDelete: SetNull)
  childGoals    Goal[]         @relation("GoalTree")
  circle        Circle?        @relation(fields: [circleId], references: [id], onDelete: SetNull)
  ownerMember   Member?        @relation(fields: [ownerMemberId], references: [id], onDelete: SetNull)
  keyResults    KeyResult[]
  updates       GoalUpdate[]
  links         GoalLink[]
  recognitions  Recognition[]

  @@index([workspaceId, level, cadence])
  @@index([workspaceId, status])
  @@index([parentGoalId])
  @@index([circleId])
  @@index([ownerMemberId])
}

model KeyResult {
  id              String   @id @default(uuid())
  goalId          String
  title           String
  targetValue     Float?
  currentValue    Float?   @default(0)
  unit            String?
  progressPercent Int      @default(0)
  sortOrder       Int      @default(0)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  goal Goal @relation(fields: [goalId], references: [id], onDelete: Cascade)

  @@index([goalId])
}

model GoalUpdate {
  id             String      @id @default(uuid())
  goalId         String
  authorMemberId String?
  source         String      @default("human")
  bodyMd         String      @db.Text
  newProgress    Int?
  statusChange   GoalStatus?
  createdAt      DateTime    @default(now())

  goal Goal @relation(fields: [goalId], references: [id], onDelete: Cascade)

  @@index([goalId, createdAt])
}

model GoalLink {
  id         String   @id @default(uuid())
  goalId     String
  entityType String
  entityId   String
  confidence Float    @default(1.0)
  linkedBy   String   @default("human")
  createdAt  DateTime @default(now())

  goal Goal @relation(fields: [goalId], references: [id], onDelete: Cascade)

  @@unique([goalId, entityType, entityId])
  @@index([entityType, entityId])
}

model Recognition {
  id                String   @id @default(uuid())
  workspaceId       String
  goalId            String?
  recipientMemberId String
  authorMemberId    String
  title             String
  storyMd           String   @db.Text
  valueTags         String[]
  visibility        String   @default("WORKSPACE")
  createdAt         DateTime @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  goal      Goal?     @relation(fields: [goalId], references: [id], onDelete: SetNull)
  recipient Member    @relation("RecognitionRecipient", fields: [recipientMemberId], references: [id], onDelete: Cascade)
  author    Member    @relation("RecognitionAuthor", fields: [authorMemberId], references: [id], onDelete: Cascade)

  @@index([workspaceId, createdAt])
  @@index([recipientMemberId])
}
```

Add reverse relations to existing models:
- `Workspace`: add `goals Goal[]` and `recognitions Recognition[]`
- `Circle`: add `goals Goal[]`
- `Member`: add `ownedGoals Goal[]`, `goalUpdates GoalUpdate[]`, `recognitionsReceived Recognition[] @relation("RecognitionRecipient")`, `recognitionsGiven Recognition[] @relation("RecognitionAuthor")`

> **NOTE**: The Workspace model block is also modified by PRs #20 and #23 (adding `meetingInsights MeetingInsight[]` etc.). When rebasing, add the `goals` and `recognitions` lines next to the existing relation arrays — don't overwrite any relations other PRs added.

## Detailed implementation

### Part A: Domain Layer (`packages/domain/src/goals.ts`)

CRUD services following the same pattern as `actions.ts`, `tensions.ts`:

```typescript
// Goal CRUD
export async function createGoal(actor, params): Promise<Goal>
export async function updateGoal(actor, goalId, params): Promise<Goal>
export async function deleteGoal(actor, goalId): Promise<void>
export async function getGoal(actor, goalId): Promise<GoalWithRelations>
export async function listGoals(actor, workspaceId, filters?): Promise<Goal[]>
// filters: { level?, cadence?, circleId?, ownerMemberId?, status?, parentGoalId? }

// Key Result CRUD
export async function addKeyResult(actor, goalId, params): Promise<KeyResult>
export async function updateKeyResult(actor, krId, params): Promise<KeyResult>
export async function deleteKeyResult(actor, krId): Promise<void>

// Goal Updates
export async function postGoalUpdate(actor, goalId, params): Promise<GoalUpdate>

// Goal Links
export async function createGoalLink(actor, params): Promise<GoalLink>
export async function deleteGoalLink(actor, linkId): Promise<void>
export async function findGoalLinksForEntity(entityType, entityId): Promise<GoalLink[]>

// Progress computation
export async function recomputeGoalProgress(goalId): Promise<void>
// Logic: avg of KR progress → goal progress → recursively recompute parent

// Tree views
export async function getGoalTree(actor, workspaceId, opts?): Promise<GoalTreeNode[]>
// Company goals → child circle goals → child personal goals, filtered by cadence

export async function getMyGoalSlice(actor, memberId, workspaceId): Promise<GoalSlice>
// Member's personal goals → their circles' goals → company goals they connect to

// Recognition
export async function createRecognition(actor, params): Promise<Recognition>
export async function listRecognitions(actor, workspaceId, filters?): Promise<Recognition[]>
```

Each mutation should emit events (e.g. `goal.created`, `goal.updated`, `goal-link.created`) following the `events.ts` pattern — `prisma.event.create()` inside transactions. These events are what the future goal-pulse agent will react to.

Re-export from `packages/domain/src/index.ts` by adding `export * from "./goals";`.

### Part B: Goals Page (`apps/web/app/workspaces/[workspaceId]/goals/page.tsx`)

Must include `export const dynamic = "force-dynamic"`.

Layout with cadence tabs and two views:

**Cadence tabs**: `[10Y] [5Y] [Annual] [Quarterly] [Monthly] [Weekly]` — filters the tree by cadence.

**Tree View** (default):
- Hierarchical indented list: Company goals → Circle sub-goals → Personal sub-goals
- Each goal shows: title, owner avatar, animated progress bar, target date, status badge
- Key results shown inline with target/current values
- Expand/collapse per goal level
- Click goal → inline edit or detail panel

**My Slice View**:
- Shows the logged-in member's personal goals with upward contribution links
- "↗ contributes to: [Circle Goal] → [Company Goal]"
- Recent recognitions received shown at the bottom

### Part C: Server Actions (`goals/actions.ts`)

Server actions wrapping the domain functions. Follow the same pattern as other action files — use `getServerSession`, resolve actor, call domain function, `revalidatePath`.

Actions: `createGoalAction`, `updateGoalAction`, `deleteGoalAction`, `addKeyResultAction`, `updateKeyResultAction`, `deleteKeyResultAction`, `postGoalUpdateAction`, `createGoalLinkAction`, `deleteGoalLinkAction`, `createRecognitionAction`.

### Part D: Client Components

**GoalProgress.tsx** — Animated progress bar:
- CSS `transition: width 0.5s ease` for smooth animations
- Color: green (>70%), yellow (40-70%), red (<40%)

**RecognitionCard.tsx** — Recognition story card:
- Narrative-first: story text is prominent, not metrics
- Shows author, recipient avatar, value tags as subtle chips
- No leaderboards, no point counts — just the story

### Part E: Dashboard Integration (`page.tsx`)

Add a "Strategic Direction" section between the hero and existing content:
- Shows top-level COMPANY goals (all active cadences)
- Each with progress bar and days remaining
- "View All →" link to /goals
- Optional: one recent recognition card

> **NOTE**: PR #21 (cross-entity connectivity) also modifies this file — changes meeting filtering and adds a "View profile" link. These are in different sections and shouldn't functionally conflict, but resolve merge conflicts by keeping both changes.

### Part F: Navigation (`layout.tsx`)

Add "Goals" to the sidebar navigation. Use a target/bullseye icon. Place between existing nav items logically.

> **NOTE**: PR #22 (access management) adds a "Platform Admin" nav link to the same sidebar. These are additive — keep both.

## Acceptance criteria

- [ ] Goal, KeyResult, GoalUpdate, GoalLink, Recognition models created with proper migration
- [ ] GoalCadence enum supports WEEKLY, MONTHLY, QUARTERLY, ANNUAL, FIVE_YEAR, TEN_YEAR
- [ ] GoalLevel enum supports COMPANY, CIRCLE, PERSONAL
- [ ] CRUD operations for goals, key results, goal links, recognitions work
- [ ] `recomputeGoalProgress` correctly averages KR progress and rolls up to parent goals
- [ ] Events emitted for goal.created, goal.updated, goal-link.created
- [ ] Goals page shows hierarchical tree view with cadence-tab filtering
- [ ] "My Slice" view shows member's goals with upward contribution links
- [ ] Animated progress bars with color transitions (green/yellow/red)
- [ ] Recognition stories can be created and displayed (no leaderboards)
- [ ] Workspace homepage shows top-level goals in "Strategic Direction" section
- [ ] "Goals" link added to workspace navigation
- [ ] All new pages have `export const dynamic = "force-dynamic"`
- [ ] No TypeScript errors (`npm run typecheck`)
- [ ] No lint errors (`npm run lint`)
- [ ] Prisma validates (`npm run prisma:validate`)

## Test plan

```
npm run prisma:migrate -- --name add_goals_system
npm run prisma:generate
npm run check
npm run dev
```

Manual verification:
1. Navigate to Goals page
2. Create a company-level annual goal with key results
3. Create a circle-level quarterly sub-goal linked to it
4. Create a personal monthly goal linked to the circle goal
5. Update KR values → verify progress rolls up through the hierarchy
6. Create a GoalLink between an existing action and a goal
7. Post a goal update → verify timeline display
8. Switch to "My Slice" → verify upward contribution links
9. Create a recognition → verify it displays
10. View workspace homepage → "Strategic Direction" section shows
11. Verify "Goals" nav link works

## Rollback

All changes are additive — new tables, new pages. Revert by dropping Goal, KeyResult, GoalUpdate, GoalLink, Recognition tables and removing the navigation link / dashboard section. No existing functionality is modified.

## Labels this PR needs

- `forbidden-path-approved` — touches `prisma/migrations/**`

## Technical notes for the executor

- The existing `Cycle` model serves a different purpose (point-based peer allocation). Do NOT try to merge or refactor it. They coexist.
- Follow the `createAction`/`createTension` pattern in `packages/domain/src/actions.ts` for the domain service structure.
- Emit events using the same pattern as other domain functions.
- For the progress bar component, use only CSS transitions — no charting libraries needed.
- Keep the Cycle model totally untouched.
- All new pages must export `const dynamic = "force-dynamic"`.
- **Rebase onto latest main** before starting — this avoids conflicts with PRs #19-#23 that also modify `schema.prisma`, `index.ts`, `page.tsx`, and `layout.tsx`.
