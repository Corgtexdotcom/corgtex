# Plan: Production Hardening and Fixes

## Goal
Complete the backend hardening and testing campaign for the Corgtex production environment, resolving crashing APIs, finalizing missing endpoints, structured JSON logging, and frontend crash bounds.

## Out of scope
- Infrastructure automation mappings

## Files to touch
- `apps/web/app/api/workspaces/[workspaceId]/proposals/[proposalId]/route.ts`
- `apps/web/app/workspaces/[workspaceId]/operator/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/proposals/page.tsx`
- `apps/worker/src/index.ts`
- `docs/assets/production_hardening_proof/operator.png`
- `docs/assets/production_hardening_proof/proposals.png`
- `docs/plans/fix-production-hardening.md`
- `packages/domain/src/agent-runs.ts`
- `packages/domain/src/finance.ts`
- `packages/domain/src/proposals.test.ts`
- `packages/domain/src/proposals.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/logger.ts`

## Acceptance criteria
- [x] Adds `getSpend` and `updateSpend` exports to `finance.ts`
- [x] Adds `deleteProposal` to `proposals.ts`
- [x] Implements `DELETE` handler in proposal API route
- [x] Re-exports `conversation`, `brain-absorb`, `brain-maintenance`, `logger` in package indices
- [x] All backend API smoke tests pass clean E2E
- [x] `npm run check` and `npm test:unit` pass without error

## Test plan
```
npm run check
npm test:unit
```

## Rollback
Pure code changes, fully revertible with `git revert <commit>`.

## Labels this PR needs
- `large-change-approved` — multiple components touched across workflows and UI boundaries
