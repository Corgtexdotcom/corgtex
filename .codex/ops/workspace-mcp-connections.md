# Workspace MCP connections

Critical scope: workspace authorization, OAuth grant races, delegated execution,
and additive persistence. Independent integrated QA is required before delivery.

## Connection contract

- A connection uses `/mcp/workspaces/{workspaceId}` on the configured canonical
  `MCP_PUBLIC_URL` origin, falling back to `APP_URL`. The immutable workspace ID,
  not its editable name or slug, is the resource identity. Configure one public
  origin and preserve the proxy's correct forwarded host/protocol.
- Path-specific protected-resource discovery names that exact endpoint. Consent
  for it is locked to one workspace, with a server-signed user/resource/client,
  redirect, scopes, PKCE challenge and captured support epoch. Code exchange must
  provide the same non-null resource. No tool argument, header, foreign entity ID,
  or other membership selects a different workspace.
- Client registration remains a shared software identity. Every affirmative
  consent creates a new immutable connection ID. Refresh rotates secrets under
  the existing workspace lock without changing connection identity, resource or
  scopes. A scope change requires new consent; differing refresh scopes return
  `invalid_scope`, never broader permissions than requested.
- Named users see their own connection IDs and can disconnect one without
  revoking the client or another workspace. Disconnect invalidates pending codes
  for that same user/client/workspace. It cannot revive a revoked connection.
- Persistent agent credentials must name exactly one workspace. Their delegated
  origin includes the credential fingerprint, so rotation invalidates old work.
- Full/Setup authorization stays in central workspace membership/support policy.
  Setup cannot issue or use content-bearing MCP credentials, including after a
  stale member row or grant revoke/regrant. Ordinary membership elsewhere is not
  converted or globally restricted.

## Delegated execution

New MCP-origin Event and WorkflowJob writes carry the immutable connection ID and
workspace; agent work also carries its credential fingerprint. Outbox dispatch
and actual worker handlers recheck the connection and central membership/support
policy before execution. Descendants retain provenance. Independent system work
has no MCP origin. Request execution rechecks before returning content. Revocation
cannot retract completed effects or preempt an external operation already in
flight; subsequent central authorization boundaries and queued work fail closed.

## Transition and rollout

1. Apply the additive migration through the existing migration-before-worker
   release contract. It adds nullable support epochs on MCP codes/tokens and
   nullable MCP origin on Event/WorkflowJob; no live migration is part of local QA.
2. Deploy the matching web and worker code. Do not enable new canonical clients
   while old workers that ignore MCP provenance are still executing. Retain the
   existing release writer and deployment readiness/rollback controls.
3. Existing `/mcp` and `/api/mcp` clients remain explicit legacy endpoints. Old
   null/global-resource tokens are never accepted at a canonical endpoint. New
   workspace installs use canonical URLs and unique config names. Reconnect each
   workspace separately, then disconnect its legacy connection. No automatic
   migration, revocation deadline, global client revocation or inferred workspace.
4. Legacy support tokens without a captured epoch must reauthorize. Bootstrap
   agent credentials remain legacy-only; canonical endpoints require independently
   revocable persistent credentials. Existing procurement-issued workspace-bound
   agent tokens at the legacy endpoint remain compatible.
5. Predeployment Event/WorkflowJob records without MCP origin cannot be attributed
   retrospectively. Confirm old-worker overlap and existing pending work before
   claiming connection-specific cancellation for the rollout. Do not bulk purge
   or invent provenance. Rollback to old worker code loses the new check and
   requires an explicit release decision, not an automatic security guarantee.

The UI selects a workspace explicitly and displays its stable ID, scoped URL and
individual connection status. Native Claude/ChatGPT acceptance must separately
verify two simultaneous connections, distinct names, correct workspace reads and
independent disconnect. Unit, PostgreSQL and local browser proof do not establish
native-client acceptance. Mixing two connections in one client conversation is
client-side context mixing, not permission to cross workspace boundaries.
