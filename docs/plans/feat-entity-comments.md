# Plan: Universal Comment System and Mentions

## Goal

Add a single polymorphic `Comment` table that lets workspace members discuss any entity (Tension, Action, Goal, Proposal, SpendRequest). Support @mention tagging for members and circles via `@member:uuid` / `@circle:uuid` syntax in entity body text AND in comments. Mentioning creates `Notification` records.

## Out of scope

- Cross-entity filtering (UI elements and domain extensions) will be implemented in Phase 2.
- UI components for comment threads and resolution flows will be implemented in Phase 3.

## Files to touch

- `prisma/schema.prisma`
- `prisma/migrations/**`
- `packages/domain/src/comments.ts`
- `packages/domain/src/mentions.ts`
- `packages/domain/src/tensions.ts`
- `packages/domain/src/actions.ts`
- `packages/domain/src/goals.ts`
- `packages/domain/src/proposals.ts`
- `packages/domain/src/index.ts`

## Acceptance criteria

- [ ] `Comment` model added to Prisma schema
- [ ] `Action` model updated with `resolvedVia` and `resolvedAt`
- [ ] `Tension` model updated with `resolvedAt`
- [ ] Prisma migration generated successfully
- [ ] `mentions.ts` created with mention parsing logic and notification creation
- [ ] `comments.ts` created with CRUD operations for comments and mentions parsing
- [ ] Domain files (`tensions.ts`, `actions.ts`, `goals.ts`, `proposals.ts`) parse mentions on create/update and have resolution logic where appropriate.

## Test plan

```
npm run check
npm run test:unit
```

## Rollback

Revert the PR. This includes a schema migration. To safely revert, run `npx prisma migrate resolve --rolled-back <migration_name>` and drop the `Comment` table and revert column additions before removing the code.

## Labels this PR needs

- `forbidden-path-approved` — touches `prisma/migrations/**` and `prisma/schema.prisma`
