# Plan: Performance & Scale Optimization

{/*
  This file is the canonical handoff from Planner (Claude) to Executor
  (Gemini in Antigravity) and to Reviewer (Codex). Copy this template to
  `docs/plans/<branch>.md`. The branch name, lowercased and with `/`
  replaced by `-`, is the filename.

  Executor: your first action on this branch is to `cat` this file.

  Reviewer: reject the PR if changed files are not in "Files to touch",
  if any acceptance criterion is not ticked, or if the PR body does not
  link back to this file.
*/}

## Goal

Improve platform performance and database scalability as the data and user base grow. Specifically, we will resolve missing database indexes on core tables (`AgentRun`) that currently risk full table scans, and we will install Next.js bundle-analyzer to trim client-side JavaScript bundle sizes to improve the Time-To-Interactive (TTI). 

## Risk tier

- `standard`

## Out of scope

- Refactoring of actual React UI components (we are only auditing the bundle and adding dynamic imports or making minimal config changes).
- Changes to API logic, Agent logic, or UI features.
- Any other schema changes outside of adding new `@@index` constraints to `AgentRun` or `AgentStep`.

## Files to touch

- `prisma/schema.prisma`
- `prisma/migrations/**`
- `apps/web/package.json`
- `apps/web/next.config.ts`
- `docs/plans/feat-performance-scale.md`
- `package-lock.json`

## Acceptance criteria

- [x] `@@index([workspaceId, status])` or similar required indexes are added to `AgentRun` and `AgentStep` in `prisma/schema.prisma`.
- [x] A new Prisma migration is generated and committed (`npm run prisma:migrate -- --name perf_indexes`).
- [x] `@next/bundle-analyzer` and `cross-env` are added as devDependencies in `apps/web/package.json`.
- [x] An `"analyze"` script is available in `apps/web/package.json` and `next.config.ts` wraps the config with `withBundleAnalyzer`.
- [x] The `npm run check` pipeline passes successfully locally without type or lint errors.

## Test plan

```
npm run check
npm run test:all
npm run --workspace @corgtex/web analyze
```

## Rollback

If we revert this PR, we must roll back the Prisma migration using `prisma migrate resolve --rolled-back` and revert the schema file. The bundle analyzer changes are development-only and rolling them back has no production impact.

## Labels this PR needs

- `forbidden-path-approved` (touches `prisma/migrations/**`)
