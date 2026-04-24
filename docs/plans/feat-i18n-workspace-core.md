# Plan: i18n Workspace Core

## Goal
Extract hardcoded strings from workspace layout, dashboard, and core pages (goals, members, brain index). Also fix remaining auth form hardcoded strings from PR 1.

## Files to touch
- apps/web/app/[locale]/workspaces/[workspaceId]/page.tsx
- apps/web/app/[locale]/workspaces/[workspaceId]/layout.tsx
- apps/web/app/[locale]/workspaces/[workspaceId]/goals/page.tsx
- apps/web/app/[locale]/workspaces/[workspaceId]/members/page.tsx
- apps/web/app/[locale]/workspaces/[workspaceId]/members/[memberId]/page.tsx
- apps/web/app/[locale]/workspaces/[workspaceId]/brain/page.tsx
- apps/web/app/[locale]/workspaces/[workspaceId]/brain/[slug]/page.tsx
- apps/web/app/[locale]/workspaces/[workspaceId]/error.tsx
- apps/web/app/[locale]/workspaces/[workspaceId]/CommandPalette.tsx
- apps/web/app/[locale]/workspaces/[workspaceId]/LanguageSwitcher.tsx
- apps/web/app/[locale]/forgot-password/ForgotPasswordForm.tsx
- apps/web/app/[locale]/reset-password/[token]/ResetPasswordForm.tsx
- apps/web/app/[locale]/setup-account/[token]/SetupAccountForm.tsx
- apps/web/messages/en.json
- apps/web/messages/es.json
- docs/assets/visual_proof_pr2.png
- docs/plans/feat-i18n-workspace-core.md

## Acceptance Criteria
- [x] All auth form components use `useTranslations()` — zero hardcoded English in auth pages
- [x] All visible text in workspace layout uses `t()`
- [x] Dashboard page uses `t()` for all visible strings
- [x] ICU pluralization used for count-dependent text
- [x] Date formatting uses `next-intl` formatter
- [x] Goals, Members, Brain index pages fully translated
- [x] `messages/en.json` and `messages/es.json` updated with all new keys
- [x] `npm run check` passes
