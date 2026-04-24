# Plan: Agent Governance UI

## Goal
Implement a dedicated UI for Agent Governance under workspaces, extracting agent settings, budgets, and observability from existing generic settings/audit pages into a focused governance center.

## Out of scope
Any backend schema changes. This is purely a UI refactor and consolidation of existing capabilities.

## Files to touch
- `apps/web/lib/nav-config.ts`
- `apps/web/app/workspaces/[workspaceId]/agents/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/agents/AgentRegistryTab.tsx`
- `apps/web/app/workspaces/[workspaceId]/agents/AgentRegistryToggle.tsx`
- `apps/web/app/workspaces/[workspaceId]/agents/AgentModelOverride.tsx`
- `apps/web/app/workspaces/[workspaceId]/agents/AgentSpendLimits.tsx`
- `apps/web/app/workspaces/[workspaceId]/agents/AccessControlTab.tsx`
- `apps/web/app/workspaces/[workspaceId]/agents/ObservabilityTab.tsx`
- `apps/web/app/workspaces/[workspaceId]/agents/SpendControlTab.tsx`
- `apps/web/app/workspaces/[workspaceId]/agents/actions.ts`
- `apps/web/app/workspaces/[workspaceId]/settings/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/audit/page.tsx`
- `docs/assets/agent-gov-registry.png`
- `docs/assets/agent-gov-access.png`
- `docs/assets/agent-gov-observability.png`
- `docs/assets/agent-gov-spend.png`
- `docs/plans/feat-agent-governance-ui.md`

## Acceptance criteria
- [x] Added new nav group before "System" with "Agent Governance" link.
- [x] Changed Settings label from "Settings & Agents" to "Settings".
- [x] Created agents/page.tsx with dynamic forcing and 4 tabs.
- [x] Created AgentRegistryTab.tsx listing all AgentIdentities.
- [x] Created AccessControlTab.tsx with MCP and model overrides.
- [x] Created ObservabilityTab.tsx with agent traces.
- [x] Created SpendControlTab.tsx with AgentBudgetManager and cost dashboard.
- [x] Removed agent logic from settings/page.tsx (Agents tab removed).
- [x] Removed agent logic from audit/page.tsx (traces and cost tabs removed), added notice.
- [x] Verified npm run check passes.
- [x] Visual proof of the 4 tabs generated and attached.

## Test plan
```
npm run check
```

## Rollback
Pure UI code changes; simply rollback the commit.

## Labels this PR needs
