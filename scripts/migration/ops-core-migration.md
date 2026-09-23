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

Keep plan and credential JSON files owned by the operator with mode0600 and no
symlinks. Credentials are separate from the retained plan:
`sourceConfig`, `readerConfig`, `targetAdminConfig`, `objectSource`, `redisSource`
and optional `railwayToken`. PostgreSQL objects use the existing rehearsal config
shape; the Azure connection requires verified TLS. Keep artifacts in a private,
ignored directory.

## Execute one domain

```sh
npx tsx scripts/migration/run-ops-core-migration.mjs initialize /private/plan.json
npx tsx scripts/migration/run-ops-core-migration.mjs status /private/plan.json
npx tsx scripts/migration/run-ops-core-migration.mjs fence /private/plan.json /private/credentials.json
npx tsx scripts/migration/run-ops-core-migration.mjs transfer /private/plan.json /private/credentials.json /private/evidence
npx tsx scripts/migration/run-ops-core-migration.mjs activate /private/plan.json /private/credentials.json
```

`initialize` retains the exact plan and creates a stable per-domain journal. An
interrupted initialization reuses only matching retained content. Each subsequent
command acquires that journal's lease and rereads the plan.

`fence` checks prepared target resources and private storage before stopping
source writers and automatic triggers. It leaves source PostgreSQL running,
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

An ambiguous effect retains intent and evidence. Source operations reconcile
recorded effects. Transfer or activation with an inherited pending phase requires
explicit reconciliation; repeating a command does not replay the effect. Inspect
the journal, immutable operation records and actual provider state. After the
recorded target-write boundary, recover forward on Azure; the retained source is
no longer a safe automatic routing fallback.

`TARGET_ACTIVE` is a startup checkpoint. Domain routing/TLS, callback and login
continuity, named business workflows, backup/recovery and repeatable direct Azure
updates require separate acceptance. The accepted cutover journal remains intact
and must not be reset for future releases. Independent QA and normal protected
delivery precede production execution.

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
