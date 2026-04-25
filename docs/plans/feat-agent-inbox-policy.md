# Plan: Agent Inbox and Plain-Text Policy

## Goal
Elevate Agent Governance by replacing rigid hardcoded toggles with versioned, plain-text governance policies per agent, and introducing an "Agent Inbox" tab. The inbox treats `WAITING_APPROVAL` states as "Agents asking humans for input" rather than bureaucratic gates, fostering a more conversational human-in-the-loop workflow.

## Out of scope
- Cryptographic signing of audit logs (V1 relies on simple exports, to be done later).
- Visual Access Topology map (P1 phase, out of scope for this PR).
- Model-layer interception/active guardrails using LLM gateways.

## Files to touch
- `prisma/schema.prisma`
- `prisma/migrations/**`
- `apps/web/app/[locale]/workspaces/[workspaceId]/agents/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/agents/AgentInboxTab.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/agents/AgentRegistryTab.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/agents/actions.ts`
- `packages/domain/src/agent-config.ts`
- `packages/domain/src/agent-runs.ts`
- `packages/domain/src/agent-config.test.ts`
- `packages/domain/src/agent-runs.test.ts`
- `docs/assets/visual_proof_agent_inbox.png`
- `docs/plans/feat-agent-inbox-policy.md`

## Acceptance criteria
- [x] `WorkspaceAgentConfig` has a `governancePolicy` string field in Prisma.
- [x] `AgentRunStep` has a `humanFeedback` string field in Prisma.
- [x] Agent Governance page has a high-level summary dashboard above the tabs.
- [x] New "Inbox" tab displays agent runs in `WAITING_APPROVAL` / `NEEDS_INPUT`.
- [x] Inbox items show the agent's context and allow humans to submit free-text feedback.
- [x] Registry tab allows editing and saving plain-text governance policies per agent.
- [x] Tests and linters pass (`npm run check`).

## Test plan
```
npm run check
npm run test:unit
```

## Rollback
1. Run `git revert <merge-commit-sha>`
2. Deploy the reverted code.
3. No destructive data changes are made (only adding fields), so database rollback is not strictly required.

## Labels this PR needs
- `forbidden-path-approved` (touches `prisma/migrations/**` via migration)
