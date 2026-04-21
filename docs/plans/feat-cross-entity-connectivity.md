# Plan 5: Cross-Entity Connectivity ("Connecting the Dots")

## Goal

Build the connective tissue between meetings, decisions, roles, and people so that every entity in the system shows its relationships. The centerpiece is a **Member Profile Page** that shows everything about a person — circles, roles, meetings, decisions, actions — and a **Personalized AI Briefing** that surfaces what's relevant to each user.

> **Stakeholder quote**: *"Inside this meeting we decide something… this has to be connected with my role because we were together in this meeting. So somehow it can have my role connected with the decisions we are taking."*

## Context & What Exists

The codebase is at `/Users/janbrezina/Development /CORGTEX`.

### Current state
- **Member model** — Links User to Workspace. Has relations to: roleAssignments, assignedActions, assignedTensions, approvalDecisions, brainArticles, adviceProcesses, expertise, checkIns, impactFootprints.
- **Meeting model** — Has `participantIds` (string array of user IDs). Links to proposals[] and tensions[].
- **members/[memberId]/** — Directory exists but need to check what's there.
- **Workspace dashboard** — Shows generic to-dos, active tensions, meetings, and knowledge. Not personalized to the current user.
- **Brain chat** — Can query meeting context. Has some personalization via actor context.
- **CheckIn model** — Stores periodic check-in questions and responses per member.

### Key gaps
1. No member profile page showing a holistic view of a person's involvement
2. Meeting participant data (`participantIds`) isn't used to link people → meetings in the UI
3. No personalized briefing based on role/circle/meeting context
4. No cross-reference sidebar on meetings/tensions/proposals showing related entities
5. Decisions (from meetings) don't backlink to the roles that contributed

## Out of scope

- Real-time notifications or push updates
- Updating the ChatBot/AI conversation context (that's a separate system)
- Agent profile pages (agents are a separate entity type)
- Meeting scheduling or calendar views

## Files to touch

- `packages/domain/src/members.ts`
- `packages/domain/src/member-briefing.ts`
- `packages/domain/src/index.ts`
- `apps/web/app/workspaces/[workspaceId]/members/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/members/[memberId]/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/members/[memberId]/MemberBriefing.tsx`
- `apps/web/app/workspaces/[workspaceId]/meetings/[meetingId]/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/layout.tsx`
- `apps/web/lib/nav-config.ts`
- `apps/web/app/workspaces/[workspaceId]/members/[memberId]/actions.ts`
- `packages/domain/src/meetings.ts`
- `packages/domain/src/member-briefing.test.ts`
- `docs/plans/feat-cross-entity-connectivity.md`

**Justification for large-change-approved**: The profile page is comprehensive and requires multiple files to properly render all tabs (actions, meetings, roles), resulting in >400 LOC.

## Schema changes

None required. All the data relationships already exist in the schema:
- `Member` → `RoleAssignment` → `Role` → `Circle`
- `Meeting.participantIds` (string[]) — join on User.id
- `Tension.assigneeMemberId`, `Action.assigneeMemberId`
- `Proposal.authorUserId`

## Detailed Implementation

### Part A: Team Directory Page

**members/page.tsx**:

A team directory showing all workspace members:

```
┌──────────────────────────────────────────────────┐
│ Team Directory                                   │
│ 5 members                                        │
│                                                  │
│ ┌─────────────────────────────────────────────┐  │
│ │ [JB] Jan Brezina              ADMIN         │  │
│ │      Tech Lead · 3 circles · 2 roles        │  │
│ │      Last active: today                     │  │
│ └─────────────────────────────────────────────┘  │
│ ┌─────────────────────────────────────────────┐  │
│ │ [DD] Dachi Durrant            CONTRIBUTOR   │  │
│ │      Facilitator · 2 circles · 3 roles      │  │
│ │      Last active: yesterday                 │  │
│ └─────────────────────────────────────────────┘  │
│ ...                                              │
└──────────────────────────────────────────────────┘
```

Each card links to the member profile page.

**Domain function** (`members.ts`):
```typescript
export async function listMembersWithSummary(workspaceId: string) {
  // Fetch members with:
  // - user info (displayName, email)
  // - role assignment count
  // - distinct circle count (via role assignments)
  // - last session lastSeenAt (approximate activity)
}
```

### Part B: Member Profile Page

**members/[memberId]/page.tsx** — Comprehensive profile for a workspace member:

**Layout**:
```
┌──────────────────────────────────────────────────┐
│ ← Back to Team                                   │
│                                                  │
│ [JB] Jan Brezina                                 │
│ jan@corgtex.com · Admin                          │
│ Member since Jan 2026                            │
│                                                  │
│ ═══════════════════════════════════════════       │
│                                                  │
│ CIRCLES & ROLES (3 circles, 5 roles)             │
│ ┌──────────────────────────────────────────┐     │
│ │ 🔵 General Circle                        │     │
│ │   - Tech Lead (accountabilities...)      │     │
│ │   - Facilitator                          │     │
│ │ 🔵 Operations Circle                     │     │
│ │   - Due Diligence Lead                   │     │
│ └──────────────────────────────────────────┘     │
│                                                  │
│ RECENT MEETINGS (participated)                   │
│ • Apr 21 — Meeting with Dachi                    │
│ • Apr 18 — Board Meeting Q1 Review               │
│ • Apr 15 — Corporate Rebels Kickoff              │
│                                                  │
│ OPEN ACTIONS (assigned)                          │
│ • Due diligence checklist (IN_PROGRESS)           │
│ • Update platform for multi-tenant (OPEN)         │
│                                                  │
│ ACTIVE TENSIONS (authored or assigned)            │
│ • Missing org chart visualization                 │
│ • Need better meeting capture                     │
│                                                  │
│ RECENT PROPOSALS (authored)                      │
│ • Monthly role review meetings (SUBMITTED)        │
│                                                  │
│ AI BRIEFING                                      │
│ ┌──────────────────────────────────────────┐     │
│ │ Based on your roles and recent meetings: │     │
│ │ • Due diligence is your top priority...  │     │
│ │ • The platform goal is 80% complete...   │     │
│ │ • Consider following up on...            │     │
│ └──────────────────────────────────────────┘     │
└──────────────────────────────────────────────────┘
```

**Domain function** (`members.ts`):
```typescript
export async function getMemberProfile(workspaceId: string, memberId: string) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: {
      user: true,
      roleAssignments: {
        include: {
          role: {
            include: { circle: true }
          }
        }
      },
      assignedActions: {
        where: { status: { in: ["OPEN", "IN_PROGRESS"] } },
        orderBy: { updatedAt: "desc" },
        take: 10,
      },
      assignedTensions: {
        where: { status: { in: ["OPEN", "IN_PROGRESS"] } },
        orderBy: { updatedAt: "desc" },
        take: 10,
      },
    },
  });

  // Fetch meetings where this user participated
  const meetings = await prisma.meeting.findMany({
    where: {
      workspaceId,
      participantIds: { has: member.userId },
    },
    orderBy: { recordedAt: "desc" },
    take: 10,
  });

  // Fetch authored proposals
  const proposals = await prisma.proposal.findMany({
    where: {
      workspaceId,
      authorUserId: member.userId,
      status: { in: ["DRAFT", "SUBMITTED", "ADVICE_GATHERING"] },
    },
    orderBy: { updatedAt: "desc" },
    take: 10,
  });

  // Fetch authored tensions
  const authoredTensions = await prisma.tension.findMany({
    where: {
      workspaceId,
      authorUserId: member.userId,
      status: { in: ["OPEN", "IN_PROGRESS"] },
    },
    orderBy: { updatedAt: "desc" },
    take: 10,
  });

  return { member, meetings, proposals, authoredTensions };
}
```

### Part C: Personalized AI Briefing

**member-briefing.ts**:

```typescript
export async function generateMemberBriefing(
  actor: AppActor,
  workspaceId: string,
  memberId: string
): Promise<{
  summary: string;
  priorities: string[];
  followUps: string[];
  insights: string[];
}>
```

This function:
1. Fetches the member's profile data (roles, circles, meetings, actions, tensions)
2. Fetches recent meeting summaries the member participated in (last 2 weeks)
3. Fetches recent activity from the member's circles
4. Calls LLM with prompt:
   ```
   You are generating a personalized briefing for {displayName} who holds these roles:
   {roles list}

   Recent meetings they attended:
   {meeting summaries}

   Their open actions:
   {actions}

   Their open tensions:
   {tensions}

   Generate a brief, actionable briefing with:
   - 1-2 sentence summary of their current situation
   - Top 3 priorities for this week
   - Follow-up items from recent meetings
   - Any insights or connections they should be aware of
   ```
5. Return the structured briefing

**MemberBriefing.tsx**:
- Shows the AI briefing with sections: Summary, Priorities, Follow-ups, Insights
- Has a "Regenerate" button to refresh
- Uses the existing api route pattern for calling server functions from client components

### Part D: Meeting Page — Participant Panel

Update `meetings/[meetingId]/page.tsx`:

Add a "Participants" section that resolves `participantIds` to actual member profiles:

```
PARTICIPANTS (3)
┌──────────────────────────────────────┐
│ [JB] Jan Brezina  →  View Profile   │
│      Tech Lead, General Circle      │
│ [DD] Dachi Durrant →  View Profile  │
│      Facilitator, People Circle     │
│ [AD] Andy Durrant  →  View Profile  │
│      Operations Lead                │
└──────────────────────────────────────┘
```

This requires resolving `participantIds` (user IDs) to member records with their role descriptions.

**Domain function** (`meetings.ts`):
```typescript
export async function getMeetingParticipants(workspaceId: string, participantIds: string[]) {
  return prisma.member.findMany({
    where: {
      workspaceId,
      userId: { in: participantIds },
    },
    include: {
      user: { select: { displayName: true, email: true } },
      roleAssignments: {
        include: {
          role: { select: { name: true } },
        },
      },
    },
  });
}
```

### Part E: Dashboard Personalization

Update `page.tsx` (workspace homepage):

The "Your To-Dos" section already filters by actor. Enhance it:

1. **"Your Meetings" section**: Show only meetings where the current user is a participant (instead of all recent meetings)
2. **"Your Circles" section**: Show activity from circles the user belongs to
3. **Quick link**: "View your full profile →" linking to their member page

This is a lightweight change — just filter the existing queries by the current user's member ID.

### Part F: Cross-Reference Sidebar (Lightweight)

On the meeting detail page, add a "Related" sidebar:
- If the meeting has linked proposals → show them
- If the meeting has linked tensions → show them
- If any actions reference this meeting → show them
- These links already exist via FK relations — just surface them better

This is already partially done (meeting detail shows tensions and proposals). The enhancement is making it bidirectional and more visible.

## Acceptance criteria

- [x] Team directory page shows all workspace members with circle/role summary
- [x] Member profile page shows: user info, circles & roles, recent meetings, open actions, active tensions, authored proposals
- [x] Meetings where a member participated are correctly identified via `participantIds`
- [x] AI briefing generates personalized context for a member based on their roles and activity
- [x] Member profile is accessible from: team directory, circle graph (Plan 1), meeting participants
- [x] Meeting detail page shows resolved participant profiles (not just IDs)
- [x] Workspace dashboard "Your Meetings" shows only meetings the current user attended
- [x] "Members" link in workspace navigation works
- [x] No TypeScript errors (`npm run typecheck`)
- [x] No lint errors (`npm run lint`)

## Test plan

```
npm run check
npm run dev
# Manually verify:
# 1. Navigate to Members → Team Directory
# 2. Click a member → Profile page shows all sections
# 3. Circles & Roles section shows correct assignments
# 4. Recent Meetings shows meetings where participantIds includes the user
# 5. AI Briefing generates personalized content
# 6. Meeting detail page shows participant profiles
# 7. Dashboard shows personalized meeting list
```

## Rollback

No schema changes. Pure frontend + new domain functions. Safe to revert by reverting code changes.

## Technical notes for the executor
- participantIds is a String[] stored on the Meeting model. Use { has: userId } for Prisma filtering.
- The AI briefing should be generated on-demand (button click)
- Ensure all new pages use force-dynamic.

