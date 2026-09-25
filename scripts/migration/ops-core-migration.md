# Ops and Core migration operator

Migrate Core first, then Ops after Core acceptance. The operator keeps the full
database, durable job state and bucket contents, with an independent Azure Blob
lease and journal. Retain source services, archives and recovery evidence.

## Prepare

Deploy the backing resources in `infra/azure/ops-core/` within the agreed cost
envelope. Verify their identities, private endpoints, runtime identity grants and
operator access. Use temporary exact-IP PostgreSQL transfer access only for the
external copy; remove its firewall rule and disable public access afterward.

Publish immutable web and worker images. Prepare the exact Manual job definitions
returned by `buildRedisProbeJobDefinition()` and `buildHealthProbeJobDefinition()`.
Both jobs use the worker image with a node-only probe command; they must be
readable through ARM and their completed output through Log Analytics. Compute
each probe build hash from the published image's files. Exercise private
connectivity and fresh job-log retrieval before stopping source writers.

Use `retainOpsCoreRuntimeConfig()` to preserve the reviewed source environment
inventory in the new runtime vault. It retains application values byte-for-byte,
checks continuity secrets, replaces infrastructure endpoints and returns immutable
versioned references. Supply the same Next Server Actions key when building the
web image. Keep source public origins and provider callback registrations stable.

Freeze one private global plan containing `source`, `azure`, `transfer`, `redis`,
`activation`, `health` and `operator`. The exported validators check the static
transfer, startup and probe contracts before initialization. The operator section
binds expected Azure subscription/tenant/principal, independent custody/archive
containers, target object container and exact Railway source bucket. Runtime
storage and custody/archive storage use different accounts.

