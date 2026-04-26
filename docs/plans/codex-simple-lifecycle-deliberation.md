# Plan: Simple Lifecycle and Deliberation

## Goal

Simplify Corgtex work item flows around practical draft, open, and resolved lifecycles while moving archive, blocked, payment, reconciliation, and approval outcome into side states. Deliberation should support only reactions and objections, with clearer targeting and required resolution notes so self-managed teams can use the flow without extra process overhead.

## Risk tier

- high

## Out of scope

- Splitting team and circle into separate concepts.
- Replacing the existing server action and route names where the public UI copy can change safely without a broad API rename.
- Reworking approval-flow internals beyond mapping proposal and spend lifecycle outcomes.
- Building new notification or assignment delivery for deliberation targets.

## Files to touch

- `docs/plans/codex-simple-lifecycle-deliberation.md`
- `docs/assets/codex-simple-lifecycle-deliberation/**`
- `apps/web/app/[locale]/workspaces/[workspaceId]/actions/actions.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/actions/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/finance/actions.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/finance/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/meetings/[meetingId]/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/meetings/actions.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/proposals/[proposalId]/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/proposals/actions.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/proposals/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/tensions/[tensionId]/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/tensions/actions.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/tensions/page.tsx`
- `apps/web/app/api/workspaces/[workspaceId]/tensions/[tensionId]/route.ts`
- `apps/web/app/globals.css`
- `apps/web/lib/components/DeliberationComposer.tsx`
- `apps/web/lib/components/DeliberationThread.tsx`
- `apps/web/lib/deliberation-targets.ts`
- `apps/web/lib/format.ts`
- `apps/web/messages/en.json`
- `apps/web/messages/es.json`
- `packages/agents/src/agents/finance-reconciliation-prep.ts`
- `packages/agents/src/agents/inbox-triage.ts`
- `packages/agents/src/tools/mutations.ts`
- `packages/agents/src/tools/workspace.ts`
- `packages/domain/src/actions.ts`
- `packages/domain/src/advice-process.ts`
- `packages/domain/src/approvals.ts`
- `packages/domain/src/archive.test.ts`
- `packages/domain/src/archive.ts`
- `packages/domain/src/circles.ts`
- `packages/domain/src/deliberation.test.ts`
- `packages/domain/src/deliberation.ts`
- `packages/domain/src/finance.ts`
- `packages/domain/src/governance-scoring.ts`
- `packages/domain/src/impact-footprint.ts`
- `packages/domain/src/members.ts`
- `packages/domain/src/proposals.test.ts`
- `packages/domain/src/proposals.ts`
- `packages/domain/src/reactions.test.ts`
- `packages/domain/src/reactions.ts`
- `packages/domain/src/tensions.ts`
- `packages/mcp/src/server.ts`
- `packages/mcp/src/server.test.ts`
- `packages/shared/src/pilot-testing.integration.test.ts`
- `prisma/schema.prisma`
- `prisma/migrations/20260425233000_simple_lifecycle_deliberation/**`
- `scripts/cleanup-test-artifacts.mjs`
- `scripts/seed-jnj-demo.mjs`

## Acceptance criteria

- [x] Proposal, spend, tension, and action statuses use the revised lifecycle enums, with archive, outcome, payment, reconciliation, and blocked represented as side states.
- [x] The migration maps existing proposal, spend, tension, action, and deliberation data into the new model without encoding archive as a status.
- [x] Deliberation accepts only `REACTION` and `OBJECTION`, supports one optional person or circle target, and requires a note when an entry is resolved.
- [x] Finance discussion no longer lives as a large widget inside the row action menu and shows blocked state from unresolved objections.
- [x] User-facing copy says drafts are opened with the circle/team and resolved flows require an explanatory note.
- [x] Domain tests cover lifecycle migration effects, deliberation posting and resolution, finance payment gating, proposal resolution, tension resolution, and archive behavior.
- [x] Browser proof is committed for the simplified finance, proposal, tension, and action flows.

## Test plan

```
npm run prisma:generate
npm run prisma:migrate -- --name simple_lifecycle_deliberation
npx prisma migrate status
npm run check
npx vitest run packages/domain/src/proposals.test.ts packages/domain/src/finance.test.ts packages/domain/src/tensions.test.ts packages/domain/src/deliberation.test.ts packages/domain/src/archive.test.ts packages/domain/src/reactions.test.ts packages/mcp/src/server.test.ts
npx vitest run --project integration packages/shared/src/pilot-testing.integration.test.ts
npm run build
```

## Rollback

Rollback requires reverting the code and applying a follow-up migration that restores the previous enum values and folds outcome side fields back into lifecycle statuses. Because this PR removes enum values and migrates persisted records, do not rollback by code revert alone after deployment unless the database has also been restored or a forward-compatible rollback migration has been prepared.

## Labels this PR needs

- `forbidden-path-approved` — touches `prisma/migrations/**` for the required lifecycle migration.
- `large-change-approved` — intentionally exceeds the high-risk file and LOC cap because this combines schema, domain validation, tests, and UI proof for one user-directed lifecycle correction.
