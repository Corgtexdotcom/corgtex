# I18n Phase 2 Migration

The goal of this phase is to complete the localization of the remaining modules (Admin, Finance, Governance, Operator, Circles, Cycles, Leads, Actions, Meetings, Tensions, Proposals, Chat, Agents, Brain) by implementing `next-intl` throughout the codebase, removing all hardcoded text strings in favor of robust namespaces in `en.json` and `es.json`.

## Risk tier

`standard`

## Files to touch

- `apps/web/app/[locale]/error.tsx`
- `apps/web/app/[locale]/oauth/authorize/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/CommandMenuButton.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/actions/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/admin/AdminDashboardClient.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/admin/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/agents/AgentInboxTab.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/agents/[agentId]/AgentProfileClient.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/agents/[agentId]/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/audit/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/brain/[slug]/edit/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/brain/[slug]/history/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/brain/sources/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/brain/status/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/chat/ChatInterface.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/chat/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/circles/CircleDetailPanel.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/circles/ExpandedCircleNode.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/circles/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/cycles/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/finance/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/governance/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/leads/DealStageSelect.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/leads/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/meetings/[meetingId]/MeetingIntelligence.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/meetings/[meetingId]/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/meetings/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/members/[memberId]/MemberBriefing.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/operator/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/proposals/[proposalId]/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/proposals/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/tensions/[tensionId]/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/tensions/page.tsx`
- `apps/web/app/[locale]/workspaces/create/page.tsx`
- `apps/web/messages/en.json`
- `apps/web/messages/es.json`
- `docs/assets/i18n-phase2/proof.png`

## Test plan

- `npm run check` passes.
- English and Spanish JSON files are 100% in sync with valid keys.

## Acceptance criteria

- [x] All remaining pages in `apps/web/app/[locale]/workspaces/[workspaceId]/**` use `next-intl`
- [x] No hardcoded UI strings remain in the touched files
- [x] All keys in `en.json` and `es.json` sync perfectly
- [x] CI is fully green (TypeScript, ESLint)
