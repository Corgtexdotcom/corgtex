# Plan: Production Hardening and Fixes

## Goal
Complete the backend hardening and testing campaign for the Corgtex production environment, resolving crashing APIs and finalizing missing endpoints.

## Out of scope
- UI or Frontend component changes

## Files to touch
- `docs/plans/fix-production-hardening.md`
- `packages/domain/src/finance.ts`
- `packages/domain/src/proposals.ts`
- `apps/web/app/api/workspaces/[workspaceId]/proposals/[proposalId]/route.ts`
- `packages/shared/src/index.ts`
- `packages/agents/src/index.ts`

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
npm run test:unit
```

## Rollback
Pure code changes, fully revertible with `git revert <commit>`.

## Labels this PR needs

