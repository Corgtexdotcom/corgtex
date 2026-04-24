# Plan: i18n Foundation

## Goal

Install `next-intl`, restructure routes under a `[locale]` dynamic segment, create the i18n configuration layer, extract strings from auth pages and navigation, and add a feature-flagged language switcher. This is PR 1 of 4 to introduce Spanish translations to the Corgtex UI.

## Out of scope

- Extracting strings from workspace pages, dashboard, or feature pages (this will be done in PRs 2 and 3).
- Adding user DB preference for locale or CI sync script (PR 4).

## Files to touch

- `package.json`
- `package-lock.json`
- `apps/web/middleware.ts`
- `apps/web/i18n/config.ts`
- `apps/web/i18n/routing.ts`
- `apps/web/i18n/request.ts`
- `apps/web/messages/en.json`
- `apps/web/messages/es.json`
- `apps/web/app/[locale]/layout.tsx`
- `apps/web/app/[locale]/page.tsx`
- `apps/web/app/[locale]/login/**`
- `apps/web/app/[locale]/forgot-password/**`
- `apps/web/app/[locale]/reset-password/**`
- `apps/web/app/[locale]/setup-account/**`
- `apps/web/app/[locale]/oauth/**`
- `apps/web/app/layout.tsx`
- `apps/web/app/page.tsx`
- `apps/web/app/login/**`
- `apps/web/app/forgot-password/**`
- `apps/web/app/reset-password/**`
- `apps/web/app/setup-account/**`
- `apps/web/app/oauth/**`
- `apps/web/lib/nav-config.ts`
- `docs/plans/feat-i18n-foundation.md`
- `apps/web/app/[locale]/error.tsx`
- `apps/web/app/[locale]/workspaces/**`
- `apps/web/app/workspaces/**`
- `apps/web/lib/components/**`
- `apps/web/next.config.ts`
- `apps/web/package.json`
- `docs/assets/visual_proof_en.png`
- `docs/assets/visual_proof_es.png`

## Acceptance criteria

- [x] `next-intl` installed and configured with `en` (default) + `es` locales.
- [x] Middleware detects locale, routing works with dynamic `[locale]` segment.
- [x] Auth routes and landing page restructured under `app/[locale]/`.
- [x] Auth pages use `t()` for visible text.
- [x] Navigation labels in `nav-config.ts` use translation keys.
- [x] `messages/en.json` contains keys for auth and navigation.
- [x] `messages/es.json` contains Spanish translations for auth and navigation.
- [x] Thin wrapper `app/layout.tsx` redirects or wraps `[locale]/layout.tsx` properly without breaking.
- [x] `npm run check` passes locally.

## Test plan

```
npm run check
npm run test:unit
```

## Rollback

Revert the PR. The route restructure is localized to the app directory.

## Labels this PR needs

- `large-change-approved` — Route restructure touches >15 files.
