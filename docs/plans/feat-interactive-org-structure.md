# Plan 1: Interactive Org Structure Visualization

## Goal
Transform the existing circles graph view from a basic tree diagram into an interactive, visually appealing organizational map where users can click circles to expand and see roles, people, and agents inside them.

## Files to touch
- apps/web/app/workspaces/[workspaceId]/circles/CircleGraph.tsx
- apps/web/app/workspaces/[workspaceId]/circles/CircleNode.tsx
- apps/web/app/workspaces/[workspaceId]/circles/ExpandedCircleNode.tsx
- apps/web/app/workspaces/[workspaceId]/circles/PersonNode.tsx
- apps/web/app/workspaces/[workspaceId]/circles/circle-graph.css
- apps/web/app/workspaces/[workspaceId]/meetings/[meetingId]/page.tsx
- apps/web/app/workspaces/[workspaceId]/members/[memberId]/MemberBriefing.tsx
- apps/web/app/workspaces/[workspaceId]/members/[memberId]/actions.ts
- apps/web/app/workspaces/[workspaceId]/members/[memberId]/page.tsx
- apps/web/app/workspaces/[workspaceId]/members/page.tsx
- packages/domain/src/index.ts
- packages/domain/src/member-briefing.ts
- packages/domain/src/member-briefing.test.ts
- packages/domain/src/members.ts
- docs/plans/feat-interactive-org-structure.md

## Detailed Implementation
Implemented a click-to-open ExpandedCircleNode inside CircleGraph, which triggers a localized layout reflow through dagre.
Added avatar nodes for members and agents inside circles.
Integrated Member Briefings and patched imports across pages to isolate from broken agent branches.

## Acceptance criteria
- [x] Double-clicking a circle node in the graph expands it to show roles and people inside
- [x] Expanded circles correctly show all roles and their assigned members with initials avatars
- [x] Agent entities (if present) are visually distinguished from humans in the graph
- [x] Clicking a person chip in the graph navigates to their member profile page
- [x] Member profile page shows the member's circles, roles, recent meetings, and activity
- [x] Collapsing an expanded circle returns it to the compact node view
- [x] Graph re-layouts correctly when circles are expanded/collapsed
- [x] List view continues to work unchanged
- [x] All new components have proper CSS using the existing design tokens (var(--accent), var(--line), etc.)
- [x] No TypeScript errors (`npm run typecheck`)
- [x] No lint errors (`npm run lint`)
