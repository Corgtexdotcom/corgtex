# Slack MVP Communication Platform Foundation

## Summary

Build Slack as the first production communication platform for Corgtex while keeping the data model and service surface provider-neutral for Teams and Google Chat later. Slack handles daily operations, capture, lightweight interactions, App Home, and notifications; Corgtex remains the system of record and the rich newspaper surface.

## Risk tier

high

This touches OAuth, signed external webhooks, encrypted token storage, migrations, inbound events, background jobs, and user/account mapping.

Forbidden-path justification: this plan adds a Prisma migration under `prisma/migrations/**` because the communication foundation needs durable installation, user, channel, message, event, and entity-link tables. The PR needs the `forbidden-path-approved` label.

This is intentionally larger than the high-risk size cap because Slack has to land with its route, domain, worker, digest, and settings surfaces together to be coherent. The PR needs the `large-change-approved` label unless it is split.

## Files to touch

- `docs/plans/codex-slack-mvp-foundation.md`
- `docs/assets/codex-slack-mvp-foundation/**`
- `docs/slack-app-manifest.yml`
- `package.json`
- `package-lock.json`
- `prisma/schema.prisma`
- `prisma/migrations/20260426090000_add_communication_platform_foundation/**`
- `packages/shared/src/env.ts`
- `packages/shared/src/crypto.ts`
- `packages/domain/src/index.ts`
- `packages/domain/src/communication.ts`
- `packages/domain/src/communication.test.ts`
- `packages/agents/src/daily-digest.ts`
- `packages/workflows/src/outbox.ts`
- `packages/workflows/src/outbox.runtime.test.ts`
- `apps/web/app/api/integrations/slack/**`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/actions.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/page.tsx`

## Acceptance criteria

- [x] Provider-neutral communication types and Prisma models exist with Slack implemented first.
- [x] Slack OAuth, Events API, command, interactivity, and App Home routes are present.
- [x] Slack POST routes verify Slack signatures from the raw request body.
- [x] Slack bot tokens are stored encrypted with the shared AES-GCM helper.
- [x] `/corgtex brief`, `action`, `tension`, and `proposal` command handling exists.
- [x] The Slack message shortcut can create private Corgtex drafts and source links.
- [x] Daily digest generation includes retained public Slack messages.
- [x] Raw Slack message text is purged after 30 days while preserving metadata and links.
- [x] Workspace settings show Slack connection status, scopes, disconnect, and retention copy.
- [x] A checked-in Slack app manifest documents the repeatable app configuration.
- [x] Unit tests cover signature verification, event dedupe, command draft creation, retention purge, route URL verification, and worker dispatch.

## Test plan

- Run Prisma client generation and schema validation.
- Validate the migration against a disposable Postgres test database.
- Run targeted Vitest coverage for communication domain, Slack route handling, and workflow dispatch.
- Run `npm run check`.
- Capture visual proof for the settings UI path.
- Defer real Slack dev-workspace smoke testing until Slack app credentials are available.
