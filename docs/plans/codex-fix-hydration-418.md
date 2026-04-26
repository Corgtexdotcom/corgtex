# Plan: Fix Hydration 418

## Goal

Remove the production React hydration mismatch emitted on workspace pages by making shared chat sidebar date text deterministic across server and browser timezones.

## Risk tier

- low

## Out of scope

- Changing chat behavior, conversation loading, or message sending.
- Refactoring broader date formatting across server-only pages.
- Changing production infrastructure, auth, database schema, or deployment files.

## Files to touch

- `docs/plans/codex-fix-hydration-418.md`
- `apps/web/app/[locale]/workspaces/[workspaceId]/chat/ChatInterface.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/chat/date-format.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/chat/date-format.test.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/operator/page.tsx`
- `docs/assets/codex-fix-hydration-418/hydration-results.json`
- `docs/assets/codex-fix-hydration-418/qa-results.json`

## Acceptance criteria

- [x] Shared chat conversation dates render with the same text on the server and client regardless of browser timezone.
- [x] Production-style workspace page smoke no longer reports React hydration error `#418`.
- [x] Critical route smoke still loads workspace pages without HTTP route failures.
- [x] Operator page uses an existing translation key for the failing-agent banner.
- [x] Static checks pass.

## Test plan

```
npx vitest run "apps/web/app/[locale]/workspaces/[workspaceId]/chat/date-format.test.ts"
npm run check
npm run build
PORT=3011 npm --workspace @corgtex/web run start:next
npx dotenv-cli -- node scripts/client-readiness-smoke.mjs http://localhost:3011 docs/assets/codex-fix-hydration-418
```

Additional proof captured in `docs/assets/codex-fix-hydration-418/hydration-results.json`: a seeded boundary conversation updated at `2026-04-21T01:30:00.000Z` rendered as `Apr 21` in both UTC and America/Los_Angeles browser timezones with zero console errors.

## Rollback

This is a pure frontend formatting change. Revert the PR to restore the prior local-time conversation date rendering.

## Labels this PR needs
