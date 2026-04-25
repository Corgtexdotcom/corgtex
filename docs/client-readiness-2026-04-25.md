# Client Readiness Report - 2026-04-25

## Status

Ship-ready for client testing on the locally seeded app.

## What Was Verified

- Local seed completed successfully and preserved existing passwords.
- Web app ran on isolated local ports during QA, with the final repeatable smoke run against the production build on `3111`.
- Logged in with the local E2E account from `.env`.
- Browser sweep covered 39 desktop/mobile route checks across login, workspace home, goals, brain, brain sources/status, members, tensions, actions, meetings, leads, proposals, circles, cycles, finance, agents, governance, audit, settings, chat, operator, and invalid-route handling.
- Final QA result: `0` route findings and `0` browser console errors in `docs/assets/client-readiness-2026-04-25/qa-results.json`.
- `npm run check` passed.
- `npm run build` passed.

## Fixes Applied

- Added the missing `common.commandMenu` locale key in English and Spanish so the workspace command menu no longer emits missing-message errors.
- Stabilized login hydration by explicitly matching the login input attributes and suppressing hydration warnings for those controlled form fields.
- Fixed finance and operator i18n runtime errors found during the smoke pass.
- Added `scripts/client-readiness-smoke.mjs` so the browser route, screenshot, and console-error pass can be rerun.

## Evidence

- Desktop screenshots: `docs/assets/client-readiness-2026-04-25/desktop-*.png`
- Mobile screenshots: `docs/assets/client-readiness-2026-04-25/mobile-*.png`
- Login verification: `docs/assets/client-readiness-2026-04-25/verify-login-clean.png`
- Machine-readable QA result: `docs/assets/client-readiness-2026-04-25/qa-results.json`
- Repeatable smoke script: `scripts/client-readiness-smoke.mjs`

## Remaining Non-Blocking Notes

- `npm run check` passes, but still reports the pre-existing Next.js warning for a plain `<img>` in `apps/web/app/[locale]/workspaces/[workspaceId]/goals/page.tsx`.
- `npm run build` passes, but logs missing local S3/R2 endpoint warnings because upload storage is not configured in this local test environment.
- Dev startup logs show slow first compilation for several app routes.
- Several older local Corgtex dev processes were already running before this pass; use isolated ports or stop stale local servers before a live client demo.
