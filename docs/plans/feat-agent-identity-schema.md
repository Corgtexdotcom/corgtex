# Plan: Agent Identity & Schema Foundation

{/*
  This file is the canonical handoff from Planner (Claude) to Executor
  (Gemini in Antigravity) and to Reviewer (Codex).
*/}

## Goal

Introduce a first-class `AgentIdentity` model that makes AI agents organizational members alongside humans. Each agent gets a unique identity with governance fields (purpose, behavioral config, per-agent budget limits, rate limits). Create the `CircleAgentAssignment` join table so agents can be placed in circles. Extend the `AppActor` type to support `agentIdentityId`. Build the agent.md behavioral config system (global workspace-level + per-agent markdown directives injected into system prompts at runtime). Add per-agent budget and rate limit enforcement in the agent runtime. This is the foundational schema layer that Plans 2 (Governance UI) and 3 (Circle Integration) depend on.

## Out of scope

- Governance UI pages (covered by `feat-agent-governance-ui`).
- Circle/org chart visualization with agents (covered by `feat-agent-circle-integration`).
- Compliance dashboard, regulatory reporting.
- Delegation chains (future iteration).
- User-created agents (future iteration — for now only admin/dev-created).
- Rigid policy engine — behavioral config is markdown-based (agent.md), not a rules engine.

## Files to touch

- `prisma/schema.prisma`
- `prisma/migrations/**`
- `packages/shared/src/types.ts`
- `packages/domain/src/agent-identity.ts`
- `packages/domain/src/agent-identity.test.ts`
- `packages/domain/src/index.ts`
- `packages/agents/src/runtime.ts`
- `packages/agents/src/runtime.test.ts`
- `packages/agents/src/check-in-agent.test.ts`
- `packages/agents/src/meeting-advisor.test.ts`
- `apps/web/app/api/workspaces/[workspaceId]/agent-identities/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/agent-identities/[agentId]/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/agent-identities/[agentId]/behavior/route.ts`
- `docs/plans/feat-agent-identity-schema.md`

## Acceptance criteria

- [x] `AgentMemberType` enum exists with values `INTERNAL` and `EXTERNAL`.
- [x] `AgentIdentity` model exists in schema with fields: `id`, `workspaceId`, `agentKey`, `memberType`, `displayName`, `avatarUrl`, `purposeMd`, `behaviorMd`, `isActive`, `createdByUserId`, `linkedCredentialId`, `maxSpendPerRunCents`, `maxRunsPerDay`, `maxRunsPerHour`, `createdAt`, `updatedAt`.
- [x] `AgentIdentity` has `@@unique([workspaceId, agentKey])` constraint.
- [x] `CircleAgentAssignment` model exists with fields: `id`, `circleId`, `agentIdentityId`, `roleId` (optional), `assignedAt`.
- [x] `CircleAgentAssignment` has `@@unique([circleId, agentIdentityId])` constraint.
- [x] Prisma migration generated and applies cleanly.
- [x] `AppActor`'s `AgentActor` type in `packages/shared/src/types.ts` extended with optional `agentIdentityId: string`.
- [x] New file `packages/domain/src/agent-identity.ts` exports: `createAgentIdentity`, `updateAgentIdentity`, `listAgentIdentities`, `getAgentIdentity`, `deactivateAgentIdentity`, `assignAgentToCircle`, `removeAgentFromCircle`, `updateAgentBehavior`, `getWorkspaceAgentBehavior`, `updateWorkspaceAgentBehavior`.
- [x] All domain functions require `AppActor` with ADMIN role for mutations.
- [x] `packages/agents/src/runtime.ts` `executeAgentRun` checks per-agent `maxSpendPerRunCents` and `maxRunsPerDay`/`maxRunsPerHour` before execution, skipping if limits exceeded.
- [x] Runtime injects global workspace agent.md and per-agent `behaviorMd` into the system prompt context when available.
- [x] API routes exist at `/api/workspaces/[workspaceId]/agent-identities` (GET list, POST create) and `/api/workspaces/[workspaceId]/agent-identities/[agentId]` (GET, PATCH, DELETE).
- [x] API route at `/api/workspaces/[workspaceId]/agent-identities/[agentId]/behavior` (GET, PUT) for agent.md management.
- [x] Unit tests in `packages/domain/src/agent-identity.test.ts` cover: create, list, update, deactivate, circle assignment/removal, behavior update.
- [x] All new functions exported from `packages/domain/src/index.ts`.
- [x] `npm run check` (lint + typecheck + prisma validate) passes.

## Test plan

```
npm run check
npx vitest run packages/domain/src/agent-identity.test.ts
npx vitest run packages/agents/src/runtime.test.ts
```

## Rollback

Revert the PR. Run `prisma migrate` to revert the migration if needed. The `AgentIdentity` and `CircleAgentAssignment` tables are new — dropping them has no cascading effect on existing data. The `AppActor` type change is additive (optional field) and has no runtime impact if reverted.

## Labels this PR needs

- `forbidden-path-approved` — touches `prisma/migrations/**`.
- `large-change-approved` — new domain module + API routes + schema changes likely exceed 400 LOC.
