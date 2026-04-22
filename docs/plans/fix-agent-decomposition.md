# Decomposing Agent Runtime Monolith

This plan formalizes the decomposition of the monolithic `runtime.ts` and `outbox.ts` to improve system maintainability.

## User Review Required

No logic changes are made. Purely file extraction.

## Proposed Changes

### packages/agents/src
- Split `runtime.ts` into individual files inside `agents/` directory.
- Keep only `executeAgentRun` and helpers in `runtime.ts`.
- Re-export all agents from `agents/index.ts`.
- Update `packages/agents/src/index.ts`.

### packages/workflows/src
- Split out `deriveJobsForEvent` to `derive-jobs.ts` and `deriveNotificationsForEvent` to `derive-notifications.ts`.
- Extract workflow handlers to `handlers/`.

## Files to touch
- `docs/plans/fix-agent-decomposition.md`
- `packages/agents/src/runtime.ts`
- `packages/agents/src/index.ts`
- `packages/agents/src/agents/**`
- `packages/agents/src/agents/index.ts`
- `packages/workflows/src/outbox.ts`
- `packages/workflows/src/handlers/**`
- `packages/workflows/src/derive-jobs.ts`
- `packages/workflows/src/derive-notifications.ts`
- `packages/agents/src/*.test.ts`
- `packages/workflows/src/*.test.ts`
- `packages/agents/src/brain-absorb.ts`

## Acceptance criteria

- [x] `packages/agents/src/runtime.ts` split, preserving only `executeAgentRun`
- [x] Specific agents housed in `packages/agents/src/agents/`
- [x] `packages/agents/src/index.ts` exports updated
- [x] `packages/workflows/src/outbox.ts` split
- [x] `deriveJobsForEvent` in `derive-jobs.ts`
- [x] `deriveNotificationsForEvent` in `derive-notifications.ts`
- [x] Workflow handlers moved (knowledge-sync, agent-dispatch, governance)
- [x] Ensure 0 behavioral changes
- [x] No `any` type implicit errors
- [x] All test suites pass
