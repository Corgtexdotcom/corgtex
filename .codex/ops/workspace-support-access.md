# Named workspace support

Critical scope: tenant authorization, delegated work, and retirement of legacy
impersonation. Independent integrated QA is required before protected delivery.

- A verified workspace owner grants an existing named account SETUP or FULL,
  changes its role, or revokes it with an optimistic grant version and audit record.
- FULL uses a real active ADMIN membership for content and configuration. SETUP
  administers actual workspace name/description, invitation policy, AI budget,
  member invitations and roles/activation, consented OAuth sync settings/status,
  communication retention and existing recorder preferences through a scrubbed
  configuration endpoint. The optional checklist is not the administration surface.
- The owner cannot grant themselves support. Ordinary membership/SSO/merge paths
  cannot overwrite owner or support-managed identities, including revoked grants.
- Global operator authority remains control-plane authority, not automatic tenant
  membership. Ops support lists only the signed-in operator's explicit grants.
- New workspace creation records its human owner. Existing owner-null workspaces
  remain unassigned; this release supplies no owner-claim shortcut or live grants.
  Verified ownership assignment for those workspaces is a separate rollout decision.
- Grant changes invalidate existing scoped credentials, app sessions, and existing
  OAuth capabilities. First-party delegated jobs carry origin/version and recheck
  authorization before executing. Revocation cannot undo already completed effects.
- The migration retires generated identities recorded in SelfServeSupportSession,
  deactivating their memberships and credentials while preserving historical audit
  records. Legacy impersonation endpoints no longer mint or consume sessions.

PR1 adds no MCP connection transport, registration, installer, OAuth consent flow,
new global credential, or external connection machinery. Existing connection
configuration and capability revocation reuse the application's existing tables.

Support Brain source downloads stream through the server, never a client-visible
signed URL or a whole-file buffer. They bind the already captured support epoch
and recheck membership, workspace/source/storage-key and access domains before
headers, then every 4 MiB or before the next delivery after one second. Idle
downloads do not poll the database. Revocation stops subsequent delivery at that
bounded checkpoint; it cannot retract bytes already sent. Client cancellation,
access denial and provider errors close the upstream body. Ordinary memberships
retain their signed-URL redirect. The 25 MiB extraction limit is not a file-upload
or download limit; build-artifact uploads separately enforce 50 MiB.

## Configuration boundaries

Configuration writes lock the workspace and recheck the current grant version in
the same transaction. They change actual settings and record field names (not raw
values) in the audit log. Ordinary membership controls retain last-admin and role
lifecycle rules and cannot target owner/support identities. New-member setup tokens
are sent only through the existing server-side email flow, never returned to Setup.
The roster exposes only the account email, role, active state and protection marker.
For SETUP, additions/invitations, reactivation, every role change, and widening the
policy to MEMBERS_CAN_INVITE create pending owner requests, not access. Role-based
module grants mean roles are not a linear hierarchy. Same-role deactivation and
non-inviting policy changes remain direct. FULL retains direct administration.

The verified owner approves/rejects the exact persisted command in Support Access.
Approval rechecks grant identity/version and target state under the workspace lock;
stale, revoked, replayed and cross-workspace requests fail. No new account, token,
invitation or membership exists before approval. Decisions record owner, requester
and grant version. Owner-approved memberships are independent, explicitly tracked
access and survive support revocation; unapproved requests cannot execute after
revoke/regrant. Revoke approved memberships through ordinary membership controls.
Existing credentials are not reset. Invitation failure is reported separately from
persisted membership; normal recipient account recovery remains available.

Raw settings/connection errors, content, source selections, profile data, usage,
credentials and token material are withheld. Description and recorder text are
write-only. OAuth toggles preserve credential ownership, scopes and source selections;
disconnected/error connections require the existing owner reconnect flow. No sync job
is launched by the configuration endpoint; existing scheduled workflows consume the
updated settings. Recording preferences preserve recording enablement/consent.

Owner-controlled limits are explicit: support policy/opt-out, password/email identity
changes, SSO trust, consent and source selection, recording activation, and arbitrary
outbound destinations. These can grant access to content, impersonate accounts, or
route content outside the workspace and are not configuration-only operations.
This is not a claim that every existing settings action is available to Setup.

## Local evidence

The support integration suite uses an isolated synthetic PostgreSQL database.
`scripts/support-access-local-smoke.mjs` and
`scripts/support-entrypoints-local-smoke.mjs` require localhost and the dedicated
`workspace_admin_support` database on port 55495. They seed only synthetic users,
block off-origin browser requests, clean their fixture IDs, and write ignored
screenshots under `.artifacts/support-access`. No worker should run for this fixture.

These tests are not live customer, provider, or deployment acceptance. Existing
workspaces need verified ownership before their first support grant. PR2 external
workspace connections remains separate and must consume the stable permission
contract rather than infer authorization from operator identity.
