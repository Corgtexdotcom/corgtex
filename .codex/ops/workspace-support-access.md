# Workspace support access

Critical risk: workspace authorization, delegated credentials, SSR/API boundaries,
background provenance, and four schema/data migrations change together. Do not
deploy only the enum/schema or UI portions. Independent integrated QA is required.

## Owner rollout gate

New workspace creation records the creator; trial creation records the accepted
client administrator. Existing workspaces deliberately remain owner-null. Neither
the migration nor runtime infers ownership from ADMIN membership or global role.

Before enabling grants for an existing workspace, the delivery owner must provide
a private, explicitly approved rollout map with one row per intended workspace:

| Required field | Verification |
| --- | --- |
| deployment ID and workspace ID | Exact intended deployment and workspace |
| workspace slug | Corroborating human-readable identity, not the primary key |
| owner user ID and email | Existing named account, verified with the client |
| verification reference, approver, UTC time | Explicit client ownership confirmation |
| expected previous owner ID | Null for initial adoption; never overwrite implicitly |

No verified legacy-owner rows were supplied with this implementation. Their
assignment remains BLOCKED; do not substitute the first/oldest ADMIN. Keep this map
outside the repository. A separately authorized rollout must lock the workspace,
compare its previous owner, verify active HUMAN ADMIN membership and no support
grant on the proposed owner, assign `supportOwnerUserId`, and audit the IDs and
verification reference. This implementation performs no such live assignment.

## Product behavior

- The owner grants SETUP (default) or explicitly confirms FULL to an existing named
  account. A grant cannot overwrite an existing ordinary active membership.
- Setup has no content membership. Its DTO allows workspace name, its own role and
  revisions, provider/status enums, connector drafts, and onboarding booleans only.
  No member identities, provider account/channel/document labels, counts, errors,
  credentials, content previews, exports, or outbound tests are returned.
- Setup prepares Google Calendar/selected Drive, Microsoft Calendar, or selected
  Slack channels. Calendar import defaults off. Drafts change no active connector,
  schedule, recording policy, destination, or provider credential.
- The verified owner reviews a particular draft revision and starts consent under
  their own session. Google purpose and calendar import are carried in signed
  state. Slack preparation forces selected-channel admission and disables broad
  archive/autojoin. Prepared flows reject existing connections, including at save.
- Full has actual ADMIN membership and the normal workspace admin rules. Audited
  Google/Microsoft/Box, Slack and disconnect routes accept Full, but independently
  require the target workspace. Callbacks validate current membership and the
  originating grant version before token exchange. A downgrade/regrant cannot
  revive an older consent state. Slack state is server-authenticated with a
  purpose-bound HMAC and ten-minute expiry; unsigned legacy state must restart
  consent. Control-plane authority is separate and is neither granted nor revoked
  by a tenant support grant. Owner-grant management is not delegated to Full.

Tenant grants never update User flags or global roles. Existing platform privileges,
ordinary membership, credentials and work in another workspace remain independent.
`isSupportAccount` is retained only as historical legacy-impersonation metadata, not
an authorization switch. Product workspace lists omit explicitly restricted grants;
the separate infrastructure authority remains unchanged.

## Authorization contract and limits

`requireWorkspaceMembership` is the authoritative content gate, including stale
actor/cached membership callers. `supportCapabilityVersion` is an additional
credential-version check, not membership authorization. Null stored versions are
not legacy compatibility for a user with a support grant. Queued Event/WorkflowJob
provenance is persisted and `withWorkspaceSupportExecution` checks it before the
handler. Revoked jobs fail permanently without invoking content handlers.

Credential issuance/redemption, MCP/OAuth, AppSession, web/GPT/SSR, agent conversation
history/stream chunks, and protected downloads participate. Direct and transactional
bulk Event/WorkflowJob writes carry provenance. New raw/nested job writers must use
the same contract; current wrappers are not a general database row-level policy.

Revocation stops managed support credentials and future authorized operations. It
does not retract previously disclosed/downloaded data, undo completed admin edits,
or cancel an external operation already in progress. Owner-consented provider
connections and durable workspace configuration are workspace resources, not
temporary support sessions. Provider account permission remains provider-controlled.

Workspace-specific MCP URL/resource correspondence is a separate integration. Do
not duplicate this policy there: require exact endpoint/token/resource workspace
equality, then current membership and the stored support grant version. Shared MCP
client registration is not workspace authorization.

## QA entry points

Run the support domain integration suite against a dedicated local migrated DB,
the provider route and outbox runtime suites, and the normal repository checks.
`scripts/support-access-local-smoke.mjs` is localhost-only and cleans its own
synthetic fixture IDs. Screenshots belong in ignored `.artifacts/support-access/`.
Exercise Setup direct API/SSR/action replay, cross-workspace denial, grant version
revocation/regrant, owner-only consent review, immutable preparation, and real
handler denial. Provider network calls in route tests are mocked; live consent and
production deployment are not claimed by local evidence.
