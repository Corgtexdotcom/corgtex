# Plan: Central Corgtex Connector

## Goal

Replace the Custom GPT-first integration path with one stable Corgtex MCP connector that supports browser OAuth, tenant/workspace routing, and easy setup in ChatGPT, Claude, Cursor, and other MCP clients. Crina should work through the same connector model without requiring its own public approval path.

## Risk tier

- `high`

## Out of scope

- Public OpenAI or Claude marketplace submission.
- Cross-instance proxying to arbitrary unregistered customer domains.
- Removing legacy Custom GPT API routes.
- Enterprise-specific branded connector listings.

## Files to touch

- `docs/plans/codex-central-corgtex-connector-v2.md`
- `docs/assets/codex-central-corgtex-connector-v2/**`
- `apps/web/app/.well-known/**`
- `apps/web/app/mcp/**`
- `apps/web/app/[locale]/oauth/authorize/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/CorgtexConnectorManager.tsx`
- `apps/web/app/api/mcp/route.ts`
- `apps/web/app/api/oauth/authorize/route.ts`
- `apps/web/app/api/oauth/token/route.ts`
- `apps/web/app/api/oauth/register/**`
- `apps/web/app/api/oauth/revoke/**`
- `apps/web/messages/en.json`
- `docs/deploy/configuration.mdx`
- `packages/domain/src/index.ts`
- `packages/domain/src/mcp-connector.ts`
- `packages/domain/src/mcp-connector.test.ts`
- `packages/mcp/src/auth.ts`
- `packages/mcp/src/auth.test.ts`
- `packages/mcp/src/server.ts`
- `packages/mcp/src/server.test.ts`
- `packages/shared/src/env.ts`
- `prisma/schema.prisma`
- `prisma/migrations/20260427153000_mcp_connector_oauth/**`

## Acceptance criteria

- [x] A stable `/mcp` endpoint exists alongside `/api/mcp`.
- [x] MCP clients can discover OAuth protected-resource and authorization-server metadata.
- [x] MCP OAuth supports dynamic client registration, PKCE authorization code exchange, refresh, and revocation.
- [x] Connector tokens are bound to user, workspace, instance, scopes, and MCP resource audience.
- [x] Crina-compatible instance registration defaults from deployment/workspace configuration.
- [x] Unknown or unregistered workspaces are rejected when an instance registry is configured.
- [x] Existing agent bearer credentials continue to work.
- [x] Settings show a non-technical Corgtex connector setup flow instead of the Custom GPT setup panel.
- [x] MCP exposes approval-friendly read/search tools and tool annotations.
- [x] Domain and MCP tests cover routing, OAuth token auth, scope checks, and annotations.

## Test plan

```
npm run check
npx vitest run --project unit packages/mcp/src/auth.test.ts packages/mcp/src/server.test.ts packages/mcp/src/scopes.test.ts packages/domain/src/mcp-connector.test.ts
DATABASE_URL='postgresql://postgres:postgres@localhost:55433/corgtex_connector_pr?schema=public' npm run prisma:migrate:deploy
npm run build
```

## Rollback

Revert the PR to restore the previous manual agent-credential MCP setup and Custom GPT settings panel. The migration only adds new MCP OAuth tables and relations; after rollback, leave the unused tables in place until a follow-up cleanup migration is scheduled, or drop them after confirming no connector tokens have been issued in production.

## Labels this PR needs

- `forbidden-path-approved` — this change adds a Prisma migration for connector OAuth storage.
- `large-change-approved` — this is a high-risk auth/integration change that intentionally crosses the normal high-risk LOC cap.
