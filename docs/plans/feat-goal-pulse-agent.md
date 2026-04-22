# Plan: Goal Pulse Agent — Automated Progress Tracking

## Goal

Add a `goal-pulse` agent that reacts to platform events (action completed, meeting ingested, tension created) and automatically updates goal progress. When an action linked to a goal is completed, the agent recomputes progress. When a meeting mentions goal-relevant updates, the agent posts a GoalUpdate. This makes the goal system "hands-off" — humans set the goals, agents keep the numbers current.

**Branch**: `feat/goal-pulse-agent`

**Depends on**: `feat/goals-schema-ui` (Phase 1) must be merged first. That plan creates the Goal, KeyResult, GoalUpdate, GoalLink models and the `recomputeGoalProgress()` domain function this agent calls.

> **IMPORTANT — MeetingInsight synergy**: If PR #23 (`feature/ai-meeting-intelligence`) is merged before this plan executes, the meeting analysis path should read from the `MeetingInsight` table instead of re-parsing transcripts. This saves ~2K tokens per meeting since `extractMeetingInsights()` already identifies actions, tensions, decisions, and follow-ups with confidence scores. The agent should check for existing `MeetingInsight` records first and only fall back to LLM analysis if none exist.

## Out of scope

- Weekly scheduled review agent (future Phase 3 work)
- Auto-goal-suggestion from meetings (future Phase 3)
- Auto-recognition from goal completion (future Phase 3)
- Daily digest integration for goals (future Phase 3)
- UI changes beyond what Phase 1 already built
- Slicing Pie / equity allocation

## Files to touch

- `packages/domain/src/agent-registry.ts`
- `packages/domain/src/goals.ts`
- `packages/domain/src/index.ts`
- `packages/agents/src/runtime.ts`
- `packages/agents/src/tools/mutations.ts`
- `packages/workflows/src/outbox.ts`

## Detailed implementation

### Part A: Register the agent (`packages/domain/src/agent-registry.ts`)

Add `"goal-pulse"` to `AGENT_REGISTRY` (currently has 13 agents — inbox-triage, meeting-summary, action-extraction, proposal-drafting, constitution-update-trigger, constitution-synthesis, finance-reconciliation-prep, brain-absorb, brain-maintenance, daily-check-in, advice-routing, process-linting, spend-submission, daily-digest):

```typescript
"goal-pulse": {
  label: "Goal Pulse",
  description: "Reacts to platform events and auto-updates goal progress. Recomputes KR values from linked entity status, posts GoalUpdates from meeting mentions.",
  category: "operations",
  canDisable: true,
  defaultModelTier: "fast" as const,
  costTier: "low" as const,
  inputs: ["goal links", "entity status changes", "meeting summaries"],
  outputs: ["updated goal progress", "goal updates"],
},
```

### Part B: Add event triggers (`packages/workflows/src/outbox.ts`)

Add to `deriveJobsForEvent()` — new event types that trigger the goal-pulse agent. Add after the existing event handlers (currently the last one is `checkin.response_received` at ~line 475 and the KNOWLEDGE_PULSE and TRIAGE blocks):

```typescript
// === Goal Pulse: auto-update goal progress on entity status changes ===
if (event.workspaceId && (
  event.type === "action.updated" ||
  event.type === "tension.updated" ||
  event.type === "tension.created"
)) {
  jobs.push({
    workspaceId: event.workspaceId,
    eventId: event.id,
    type: "agent.goal-pulse",
    payload: {
      eventType: event.type,
      entityType: event.aggregateType ?? null,
      entityId: event.aggregateId ?? null,
    },
    dedupeKey: `${event.id}:goal-pulse`,
  });
}

// For meeting events, depend on action-extraction completing first
if (event.workspaceId && event.type === "meeting.created") {
  const meetingPayload = event.payload as { meetingId?: string };
  if (meetingPayload.meetingId) {
    jobs.push({
      workspaceId: event.workspaceId,
      eventId: event.id,
      type: "agent.goal-pulse",
      payload: {
        eventType: event.type,
        entityType: "Meeting",
        entityId: meetingPayload.meetingId,
      },
      dependsOnDedupeKey: `${event.id}:action-extraction`,
      dedupeKey: `${event.id}:goal-pulse`,
    });
  }
}

// When a goal-link is created, recompute
if (event.workspaceId && event.type === "goal-link.created") {
  const linkPayload = event.payload as { goalId?: string };
  if (linkPayload.goalId) {
    jobs.push({
      workspaceId: event.workspaceId,
      eventId: event.id,
      type: "agent.goal-pulse",
      payload: {
        eventType: event.type,
        entityType: "GoalLink",
        entityId: linkPayload.goalId,
      },
      dedupeKey: `${event.id}:goal-pulse`,
    });
  }
}
```

