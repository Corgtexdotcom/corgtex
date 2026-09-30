# Core retirement into selfserve

Customer application workflows move to the existing Azure selfserve runtime.
Ops remains the separate control plane. Do not provision a second Core app or
cancel existing services while the Microsoft milestone and recovery-retention
gates apply. Keep total Azure spend within the approved monthly ceiling.

## Public demo and lead cutover

The site defaults demo links, capture and qualification to selfserve. The
`DEMO_BACKEND_URL` override still binds both POST stages to one backend. Retain
the Core override on the running site until the lead transfer is accepted; do
not deploy the new default over unmigrated qualification links. There is no
automatic fallback, token copying between MCP issuers, or repeated POST retry.

Use `core-lead-transfer-cli.ts` for the bounded case where Core's internal CRM
has unconverted leads without qualification, conversation or prospect-workspace
references, and the existing selfserve internal CRM is empty. A changed closure
requires a new reviewed migration; it is never silently discarded. The generic
tenant importer continues to reject an existing-workspace collision.

1. Refresh the production owner handoff, release lease/concurrency, active Ops
   workspace mappings, exact web/worker releases and rollback destinations.
   Review the destination's exact member IDs as the intended CRM recipients.
2. Release the reviewed intake-fence code to every active writer replica in both
   runtimes. Install disabled `crm_public_writes_paused` markers, then drain
   HTTP/database transactions that could have passed the check before marker
   installation. Subsequent requests lock the marker for their transaction;
   enabling it waits for those writes. Hold consumers with
   `operator_import_inactive`. Drain consumer/scheduler iterations and claim
   transactions spanning hold activation, as well as already-claimed work.
   Verify no event or job retains a claim lock and no job is running; a zero job
   count alone does not prove quiescence. Fence other CRM/admin writers and
   provider callbacks under the same owner. Record this drain evidence before
   snapshot/import and keep both holds enabled throughout. These markers alone
   do not fence arbitrary administrative mutations or preselected scheduling.
3. Keep both source and target public intake and consumers held during the
   snapshot/import. Do not enable destination drip campaigns during transfer.
   Preserve the markers' prior state in the private cutover journal.
4. Prepare a private configuration containing `binding.source` and
   `binding.target` (`host`, `port`, `database`, `user`, `workspaceId`), the
   reviewed `binding.targetMemberIds`, and `runtime.source`/`runtime.target`
   (`origin`, `sha`). Both workspace slugs must be `corgtex`; their IDs differ.
   Bind these values independently of the connected clients. Runtime SHA checks
   require baked release evidence, healthy database/schema and no drift.
5. Use a directory outside the repository with mode 0700 and files mode 0600.
   Supply database URLs through `TRANSFER_SOURCE_DATABASE_URL` and
   `TRANSFER_TARGET_DATABASE_URL`; use `TRANSFER_TLS_CA_FILE` if needed. Remove
   URL SSL overrides and require certificate/hostname verification. Never log
   database credentials, lead payloads or qualification tokens.

   ```sh
   node --import tsx scripts/migration/core-lead-transfer-cli.ts prepare /private/config.json /private/leads.json
   node --import tsx scripts/migration/core-lead-transfer-cli.ts import /private/config.json /private/leads.json --execute
   ```

   Preparation is read-only. Import rechecks the original live source, target
   schema, exact recipients, both holds and claimed jobs. It preserves lead IDs,
   tokens, counters and timestamps. Linked delivery receipts retain their IDs,
   provider state and timestamps; old job references are detached only in the
   target and retained in the private bundle. Member-linked delivery history
   blocks this scoped operation. It creates no memberships, credentials, events
   or jobs, and does not activate the workspace or change routing.
6. Verify the receipt and exact rows while held. An identical rerun verifies
   rather than replays; changed rows, receipts, IDs, emails or tokens abort.
   Switch the site backend and localized demo links together. Lift only the
   target's public writer hold for acceptance; keep its consumer hold enabled
   so acceptance writes do not dispatch emails or jobs. Verify one old link,
   a new lead, the isolated demo and blocked mutations. Separately restore
   the reviewed consumer state after acceptance and explicit permission for
   outbound messages. Leave source writers fenced.

Before target writes, restore the recorded routing and holds for rollback.
After target writes, keep selfserve as data owner or reconcile its delta before
restoring Core traffic. A DNS reversal alone is not a data rollback.

## Remaining Core dependencies and final cleanup

The scoped lead operation does not evacuate the internal dogfood tenant, its
Slack installation, support MCP credentials, other retained tenants or pending
work. Inventory and assign each required writer to selfserve, Ops or retirement.
Use managed reconnect for legacy MCP clients, preserve exact workspace consent
and scopes, and exercise actual tools before changing the legacy hostname.
Selfserve and legacy MCP issuers/resources must not be treated as interchangeable.

Review actual provider destinations and event delivery for configured Slack,
Google/Microsoft OAuth, Stripe, Resend, recorder/transcript and CRM integrations.
Keep customer callbacks distinct from operational alerts, which belong to Ops.
Exercise configured external MCP servers under the connecting user's workspace;
an empty inventory means no configured server, not successful tool execution.
Connector or provider access failures remain acceptance blockers. The public CRM
Resend callback consumes only the configured `EMAIL_REPLY_TO` recipient into the
internal `corgtex` workspace. Its receiving API key must read email bodies; a
sending-only key is insufficient. Validate the provider mailbox/forwarding and
metadata-only event before enabling a disabled webhook. Provider email IDs retain
an atomic receipt, so retries do not duplicate qualification or conversation data.

Once replacements are accepted, remove obsolete Core defaults, CI/smoke/rollback
dependencies, registrations and configuration. Preserve recovery code and source
records while they remain in use. Observe Core request paths and queues for an
explicit window before claiming zero required traffic or logical retirement.
Record each deferred physical resource's exact identity, owner, retention reason,
removal condition and recovery implications. Physical cancellation is a later
explicit decision after the credit, recovery, cost and traffic gates permit it.
