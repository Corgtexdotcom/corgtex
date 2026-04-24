# Plan: Fix Contrast Violations & Migrate Hardcoded Colors to Theme System

## Goal

Add missing theme tokens (e.g. `--accent-fg`) and migrate hardcoded color usages across the platform to ensure proper WCAG AA contrast in both light and dark modes. This solves critical visibility bugs (e.g. white text on near-white buttons in dark mode) and improves maintainability by removing theme-bypassing hardcoded colors.

## Out of scope

- Feature changes unrelated to color definitions.
- Changes to `apps/site` (marketing site).
- Layout, spacing, or typography changes.

## Files to touch

- `apps/web/app/globals.css`
- `apps/web/tailwind.config.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/goals/GoalProgress.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/goals/RecognitionCard.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/goals/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/agents/[agentId]/AgentProfileClient.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/agents/[agentId]/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/agents/AgentRegistryToggle.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/agents/AgentRegistryTab.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/agents/AgentSettingsClient.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/agents/ObservabilityTab.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/DataSourcesManager.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/TextPasteUploader.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/FileUploader.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/AgentConnectionManager.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/CustomGptConnectionManager.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/MembersTable.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/brain/[slug]/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/brain/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/members/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/operator/page.tsx`
- `apps/web/lib/components/DeliberationComposer.tsx`
- `docs/plans/feat-theme-contrast-fixes.md`
- `docs/assets/feat-theme-contrast-fixes.png`
- `scripts/contrast-audit.mjs`
- `package.json`

## Acceptance criteria

- [x] Add 8 new semantic tokens (e.g. `--accent-fg`, `--pending`) to `globals.css` `:root` and `.dark` block.
- [x] Add the 8 new tokens to `tailwind.config.ts`.
- [x] Fix 6 contrast violation rules in `globals.css`.
- [x] Migrate hardcoded colors to semantic theme tokens in all components listed in "Files to touch".
- [x] Ensure `button` text color inverts properly on dark mode.
- [x] `npm run check` and `npm run build` must succeed.

## Test plan

```
npm run check
npm run build
node scripts/contrast-audit.mjs
```

## Rollback

Revert the PR branch. It is a pure CSS/JSX code change.

## Labels this PR needs

- `large-change-approved`
