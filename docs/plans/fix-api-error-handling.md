# Plan: Harden API route error handling

## Goal

13 API route files lack the `handleRouteError()` wrapper from `apps/web/lib/http.ts`.
Of those, **4 have zero try/catch protection at all** — meaning any thrown error
(including `AppError`) produces a raw 500 with a stack trace leaked to the client.
The remaining 9 have ad-hoc try/catch blocks that catch `error.message` as a string
instead of converting `AppError` properly, losing status codes and error codes.

This plan migrates all 13 routes to use either `withRoute`/`withWorkspaceRoute`
(which already wraps `handleRouteError`) or wraps the top-level handler with
`handleRouteError` directly. It also adds `export const dynamic = "force-dynamic"`
to the admin page, which directly uses Prisma but is missing the required export
per AGENTS.md build guardrails.

## Risk tier

- `standard`

## Out of scope

- Adding Zod input validation to these routes (separate plan: `feat/api-input-validation`).
- Refactoring route logic or changing business behavior.
- Adding rate limiting to auth routes.
- Adding CSRF protection.
- Routes that already use `withWorkspaceRoute`/`withRoute` — these are already covered.

## Files to touch

- `apps/web/app/api/auth/sso/init/route.ts`
- `apps/web/app/api/auth/sso/callback/route.ts`
- `apps/web/app/api/gpt/v1/openapi.json/route.ts`
- `apps/web/app/api/health/route.ts`
- `apps/web/app/api/mcp/route.ts`
- `apps/web/app/api/oauth/token/route.ts`
- `apps/web/app/api/oauth/authorize/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/webhooks/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/oauth-apps/route.ts`
- `apps/web/app/api/integrations/[provider]/callback/route.ts`
- `apps/web/app/api/integrations/[provider]/connect/route.ts`
- `apps/web/app/api/demo-leads/route.ts`
- `apps/web/app/api/webhooks/[workspaceId]/ingest/route.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/admin/page.tsx`
- `docs/plans/fix-api-error-handling.md`

## Acceptance criteria

- [ ] All 13 API route files use `handleRouteError()` in their catch blocks — either directly or via `withRoute`/`withWorkspaceRoute`.
- [ ] Zero API route files under `apps/web/app/api/` have unhandled top-level exceptions (every exported handler is wrapped in try/catch or a route wrapper).
- [ ] `apps/web/app/api/oauth/token/route.ts` preserves its OAuth-specific error format (`error`/`error_description`) while still falling through to `handleRouteError` for unexpected errors.
- [ ] `apps/web/app/api/oauth/authorize/route.ts` preserves its OAuth-specific redirect behavior while adding a catch-all for unexpected errors.
- [ ] `apps/web/app/api/workspaces/[workspaceId]/webhooks/route.ts` is wrapped with `withWorkspaceRoute` (it already calls `resolveRequestActor` manually).
- [ ] `apps/web/app/api/workspaces/[workspaceId]/oauth-apps/route.ts` catch block uses `handleRouteError(error)` instead of `error.message`.
- [ ] `apps/web/app/[locale]/workspaces/[workspaceId]/admin/page.tsx` exports `const dynamic = "force-dynamic"`.
- [ ] `npm run check` passes (lint + typecheck + prisma validate).
- [ ] `npm run test:unit` passes with 0 failures.

## Test plan

```
npm run check
npm run test:unit
```

## Rollback

No schema changes, no migrations, no new dependencies. Pure error-handling
wrappers — safe to revert by reverting the single merge commit. Behavior
changes are limited to error responses: previously-leaked stack traces become
structured `{ error: { code, message } }` JSON. No client depends on raw
error strings.

## Labels this PR needs

(none)