Declare `activation.roles.web.resources` and `activation.roles.worker.resources`
independently, for example `{ "cpu": 1, "memory": "2Gi" }`. There is no implicit
allocation: plans missing resources are rejected before effects. Use numeric CPU
from 0.25 through 4 in quarter-core steps and matching memory at twice that value
in GiB (canonical strings such as `"1Gi"`, `"1.5Gi"` or `"2Gi"`). These are the
[Consumption CPU/memory pairs](https://learn.microsoft.com/en-us/azure/container-apps/containers#vcpu-and-memory-allocation-requirements).
Activation derives [ephemeral storage](https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts#ephemeral-storage)
from CPU and binds the selected resources into the plan hash and exact revision
readback. Price and qualify startup, migration and representative concurrent work
at the selected allocation before cutover; quiet average usage is insufficient.
Adding resources changes the frozen plan: prepare it before custody initialization,
never rewrite an in-flight plan to bypass reconciliation. This does not resize an
existing app or prove workload capacity.

### Shared PostgreSQL runtime access

An explicitly reused PostgreSQL server (`azure.postgres.resourceGroupName`) requires
`transfer.postgres.runtimeAccess` and the identical policy in `activation.runtimeAccess`.
Use the PostgreSQL shared-state variant and demand-based worker plan. Historical
dedicated-server plans retain their existing shape; do not edit an initialized
plan or reuse its receipts to add shared-server authority.

The access policy binds `schemaVersion:1` (or the explicit Azure profile below),
`applicationSchema:"public"`, the ordinary
`runtimeRole` (`corgtex_<domain>_runtime`), exact versioned `runtimeDatabaseSecrets`
for web and worker, and `scaler:{role,connectionSecretVersion}` for
`worker_scale_<domain>`. Retain independently generated credentials before freezing
the plan; SQL roles do not need to exist yet. Set the runtime-config binding's
`postgresUser` to the exact runtime role. Web/worker versions must resolve to the
same runtime identity and password; the scaler has a distinct credential and only
queue eligibility column access. Activation binds these references to the actual
application and scaler secret references; no latest-version lookup is permitted.

`isolation` contains the reviewed `inventorySha256` and a complete `databases`
inventory outside this domain's permanent database. Each item binds `name`, `oid`,
`owner`, `beforeAclSha256`, `action` and `preserveConnectRoles:[{name,oid}]`.
Use the catalog collector and `postgresRuntimeAccessIsolationInventory()` to
compute these values. `replace-public-connect` preserves existing named grants
and adds explicitly reviewed legitimate users before removing PUBLIC CONNECT;
`verify-only` never alters the database. Do not infer a legitimate-user allowlist
from a PUBLIC grant. Version 1 keeps effective foreign `CONNECT` denied everywhere.
For Azure Flexible Server PG18 only, `schemaVersion:2` with
`providerProfile:"azure-flexible-postgres-18"` permits `allow-provider-connect`
on pinned `azure_sys` and `azure_maintenance` owned by `azuresu`, and
`template1` owned by `azure_pg_admin`. This action never changes provider ACLs.
Names, OIDs, owners, normalized ACL hashes, template state, and effective
runtime/scaler `CONNECT` must match the reviewed inventory. `postgres` retains
normal PUBLIC revocation. All application databases, including the other
CORGTEX domain, must deny effective foreign `CONNECT`.

The Azure profile requires exact known preload modules, disabled Query Store
capture, utility tracking, wait sampling, plans, `pg_stat_statements` capture,
and settings that prevent credential SQL from entering logs or activity. It
checks Azure server parameters and effective PostgreSQL settings with no
pending restart before credential SQL and around commit. Parameter changes
are a separate controlled operation; any mismatch fails closed. After
activation, `monitorOpsCoreRuntimeAccessDrift()` checks retained database
identities/ACLs for this domain and provider databases, provider capture
settings, bounded Query Store history, and effective foreign `CONNECT` without
comparing application object catalogs that may legitimately change. A later
Core/Ops database may appear with its own grants; it remains denied to the
other domain's roles. The monitor has a manual CLI action and is an acceptance
gate; a protected recurring schedule must be configured separately.

Preflight validates credentials, exact database ACL inventory and session logging
controls before source fencing. The transfer holds a shared PostgreSQL maintenance
session lock in `postgres`, in addition to its independent per-domain Blob lease.
Production scratch databases start with connections disabled and open only after
their administrator-only access is proved. All earlier rehearsal writers must
still be drained before server promotion; advisory locks do not fence old tools.

After promotion, one transaction creates the two roles, transfers only manifested
application objects, preserves database/schema/extension ownership and administrator
readback, and applies the exact foundation ACL policy. No `REASSIGN OWNED` or role
adoption is used. The before-manifest and intent are retained before the transaction;
the expected after-manifest is durably read back before COMMIT. A lost acknowledgement
requires `reconcile-transfer`, which reports applied, unchanged or indeterminate
state without replaying SQL. If promotion completed before the access intent was
created, reconciliation reports `CONTINUATION_AVAILABLE`; `resume-transfer`
rechecks promoted data and dispatches that first access attempt. An inherited
intent is only reconciled, including on resume. Missing proof leaves verification pending.
Do not reset passwords or reverse ownership automatically to recover.

Activation requires the retained receipt and a fresh catalog/credential check before
its first write. After activation may have written or migrated, reconciliation
validates historical receipt bindings rather than comparing old catalogs to
legitimate new migrations. Actual Azure administrator permissions, provider-database
isolation and legitimate foundation access must be qualified before production;
local fixture success is not that proof.

Dispatch **Azure Migration PostgreSQL Restore Rehearsal** on protected `main` with
`operation=qualify-access` and `domain=ops` while the candidate server is stopped.
Its bounded lifecycle uses the protected administrator credential, opens one
temporary runner IP, captures a read-only catalog and session-setting receipt in
the private `azure-target-qualification-*` artifact, removes the rule and stops
the server. `shared-postgres-access.json` records exact database ACLs, roles,
memberships, provider logging hooks, which session settings the administrator can
set, effective setting values and Azure parameter readback, including parameter
mutability metadata when Azure supplies it. It reads PUBLIC schema and object
grants (including column-level `PUBLIC SELECT`), callable functions and security-definer functions in `azure_sys`,
`azure_maintenance` and `template1`. It records only existence booleans for rows
in every publicly selectable provider relation and the named Query Store views.
These reads use the administrator, so their success alone does not prove an
ordinary role's effective access. It never exports query text or customer rows.
Unknown or unreadable history is not empty-history proof. The receipt explicitly has
`admissionReady:false`; inspect it and the separate cleanup receipt before
choosing foundation ACL policy or promoting the server. An exception for
Azure-managed provider database access is a material security-contract decision,
not an automatic consequence of this probe. A failed cleanup uses the existing
`target-qualification` recovery operation with the original run ID and attempt.

The opt-in local fixture runs with
`CORGTEX_RUNTIME_ACCESS_LOCAL_TEST=1 node --test scripts/migration/ops-core-postgres-runtime-access.integration.node-test.mjs`.
It requires a preloaded local PG18/vector0.8.2 image; set
`CORGTEX_RUNTIME_ACCESS_PG_IMAGE=sha256:<image-id>` to choose that exact image.
It uses `--pull=never`, verified local TLS, randomly named owned resources and
cleanup readback. The default image ID refers to the private local qualification
image, not a public download. Default test runs skip this explicit local fixture.

Keep plan and credential JSON files owned by the operator with mode0600 and no
symlinks. Credentials are separate from the retained plan:
`sourceConfig`, `readerConfig`, `targetAdminConfig`, `objectSource`, `redisSource`
and optional `railwayToken`. PostgreSQL objects use the existing rehearsal config
shape; the Azure connection requires verified TLS. Keep artifacts in a private,
ignored directory. Before fencing, retain the exact original source PostgreSQL
password in the independent custody vault and bind its immutable version as
`source.postgres.originalSecretVersion`. Keep `retainedSecretVersion` as the
separate rotated recovery credential. Admission verifies both references and
actual source admin/reader access; passwords never enter the retained plan.

Bind `source.health` to the Railway project/environment and exactly one web and
one worker service. Each service declares its role, service/deployment IDs,
loopback port and expected `release` (`gitSha`, `imageTag`, `version`). Before fencing,
the operator retains health proof from the exact running instances via read-only
Railway SSH, including their baked build SHA/role. Older health endpoints may lack
baked runtime metadata; the separate build file supplies that identity evidence.
Recovery checks the same deployments/releases, healthy web database
and schema, and worker readiness before restoring triggers and completing.
Completed scheduled deployments remain stopped; recovery never replays them.
An effective cron schedule must have a matching explicit configured override.
File-only schedules are rejected before fencing because removing an override to
restore inherited behavior is not supported by this operator.

## Execute one domain

```sh
npx tsx scripts/migration/run-ops-core-migration.mjs initialize /private/plan.json
npx tsx scripts/migration/run-ops-core-migration.mjs status /private/plan.json
npx tsx scripts/migration/run-ops-core-migration.mjs preflight /private/plan.json /private/credentials.json
npx tsx scripts/migration/run-ops-core-migration.mjs fence /private/plan.json /private/credentials.json
npx tsx scripts/migration/run-ops-core-migration.mjs transfer /private/plan.json /private/credentials.json /private/evidence
npx tsx scripts/migration/run-ops-core-migration.mjs activate /private/plan.json /private/credentials.json
```

`initialize` retains the exact plan and creates a stable per-domain journal. An
interrupted initialization reuses only matching retained content. Each subsequent
command acquires that journal's lease and rereads the plan.

`preflight` checks actual source admin/reader access, target PostgreSQL TLS login,
identity and restore authority, versioned archive-key access, bounded source
object inventory/reads, exact prepared probe jobs and their Log Analytics query
access. It retains a private immutable receipt without stopping writers or
starting a probe job. It is current admission evidence, not final data parity or
lasting authority. An inherited partial fence uses its own credential-reconciliation
guards rather than demanding that the already-rotated original password work.

`fence` repeats dependency admission and retains original deployment and trigger
baselines before stopping source writers. It leaves source PostgreSQL running,
rotates the runtime credential to its retained recovery version, terminates old
runtime sessions and verifies reader/recovery access.

`transfer` captures PostgreSQL, encrypts and retains the archive, downloads and
restores that retained archive, verifies schema/table/job/sequence parity, copies
the full object inventory, promotes the scratch database and verifies final
fenced source/private-target Redis state. Nonempty Redis blocks empty-state
acceptance; it requires a preservation path before proceeding.

`activate` records the target-write boundary before creating the web app with
`migrate-and-web`. After exact web release/schema health, it creates one worker
and checks running health through the private probe job. Normal busy readiness
responses are polled within that same bounded job. Fresh ARM, health and source
fence evidence precede `TARGET_ACTIVE`.

## Recovery and acceptance

An ambiguous effect retains intent and evidence. Use the explicit reconciliation
commands; they read actual provider state and seal only proved results. They do
not repeat database restores, object copies or app creation. Fresh private probe
jobs may run to observe health or Redis. Unknown or running probe starts must
settle before another observation can begin.

```sh
npx tsx scripts/migration/run-ops-core-migration.mjs reconcile-transfer /private/plan.json /private/credentials.json /private/evidence
npx tsx scripts/migration/run-ops-core-migration.mjs resume-transfer /private/plan.json /private/credentials.json /private/evidence
npx tsx scripts/migration/run-ops-core-migration.mjs reconcile-activate /private/plan.json /private/credentials.json
npx tsx scripts/migration/run-ops-core-migration.mjs resume-activate /private/plan.json /private/credentials.json
```

Capture and restore retain the exact scratch database OID, archive binding and
parity evidence independently. A completed capture can continue its first restore
only into the same proven empty scratch database, with no prior restore intent.
A partial or ambiguous restore stays preserved; it is never overwritten or
replayed. Production migration markers never authorize the legacy rehearsal
cleanup command, including after reconciliation or promotion. Activation reconstructs its exact retained app definitions and checks
fresh revisions, replicas, health and PostgreSQL access closure. Explicit resume
can create a remaining app only when no intent for that creation exists.

A completed `TARGET_ACTIVE` reconciliation validates the retained phase plan,
provider receipts and completion lineage and returns historical evidence without
provider calls. It makes no fresh-health claim.

Before the recorded target-write boundary, an interrupted transfer can explicitly
recover service on the retained source:

```sh
npx tsx scripts/migration/run-ops-core-migration.mjs recover-source /private/plan.json /private/credentials.json
npx tsx scripts/migration/run-ops-core-migration.mjs reconcile-source-recovery /private/plan.json /private/credentials.json
```

Recovery proves Azure apps inactive, settles owned source-fence effects, restores
the retained original credential and exact writer/trigger baselines, and records
terminal `SOURCE_RECOVERED` while preserving interrupted transfer history and
target evidence. `recover-source` may explicitly continue unattempted recovery
effects; inherited ambiguous intents only reconcile. `reconcile-source-recovery`
never starts a new effect. Missing baseline or unknown provider ownership blocks
recovery. The terminal cutover cannot later activate Azure; do not reset it or
delete retained databases/archives to reuse the old migration identity.

After the recorded target-write boundary, recover forward on Azure; the retained
source is no longer a safe automatic routing fallback. Do not reset journals or
use a new operation identity to bypass an unresolved effect.

`TARGET_ACTIVE` is a startup checkpoint. After separately changing DNS and binding
TLS domains, record routing through the supported operator:

```sh
npx tsx scripts/migration/run-ops-core-migration.mjs record-routing /private/plan.json /private/credentials.json /private/evidence /private/routing.json
npx tsx scripts/migration/run-ops-core-migration.mjs retain-acceptance-evidence /private/plan.json /private/credentials.json /private/evidence /private/workflow-receipt.json
npx tsx scripts/migration/run-ops-core-migration.mjs accept /private/plan.json /private/credentials.json /private/evidence /private/acceptance.json
npx tsx scripts/migration/run-ops-core-migration.mjs monitor-access /private/plan.json /private/target-credentials.json
```

Routing and acceptance artifacts have `schemaVersion:1`, `phase` (`ROUTED` or
`ACCEPTED`), `binding`, UTC `issuedAt`/`expiresAt` (at most24 hours apart), and
`attestations`. The exact binding contains `domain`, `intentSha256`,
`targetBindingSha256`, `release`, `sourceFenceSha256` and `routes`. Each route has
`publicOrigin`, `azureOrigin` and `expectedCname`. Core requires both app and MCP
origins; Ops requires its Ops origin. Azure origins must match the app's freshly
observed ARM hostname. DNS must directly name that hostname, and public HTTPS
health must have valid TLS and the exact release. The operator does not edit DNS.

Routing has an empty attestation list. Acceptance requires six named receipt
references `{kind,name,evidenceSha256}`, one for each of `workflow`, `data`, `jobs`,
`callbacks`, `backupRecovery` and `updateRecovery`. Retain each complete receipt
first using `retain-acceptance-evidence`. Its fields are `schemaVersion:1`, the
same `binding`, `kind`, `name`, UTC `observedAt`, `outcome:"passed"`,
`attestationType:"operator-reviewed"`, `reviewedBy`, and nonempty `details`
containing the actual reviewed evidence. The returned canonical hash becomes the
reference. These are explicit operator-reviewed workflow and recovery receipts;
this command does not perform those exercises for you.

The exact artifact and referenced receipts are read back from independent storage
before advancement. Fresh runtime, source-fence and routing proofs precede journal
completion. For the Azure provider profile, `accept` also requires a fresh
read-only access monitor pass. `monitor-access` can run in `TARGET_ACTIVE`,
`ROUTED`, or `ACCEPTED` with no pending mutation, using only target administrator
credentials; it reports a timestamp and result hash and can still run after
source retirement. No recurring monitor is installed by this command.
Expiry governs initial admission; an already-pending routing/acceptance action
keeps the exact retained artifact and can reconcile after expiry through fresh
observations. Repeating that action with the same artifact reconciles it; a lost completion acknowledgement returns historical evidence and
makes no fresh-health claim. `ACCEPTED` then provides the retained authority used
by direct updates. Keep that journal intact for future releases. Independent QA
and normal protected delivery precede production execution.

## Direct Azure updates

The direct update path uses its own stable per-domain Blob lease. It leaves the
accepted migration journal intact and calls Azure directly, so taking Ops offline
does not remove update or recovery authority. A release plan binds the accepted
migration, exact Azure resources, immutable baseline/incoming/recovery images and
a retained compatibility review. The historical source-fence hash provides
provenance; it is not represented as a fresh Railway observation.

Retain a reviewed compatibility proof before dispatch. It identifies the exact
baseline, incoming and recovery image pairs and confirms that the recovery images
can run against the schema after the incoming migrations. This review is required
even when recovery reuses a previous application version. The updater does not
infer backward schema compatibility from image age, health or a successful build.

Prepare separate immutable worker health job definitions for baseline, incoming
and recovery releases. The update preflight verifies that both incoming and
recovery image digests exist in ACR. It retains the complete baseline templates,
stops the old worker and web revisions, runs web migrations, checks web health,
then starts the new worker. Both apps return to Single revision mode before final
private worker health and exclusive-revision acceptance.

The private update envelope has `schemaVersion:1`, a controller `plan`,
`operator:{custodyContainerUrl,azureIdentity:{subscriptionId,tenantId,principalName}}`
and three static health plans under `health:{baseline,incoming,recovery}`. Their
job IDs must be distinct. `validateUpdateEnvelope()` and
`validateOpsCoreUpdatePlan()` define the exact input contracts. Keep this envelope
mode0600; it contains resource and review references, never runtime credentials.

Retain the reviewed compatibility JSON at
`compatible-release-proofs/<canonical-sha256>.json` in the independent custody
container. Its exact fields are `schemaVersion:1`, `domain`,
`targetBindingSha256`, `baseline`, `incoming`, `recovery` and
`compatibleRecovery:true`. Hashes use `archiveEvidenceHash()` over parsed JSON.
The three release pairs must equal those in the update plan. The plan also binds
the complete accepted migration journal hash, original migration intent hash and
historical source-fence evidence hash.

```sh
node scripts/migration/run-ops-core-update.mjs apply /private/update-envelope.json
node scripts/migration/run-ops-core-update.mjs reconcile /private/update-envelope.json
node scripts/migration/run-ops-core-update.mjs recover /private/update-envelope.json
```

The CLI verifies the current Azure identity before opening storage, rereads the
accepted migration and compatibility evidence, and freezes the full envelope per
release ID so an alternate health job cannot bypass an uncertain start. A finished
release returns `RETAINED_RESULT` with `freshAcceptance:false`; this is historical
evidence, not a new health observation.

For GitHub execution, configure protected environments `ops-core-release-core`
and `ops-core-release-ops` with `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID` and `OPS_CORE_CUSTODY_CONTAINER_URL` variables and matching
OIDC trust. The principal needs the scoped app/revision update, probe-job start,
Log Analytics read, ACR manifest read and independent custody Blob operations.
Provision and verify that access before retiring any source deployment path.
The workflow does not create identities, grant permissions or provision resources.

Publish the envelope create-only at
`update-plans/<domain>/<canonical-sha256>.json`, then dispatch **Ops and Core Azure
Update** from `main` with that domain, hash and action. It checks out the exact
workflow commit, verifies the downloaded envelope against the protected storage
and identity variables, and runs without an Ops API or database dependency.

An interrupted update is reconciled through retained provider intents and fresh
reads. An explicit recovery uses distinct recorded effects and the approved Azure
recovery images. It preserves the current database; it does not reactivate the old
Railway source. Unknown forward effects must settle before recovery proceeds.
Never clear an unfinished owner or use a new release identifier to bypass it.
If ownership was interrupted before baseline retention, reconciliation first
proves the operation prefix is empty. A preflight failure after retention can
also finish unchanged when the complete prefix contains only the baseline and
validated baseline observation records, with no runtime mutation intent. It
checks the unchanged baseline pair using only its health job and finishes with
`UNCHANGED`. This releases the unused attempt without starting an update.
A lost final-result acknowledgement reuses the exact retained result
after fresh verification; refreshed proof is stored separately.

These release checks prove deployment identity and point-in-time runtime health.
Named workflows, callback continuity, backups and observation remain separate
production acceptance evidence.

Focused checks are `npm run test:migration:ops-core` (including local PostgreSQL
and Blob protocol fixtures) and the Vitest unit tests for the transfer controller,
operator and object adapters. Local fixtures establish tool behavior; cloud and
production acceptance need fresh evidence from their actual targets.
