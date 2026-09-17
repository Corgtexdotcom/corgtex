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

**Runtime activation control:** `MCP_WORKSPACE_CONNECTIONS_ENABLED` is a
server-only environment setting, default **false** when absent. There is no tenant
API or UI that enables it. Canonical metadata, endpoint authentication (OAuth and
persistent agents), consent, code exchange and refresh enforce the gate; existing
canonical tokens cannot resolve while disabled. Queued canonical OAuth/agent work
also checks it. Setup/install URLs fall back to the legacy `/mcp` URL and existing
canonical grants display paused. Legacy endpoint/token/refresh behavior remains
available. Explicit disconnect remains available for paused grants.

The flag is an operator-controlled activation fence, **not automatic proof of
worker compatibility**. It does not inspect provider state or infer readiness from
web health. Nothing in the release runner, Bicep or this change automatically sets
it true. The normal initial web-first rollout therefore leaves canonical access
disabled. Only the authorized release owner enables it after retained matching
worker/revision and old-worker-drain proof. Configure it consistently for web and
worker; do not enable it on the initial web update.

For an already accepted compatible selfserve release, the explicit protected
[configuration workflow](workspace-mcp-config.md) provides worker-first activation
under the existing fleet lock and a web-only ingress-disable recovery boundary.
It does not perform native connections or replace consent and pending-work gates.

1. Leave `MCP_WORKSPACE_CONNECTIONS_ENABLED` absent or false on web and worker.
   Apply the additive migration through the existing migration-before-worker
   release contract. It adds nullable support epochs on MCP codes/tokens and
   nullable MCP origin on Event/WorkflowJob; no live migration is part of local QA.
2. Deploy the matching web and worker code. Do not enable new canonical clients
   while old workers that ignore MCP provenance are still executing. The release
   owner must retain immutable worker-image/revision proof and evidence that all
   incompatible old workers have stopped/drained. The existing worker health
   response has release metadata and phase, but one healthy new worker does not
   prove fleet-wide drain. Retain the existing release writer and deployment
   readiness/rollback controls. With those prerequisites satisfied, separately
   set `MCP_WORKSPACE_CONNECTIONS_ENABLED=true` on the matching workers, then web,
   through the authorized configuration/release process; verify readback and
   scoped acceptance. Missing proof means leave it off, not a new inferred gate.
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
   or invent provenance. Before rollback to pre-provenance workers, disable the
   flag on web, prove new canonical ingress has stopped, and resolve/drain pending
   canonical work with compatible workers under the release owner's authority.
   Disabling the flag on compatible workers denies queued canonical execution
   through normal job retry/failure handling; it is not a resumable queue-pause
   mechanism. The flag cannot fence an old binary that does not read it. Therefore
   do not roll old workers back onto unresolved canonical jobs or claim the flag
   alone makes that rollback safe. No automatic queue purge or rollback is added.

The UI selects a workspace explicitly and displays its stable ID, scoped URL and
individual connection status. Native Claude/ChatGPT acceptance must separately
verify two simultaneous connections, distinct names, correct workspace reads and
independent disconnect. Unit, PostgreSQL and local browser proof do not establish
native-client acceptance. Mixing two connections in one client conversation is
client-side context mixing, not permission to cross workspace boundaries.
