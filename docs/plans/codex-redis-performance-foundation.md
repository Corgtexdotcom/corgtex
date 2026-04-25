# Plan: Redis Performance Foundation

## Goal

Add Redis-backed short-lived coordination for rate limits and Brain retrieval caches while keeping Postgres as the durable source of truth for organization data and worker queues. Reduce avoidable database writes by throttling session heartbeat updates.

## Risk tier

- high

## Out of scope

- Moving `Event` or `WorkflowJob` execution to Redis.
- Replacing Postgres durability, audit, replay, or queue locking.
- Adding pgvector/full-text retrieval migrations in this PR.
- Changing frontend UI behavior or visual layout.

## Files to touch

- `docs/plans/codex-redis-performance-foundation.md`
- `docker-compose.yml`
- `package-lock.json`
- `packages/shared/package.json`
- `packages/shared/src/**`
- `packages/knowledge/src/chunks.ts`
- `packages/knowledge/src/retrieval.ts`
- `packages/knowledge/src/retrieval.cache.test.ts`
- `packages/domain/src/auth.ts`
- `packages/domain/src/auth.session.test.ts`
- `packages/domain/src/agent-runs.ts`
- `apps/web/lib/gpt-auth.ts`
- `apps/web/lib/rate-limit-middleware.ts`
- `apps/web/app/api/auth/**`
- `apps/web/app/api/demo-leads/route.ts`
- `apps/web/app/api/webhooks/[workspaceId]/ingest/route.ts`
- `apps/web/app/demo/route.ts`

## Acceptance criteria

- [x] Redis client support is added behind `REDIS_URL` and `REDIS_KEY_PREFIX`, with in-memory fallback for local/test use.
- [x] Auth, password reset, webhook ingest, GPT API, and agent trigger rate limits use the shared async limiter.
- [x] Security-sensitive auth/password-reset limits fail closed in production when Redis is configured but unavailable.
- [x] Brain search and answer caches use the shared cache layer with per-workspace version invalidation.
- [x] Knowledge resync invalidates cache after old chunks are removed and after new chunks are written.
- [x] `Session.lastSeenAt` updates are throttled with `SESSION_LAST_SEEN_WRITE_INTERVAL_MS`, defaulting to five minutes.
- [x] Worker jobs remain Postgres-backed; no Redis queue is introduced.
- [x] Focused tests cover Redis rate limiting, fallback cache behavior, retrieval invalidation, and session heartbeat throttling.

## Test plan

```
npm run check
npm run test:unit
npm run test:integration
```

## Rollback

This is a code/config dependency change with no database migration. Reverting the PR returns rate limits and Brain caches to process-local behavior and restores per-request session heartbeat writes. If production has `REDIS_URL` configured, it can remain unused after rollback.

## Labels this PR needs

- `forbidden-path-approved` — touches `packages/domain/src/auth.ts` to throttle session heartbeats.
- `large-change-approved` — broad shared-infra change exceeds the high-risk file/LOC cap.
