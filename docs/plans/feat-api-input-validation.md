# Plan: Add Zod input validation to security-critical API routes

## Goal

59 API routes accept `req.json()` without any schema validation. Client input
is cast via `as { ... }` or destructured with no type safety at runtime. This
means malformed payloads silently produce undefined fields, leading to Prisma
errors that leak internal column names, or worse, unexpected writes with null
values.

This plan adds Zod schemas to the **20 most security-critical** routes: auth
endpoints (login, password reset), financial mutation endpoints (spends,
ledger accounts), governance endpoints (proposals, approvals, roles), and
member management. It also introduces a shared `validateBody<T>()` utility
in `apps/web/lib/http.ts` to standardize validation across all routes.

A follow-up plan will cover the remaining ~39 routes (brain, conversations,
agent-identities, data-sources, etc.).

## Risk tier

- `standard`

## Out of scope

- Validation for GPT/agent API routes (`/api/gpt/v1/**`) — separate concern
  with its own OpenAPI spec.
- Validation for brain routes (`brain/articles/**`, `brain/sources/**`) — large
  surface area, needs dedicated plan.
- Validation for conversation routes — streaming response patterns differ.
- Changing domain-layer validation (domain already has `invariant()` guards).
- Refactoring route logic beyond adding the validation wrapper.

## Files to touch

- `apps/web/lib/http.ts`
- `apps/web/app/api/auth/login/route.ts`
- `apps/web/app/api/auth/forgot-password/route.ts`
- `apps/web/app/api/auth/reset-password/route.ts`
- `apps/web/app/api/workspaces/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/members/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/members/[memberId]/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/roles/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/roles/[roleId]/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/roles/[roleId]/assignments/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/spends/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/spends/[spendId]/mark-paid/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/spends/[spendId]/reconciliation/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/spends/[spendId]/ledger-account/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/ledger-accounts/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/ledger-accounts/[accountId]/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/proposals/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/proposals/[proposalId]/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/approvals/[flowId]/decisions/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/approvals/[flowId]/objections/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/tensions/route.ts`
- `apps/web/app/api/workspaces/[workspaceId]/tensions/[tensionId]/route.ts`
- `docs/plans/feat-api-input-validation.md`

## Acceptance criteria

- [x] `apps/web/lib/http.ts` exports a `validateBody<T>(req: NextRequest, schema: z.ZodType<T>): Promise<T>` utility that throws `AppError(400, "VALIDATION_ERROR", ...)` with Zod issue details on failure.
- [x] Auth routes (`login`, `forgot-password`, `reset-password`) validate: email is a non-empty trimmed string where present, password is a string with min length 8 where present.
- [x] Member mutation routes (`POST /members`, `PATCH /members/:id`) validate required fields (email, role enum values).
- [x] Role mutation routes (`POST /roles`, `PATCH /roles/:id`, `POST /assignments`) validate name as non-empty string, memberId as UUID.
- [x] Spend mutation routes (`POST /spends`) validate: amountCents as positive integer, category and description as non-empty strings, optional related IDs as strings.
- [x] Ledger account routes validate: name and currency as non-empty strings, type as an optional non-empty string.
- [x] Proposal and approval routes validate: title as non-empty string, bodyMd as string, decision choice as enum.
- [x] Tension routes validate: title as non-empty string, status as enum.
- [x] All Zod errors are returned as structured `{ error: { code: "VALIDATION_ERROR", message: "..." } }` with status 400.
- [x] No runtime behavior change for valid requests — all existing tests continue to pass.
- [x] `npm run check` passes.
- [x] `npm run test:unit` passes.

## Test plan

```
npm run check
npm run test:unit
```

## Rollback

No schema changes, no migrations. Validation is additive — it rejects
malformed requests that previously would have produced Prisma errors or
undefined behavior. Safe to revert by reverting the merge commit. No
breaking change to any client that sends well-formed requests.

## Labels this PR needs

(none)
