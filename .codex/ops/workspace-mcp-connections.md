# Workspace MCP Connections

One connection has one immutable `/mcp/workspaces/{workspaceId}` resource. The
software OAuth client remains shared across connections. Each fresh consent
creates a separate token row/connection; refresh rotates that row atomically.
Scopes cannot change on refresh. Reconsent creates a new connection and does not
implicitly revoke another connection. The authenticated UI lists and revokes
individual rows; labels include the workspace ID and can reflect renamed workspaces.

New consent/code exchange requires the exact scoped resource. Previously issued
null/global-resource grants remain confined to legacy `/mcp` and `/api/mcp`;
they cannot enter a scoped endpoint or silently become a scoped connection.
The UI flags them for explicit reconsent. Legacy runtime owners/callers must be
mapped before production rollout; this implementation does not authorize retirement.

Reuse `requireWorkspaceMembership` plus support capability versions. Event/job
provenance records the initiating MCP connection ID, and the worker validates
connection, membership and support authorization before delegated execution.
Revoked delegated work fails closed; unrelated system schedules are unchanged.
The nullable provenance migration does not relabel historical queued work.
Transfers must explicitly classify populated connection references, not drop them.

Local validation uses only synthetic `mcp_test` on a separate loopback database:

```sh
DATABASE_URL=postgresql://postgres@127.0.0.1:55484/mcp_test npx vitest run --project integration packages/domain/src/workspace-mcp.integration.test.ts packages/domain/src/workspace-support-access.integration.test.ts
DATABASE_URL=postgresql://postgres@127.0.0.1:55484/mcp_test node scripts/workspace-mcp-local-smoke.mjs
```

Smoke expects this branch's web server at localhost:3184 with matching APP_URL
and MCP_PUBLIC_URL. It verifies discovery/challenges, fixed consent, shared-client
A/B tool/resource isolation, forgery denial, UI revoke and mobile/desktop rendering.
Fixtures are removed afterwards; no real accounts, providers or client content.

Actual simultaneous Claude/ChatGPT connector retention, naming, refresh and
independent disconnect remain client-side acceptance, not inferred from protocol
tests. Multiple connectors in one AI conversation can combine returned results;
server workspace authorization is not separation of conversation context.
