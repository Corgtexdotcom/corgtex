# Plan: Global Theme Migration

## Goal
Implement a robust global light/dark mode system for the Corgtex web application. Replace hardcoded Tailwind colors with semantic CSS variables, set up `next-themes`, and clean up any undefined variables to provide a fully functional, theme-aware workspace environment.

## Out of scope
Marketing site (`apps/site`) theme migration.

## Files to touch
- `apps/web/app/globals.css`
- `apps/web/app/layout.tsx`
- `apps/web/app/login/SsoLoginForm.tsx`
- `apps/web/app/oauth/authorize/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/brain/[slug]/history/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/goals/GoalProgress.tsx`
- `apps/web/app/workspaces/[workspaceId]/goals/RecognitionCard.tsx`
- `apps/web/app/workspaces/[workspaceId]/goals/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/layout.tsx`
- `apps/web/app/workspaces/[workspaceId]/meetings/[meetingId]/MeetingIntelligence.tsx`
- `apps/web/app/workspaces/[workspaceId]/members/[memberId]/MemberBriefing.tsx`
- `apps/web/app/workspaces/[workspaceId]/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/proposals/ProposalReactionsThread.tsx`
- `apps/web/app/workspaces/[workspaceId]/proposals/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/settings/AgentConnectionManager.tsx`
- `apps/web/app/workspaces/[workspaceId]/settings/CustomGptConnectionManager.tsx`
- `apps/web/app/workspaces/[workspaceId]/settings/FileUploader.tsx`
- `apps/web/app/workspaces/[workspaceId]/settings/agents/AgentBudgetManager.tsx`
- `apps/web/app/workspaces/[workspaceId]/settings/agents/AgentSettingsClient.tsx`
- `apps/web/package.json`
- `apps/web/tailwind.config.ts`
- `package-lock.json`
- `apps/web/app/ThemeProvider.tsx`
- `apps/web/app/ThemeToggle.tsx`
- `docs/plans/feat-global-theme.md`
- `docs/assets/feat-global-theme-demo.png`

## Acceptance criteria
- [x] Install `next-themes` and set up the `ThemeProvider`.
- [x] Update `tailwind.config.ts` with `darkMode: 'class'` and semantic variables.
- [x] Define semantic tokens in `globals.css` inside `:root` and `.dark` block.
- [x] Add a `ThemeToggle` to the workspace sidebar footer.
- [x] Replace hardcoded Tailwind colors in key UI components with semantic tokens.
- [x] Resolve ghost/undefined CSS variables.
- [x] Verify visual appearance matches the unified design language.
- [x] `npm run check` and `npm run build` must succeed.

## Test plan
```
npm run check
npm run build
```

## Rollback
Revert the branch to remove `next-themes` and restore hardcoded class usages.

## Labels this PR needs
- `large-change-approved`
