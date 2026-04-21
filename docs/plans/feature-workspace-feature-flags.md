# Plan: Feature Flags and CRINA Dev Env

## Goal

Add the `WorkspaceFeatureFlag` model to the Prisma database to implement deterministic per-workspace feature toggling (e.g. DUAL_LANGUAGE, CRM_CONNECTORS) from a single shared codebase. Establish a local `dev:crina` script to run the local Next.js dev server within the enterprise tenant context natively. Enable `ADMIN` roles for all seeded internal users.

## Out of scope

- Front-end integration components of CRM connects.
- Front-end implementation of the dual language drop down elements.

## Files to touch

- `package.json`
- `package-lock.json`
- `prisma/schema.prisma`
- `prisma/migrations/**`
- `scripts/seed-corgtex.mjs`
- `docs/plans/feature-workspace-feature-flags.md`

## Acceptance criteria

- [x] `WorkspaceFeatureFlag` model added to schema.
- [x] `add_workspace_feature_flags` migration added.
- [x] `dev:crina` configured in package.json to point to `.env.crina`.
- [x] Ensure non-system users are created as `ADMIN` in the internal workspace inside `seed-corgtex.mjs`.

## Test plan

```
npm run check
node scripts/check-plan.mjs --mode=present
node scripts/check-plan.mjs --mode=scope
node scripts/check-plan.mjs --mode=size
```

## Rollback

This is a non-breaking additive schema change. No other systems rely on the `WorkspaceFeatureFlag` table yet. Rollback is safe, though the DB table would persist until dropped manually. Dev scripts have no production impact.

## Labels this PR needs

- `forbidden-path-approved` — touches `prisma/migrations/**`
