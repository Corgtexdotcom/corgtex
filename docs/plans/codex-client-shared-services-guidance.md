# Plan: Client Shared Services Guidance

## Goal

Document the Redis and S3-compatible storage setup required for production and client deployments so client instances such as Crina are not upgraded without the shared runtime services needed for rate limiting, retrieval cache, session coordination, uploads, and Brain source downloads.

## Risk tier

- low

## Out of scope

- Changing runtime application code.
- Creating or modifying Railway resources.
- Changing CI, deployment manifests, or Prisma schema.

## Files to touch

- `docs/plans/codex-client-shared-services-guidance.md`
- `docs/deploy/configuration.mdx`
- `docs/deploy/upgrades.mdx`

## Acceptance criteria

- [x] Configuration docs list Redis variables for production and client instances.
- [x] Configuration docs list S3-compatible storage variables for upload-capable deployments.
- [x] Upgrade docs include a Railway client-instance checklist covering Redis, storage, redeploys, health, and logs.
- [x] Guidance explicitly says client deployments such as Crina must be checked independently from the main Corgtex project.

## Test plan

```
git diff --check -- docs/deploy/configuration.mdx docs/deploy/upgrades.mdx docs/plans/codex-client-shared-services-guidance.md
```

## Rollback

This is a docs-only change. Revert the PR to remove the added deployment guidance.

## Labels this PR needs

