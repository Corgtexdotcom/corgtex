# Plan: Finalize Multilingual Support

## Goal

The objective is to finalize the internationalization (i18n) of the Corgtex platform by localizing all remaining hardcoded strings in the Settings modules (`SsoConfigManager`, `MembersTable`, `DataSourcesManager`, `FileUploader`, `TextPasteUploader`, `RecentUploads`, `AgentConnectionManager`, `CustomGptConnectionManager`, `AgentBudgetManager`, `AgentSettingsClient`). This work will be bundled into one comprehensive "mega-PR" to merge all internationalization efforts seamlessly into `main`, providing complete feature parity between English (`en`) and Spanish (`es`) locales.

## Out of scope

- Extracting dynamic variables from backend database fields into translations (e.g. database-stored role names if they exist, except UI labels).
- Changing routing logic or middleware, as this was already completed in PR #40.

## Files to touch

- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/AgentConnectionManager.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/CustomGptConnectionManager.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/DataSourcesManager.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/FileUploader.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/MembersTable.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/RecentUploads.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/SsoConfigManager.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/TextPasteUploader.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/agents/AgentBudgetManager.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/agents/AgentSettingsClient.tsx`
- `apps/web/messages/en.json`
- `apps/web/messages/es.json`
- `docs/plans/feat-i18n-complete.md`

## Acceptance criteria

- [x] All listed components under `settings/` use `next-intl`'s `useTranslations("settings")` hook.
- [x] No hardcoded UI strings remain in the specified components.
- [x] Translation keys are perfectly synced between `en.json` and `es.json`.
- [x] TypeScript types and ESLint checks pass (`npm run check` exits with code 0).
- [ ] A single PR is opened grouping all these changes under `feat/i18n-complete`.
- [ ] Visual proof is attached to the PR for the localized settings tab.

## Test plan

```bash
npm run check
```

## Rollback

Pure code change for localization. Can be safely reverted via GitHub PR revert if UI breaks or keys go missing.

## Labels this PR needs

- `large-change-approved` — touches numerous settings files simultaneously to achieve the "mega-PR" consolidation requested.