**Key design**: The meeting-triggered goal-pulse `dependsOn` action-extraction (dedupeKey `${event.id}:action-extraction`), which already `dependsOn` meeting-summary. Chain: `meeting.created → meeting-summary → action-extraction → goal-pulse`.

### Part C: Implement the agent (`packages/agents/src/runtime.ts`)

Add `runGoalPulseAgent()` following the `executeAgentRun` pattern (same as `runInboxTriageAgent` at ~line 315). The agent has TWO paths:

**Path 1 — Math-only** (when entity has GoalLinks): Look up GoalLinks, call `recomputeGoalProgress()`, post GoalUpdate. Zero LLM tokens.

**Path 2 — LLM-assisted** (meeting without direct links): If `MeetingInsight` records exist (from PR #23), use those. Otherwise, call LLM to extract goal-relevant mentions from the meeting summary, match against active goals, post GoalUpdates.

```typescript
export async function runGoalPulseAgent(params: {
  workspaceId: string;
  triggerRef: string;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  triggerType?: AgentTriggerType;
}) {
  return executeAgentRun({
    agentKey: "goal-pulse",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "EVENT",
    triggerRef: params.triggerRef,
    goal: "Update goal progress based on platform activity.",
    payload: {
      eventType: params.eventType,
      entityType: params.entityType,
      entityId: params.entityId,
    },
    plan: ["find-linked-goals", "assess-impact", "update-progress"],
    buildContext: async (helpers) => {
      // 1. Find GoalLinks for this entity
      // 2. If entity is a Meeting and no GoalLinks: check for MeetingInsight records first
      // 3. If no MeetingInsight records: load active goals + meeting summary for LLM analysis
      // 4. Load the entity itself for status info
    },
    execute: async (context, helpers, runId, model) => {
      // PATH 1 (math-only): GoalLinks exist → recomputeGoalProgress() → post GoalUpdate → 0 tokens
      // PATH 2 (meeting + MeetingInsight): use existing insights to match goals → post GoalUpdates → 0 tokens
      // PATH 3 (meeting + no insights): call LLM to extract goal mentions → ~3K tokens
      // PATH 4 (no-op): no links, no meeting → return early
    },
  });
}
```

### Part D: Wire into job dispatcher (`packages/agents/src/runtime.ts`)

Add dispatch in `runAgentWorkflowJob()` (currently at ~line 1181). Add before the final `return null` at the bottom:

```typescript
if (job.type === "agent.goal-pulse") {
  return runGoalPulseAgent({
    workspaceId: job.workspaceId,
    triggerRef: job.id,
    eventType: asString(payload.eventType),
    entityType: asString(payload.entityType) || null,
    entityId: asString(payload.entityId) || null,
    triggerType: "EVENT",
  });
}
```

The existing catch-all at line ~1081 (`if (job.type.startsWith("agent."))`) would also handle this, but an explicit handler is cleaner for logging and error handling.

### Part E: Add goal mutation tools for agents (`packages/agents/src/tools/mutations.ts`)

Add `createGoalLinkTool` and `postGoalUpdateTool` with corresponding action functions (`createGoalLinkAction`, `postGoalUpdateAction`). Follow the same pattern as the existing `createTensionTool`/`createTensionAction` at ~line 7.

This allows the conversation agent and other agents to also link entities to goals via tool calls.

### Part F: Enhance `goals.ts` for agent use

Ensure `recomputeGoalProgress()` and `postGoalUpdate()` can be called with a system actor (`{ type: "system", workspaceId }`) since agents don't have a user session. The Phase 1 domain functions should already support this if following the existing `createAction`/`createTension` pattern.

## Expected token cost per event

| Event trigger | LLM call? | Estimated tokens | Cost |
|:-------------|:----------|:----------------|:-----|
| `action.updated` (has GoalLink) | **No** — pure math | 0 | $0.00 |
| `tension.created` (has GoalLink) | **No** — pure math | 0 | $0.00 |
| `tension.updated` (has GoalLink) | **No** — pure math | 0 | $0.00 |
| `goal-link.created` | **No** — pure math | 0 | $0.00 |
| `meeting.created` (has MeetingInsight records) | **No** — reads existing data | 0 | $0.00 |
| `meeting.created` (no insights, no GoalLinks) | **Yes** — LLM extraction | ~3K | ~$0.003 |

**Monthly estimate for 20-person team**: If PR #23 is merged, nearly **$0/month** since MeetingInsights handle the extraction. Without PR #23: ~10 meetings × $0.003 = **$0.03/month**.

## Acceptance criteria

- [ ] `"goal-pulse"` registered in `AGENT_REGISTRY` with `costTier: "low"`, `defaultModelTier: "fast"`, `canDisable: true`
- [ ] `deriveJobsForEvent()` enqueues `agent.goal-pulse` for `action.updated`, `tension.updated`, `tension.created`, `meeting.created`, `goal-link.created`
- [ ] Meeting-triggered goal-pulse `dependsOn` action-extraction (via `dependsOnDedupeKey`)
- [ ] `runGoalPulseAgent()` implements math-only path: entity with GoalLink → recompute progress → post GoalUpdate
- [ ] `runGoalPulseAgent()` implements meeting path: check MeetingInsight → fallback to LLM → match active goals → post GoalUpdates
- [ ] `createGoalLinkTool` and `postGoalUpdateTool` added to agent mutations
- [ ] Action handler functions (`createGoalLinkAction`, `postGoalUpdateAction`) implemented
- [ ] `runAgentWorkflowJob()` dispatches `agent.goal-pulse` to `runGoalPulseAgent()`
- [ ] Math-only updates use 0 tokens
- [ ] LLM meeting analysis uses ≤5K tokens per meeting
- [ ] No TypeScript errors (`npm run typecheck`)
- [ ] No lint errors (`npm run lint`)

## Test plan

```
npm run check
npm run dev
```

Manual verification:
1. Create a goal with key results (Phase 1 UI)
2. Create a GoalLink between an existing action and the goal
3. Complete the action → verify goal-pulse agent fires → progress updates automatically
4. Upload/create a meeting that mentions an active goal → verify GoalUpdate posted
5. Check agent run logs → verify math-only path uses 0 tokens
6. Check agent run logs → verify meeting path uses <5K tokens
7. Disable goal-pulse agent in agent config → verify it stops running

## Rollback

No schema changes in this plan. Remove the agent registration from `AGENT_REGISTRY`, remove the event triggers from `deriveJobsForEvent()`, remove the `runGoalPulseAgent()` function and its dispatch. All goal data created by the agent (GoalUpdates with `source="agent:goal-pulse"`) can be cleaned up with a simple query.

## Labels this PR needs

(none — no forbidden paths touched)

## Technical notes for the executor

- The `goal-pulse` agent has TWO main paths: **math-only** (zero LLM cost) and **LLM-assisted** (meeting analysis). The math path should be the common case.
- `recomputeGoalProgress(goalId)` is a domain function from Phase 1. Import it from `@corgtex/domain` — don't re-implement.
- Follow the exact pattern of `runInboxTriageAgent` for the agent structure. Use `executeAgentRun()`.
- The `dependsOnDedupeKey` mechanism ensures goal-pulse runs AFTER action-extraction. This is critical.
- Use `"fast"` model tier for LLM calls.
- When posting GoalUpdates, use `source: "agent:goal-pulse"` to distinguish from human updates.
- **MeetingInsight integration**: If the `MeetingInsight` model exists in the schema (from PR #23), query it first: `prisma.meetingInsight.findMany({ where: { meetingId, status: { in: ["CONFIRMED", "APPLIED"] } } })`. Map insight titles against active goal titles for matching. This avoids duplicate LLM calls.
