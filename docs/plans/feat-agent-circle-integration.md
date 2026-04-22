# Agent Circle Integration

Integrate AI agents into the workspace governance structure as first-class members.

## Acceptance criteria

- [x] Agent Profile page exists at `/workspaces/[workspaceId]/agents/[agentId]`.
- [x] Profile shows agent key, behavior textarea, and circle assignment list.
- [x] `AgentIdentity` includes `memberType`: `INTERNAL` vs `EXTERNAL`.
- [x] `credentialAgentAuthProvider` automatically links external identities based on `ext_[linkedId]`.
- [x] Agents can be selected from a drop-down and assigned to circles (in Profile or in Circles page).
- [x] Members page lists Agent Members separately from human members.

## Files to touch

- `apps/web/app/workspaces/[workspaceId]/circles/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/members/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/agents/[agentId]/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/agents/[agentId]/AgentProfileClient.tsx`
- `apps/web/app/workspaces/[workspaceId]/agents/[agentId]/actions.ts`
- `packages/domain/src/agent-auth.ts`
- `packages/domain/src/agent-identity.ts`
- `scripts/seed-agent-identities.ts`
- `docs/plans/feat-agent-circle-integration.md`
