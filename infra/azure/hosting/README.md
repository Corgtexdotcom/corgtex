# Site and monitor Azure hosting preparation

These independent bootstrap templates reuse an existing Consumption Container Apps
environment, ACR and user-assigned identity. They create only one site app or one
manual monitor job. They do not create a provisioned compute plan, database, cache,
registry, identity, role assignment, DNS record or custom-domain certificate.
The separate `site-identity.bicep` prepares a new dedicated site identity and one
registry-scoped AcrPull assignment; it is not invoked by either hosting template.
Do not deploy this access template until explicitly approved.
Consumption execution, requests, image storage and logs can still add usage charges;
reuse is not a promise of zero cost. Provisioning and cutover remain coordinated
operations. Template compilation and image builds do not migrate hosting.

## Build and validate

`Hosting Images` is a manual workflow in `fleet-release-production`. It publishes
site and monitor images under the repository's GHCR namespace, using
`build-<run-id>-<attempt>` aliases. Tags are not immutable deployment references:
the same source commit can build different bytes with changed public settings or
base images. The workflow records the actual publish-step digests, source commit,
run and attempt in `receipt.json`, uploads the receipt as
`hosting-images-<run-id>-<attempt>`, and displays digest references in its summary.
It neither logs into Azure nor deploys anything. Dispatch from the approved merged
revision and import only the receipt's `repository@sha256:<hex>` source references
through the authorized import path. Import into ACR repositories `corgtex/site`
and `corgtex/ops-monitor`; verify each imported digest equals its receipt before
preparing candidate parameters. Stop on mismatch; never substitute a tag lookup.
Set `siteImageSha256` and `monitorImageSha256` to the corresponding 64 hex
characters (without `sha256:`). Templates construct digest-only ACR references;
they no longer accept arbitrary image or tag parameters. Preserve the source and
import readback receipts alongside candidate acceptance and rollback evidence.

Before building, match these environment variables in the workflow environment to
the source site: `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_DEMO_URL`,
`NEXT_PUBLIC_BOOK_DEMO_URL`, `NEXT_PUBLIC_INTERCOM_APP_ID`, and
`NEXT_PUBLIC_INTERCOM_API_BASE`. They are public build arguments, not secrets.
Next.js embeds public values at build time; changing Azure runtime variables alone
does not correct a wrong signup target or restore the Intercom widget. Omitted
Intercom app ID disables the widget, so its presence must be checked for parity.
The default production URLs route signup and login to selfserve while demo still
uses the backup app. A rebuild needs its own receipt and digest acceptance even
at the same source commit; commit identity alone is not proof of image identity.

```sh
az bicep build --file infra/azure/hosting/site.bicep --stdout > /tmp/site.arm.json
az bicep build --file infra/azure/hosting/monitor.bicep --stdout > /tmp/monitor.arm.json
az bicep build --file infra/azure/hosting/site-identity.bicep --stdout > /tmp/site-identity.arm.json
node --test infra/azure/hosting/monitor.node-test.mjs
npx vitest run --project unit scripts/migration/site-candidate-smoke.test.mjs
npx vitest run --project unit scripts/migration/hosting-image-receipt.test.mjs
node scripts/check-public-docs.mjs
node scripts/check-private-boundary.mjs
```

The monitor contract test requires an installed standalone `bicep` CLI on `PATH`
(or `BICEP_CLI_PATH` pointing to it). It compiles with `--no-restore` and executes
the command with synthetic targets, an isolated environment and guards that reject
network probes and issue subprocesses. It needs no account, credentials or provider
access. Missing compiler or compilation failures fail the test; nothing is skipped.

Fill private copies of the example parameter files with the approved resource IDs
and image digests. The site must use its dedicated pull-only identity, never the
application production identity with ACR push/import rights. The access template
takes an identity name, the existing registry resource group and registry name.
Its nested `registry-pull.bicep` grants only AcrPull at that registry resource ID,
including when the registry lives in a different resource group. It grants no
subscription/resource-group role, Key Vault access, push, import or deletion rights.
After authorized deployment, verify the returned principal's effective direct and
inherited grants before attaching it to the site. An existing registry in ABAC
repository-permissions mode needs a separately reviewed repository-reader role;
do not silently change registry mode or widen permissions. The monitor likewise
needs a pull-capable identity approved for its purpose.
Review a targeted resource-group what-if and use incremental deployment only after
the coordinator authorizes the exact candidates and consumption.

## Site acceptance and cutover

The site uses a Node server: analytics and demo-lead API routes prevent a drop-in
static-blob deployment. It needs no database or Redis of its own. Preserve source
PostHog settings using `environmentVariables` and secure `posthogProjectToken`;
the template creates a Container Apps secret and an environment `secretRef`.
Supply the token privately through the protected delivery environment or an ARM
Key Vault parameter reference, never plaintext committed files, CLI arguments or
logs. The site runtime identity does not need Key Vault permissions.
The disabled-analytics example is preparation only, not production parity.

The bootstrap template serves the candidate on its Azure hostname, port 3000,
with health probes and scale 0-2. After creation, verify ready revision, provider
image digest, `/api/health`, and public site routes:

```sh
node scripts/migration/site-candidate-smoke.mjs "$CANDIDATE_ORIGIN" "$SIGNUP_ORIGIN"
```

This smoke never invokes demo or lead creation, analytics, or signup. It rejects
cross-host redirects and path/query changes before fetching a redirected URL;
only the requested route's canonical trailing slash is allowed. Separately
inspect mobile/desktop pages, canonical URLs, Intercom configuration and asset
loading. The existing `scripts/site-smoke.mjs` additionally exercises app demo
sessions; it is not a read-only candidate preflight.

The site still forwards production demo leads to `app.corgtex.com/api/demo-leads`;
demo links also depend on the backup app. Keep that service until
its own migration is accepted. Preserve intentional external integrations.

Coordinator sequence: approve candidate and any identity/secret changes; prove
candidate parity; bind DNS/TLS for each actual source domain including any apex
redirect; switch routing; prove the public domain serves the candidate and observe
forms/analytics with authorized test data. Retain Railway for DNS rollback. There
is no site-owned datastore to synchronize, but form writes must keep their intended
backend. Do not replay this bootstrap template over a domain-bound app: it has no
custom-domain configuration. Subsequent releases use image-only Container App
updates with digest/readiness/public-smoke proof and the previous image retained.

## Repeatable site image updates

Use `scripts/azure-site-image-release.mjs` with the published `receipt.json` and its
already-imported ACR digest. It defaults to read-only Azure planning and local
redacted evidence. No dependency installation is required. It never imports images,
replays Bicep, changes scale/domain/identity settings, or invokes selfserve fleet
or monitor release paths. The coordinator retains ownership of production writers.

Keep one private target file under ignored `.artifacts/`. Fill these placeholders
from the approved site's resource IDs and bound domains; the script reads the full
live configuration itself. The ACR must be in the same subscription (its resource
group may differ). Only the existing single-container `site`, Single revision,
Consumption app with external HTTPS ingress on port 3000 is supported.

```json
{
  "purpose": "corgtex-public-site",
  "subscriptionId": "00000000-0000-0000-0000-000000000000",
  "resourceGroup": "SITE_RESOURCE_GROUP",
  "appName": "SITE_APP_NAME",
  "containerName": "site",
  "resourceId": "/subscriptions/SUBSCRIPTION_ID/resourceGroups/SITE_RESOURCE_GROUP/providers/Microsoft.App/containerApps/SITE_APP_NAME",
  "registryResourceId": "/subscriptions/SUBSCRIPTION_ID/resourceGroups/REGISTRY_RESOURCE_GROUP/providers/Microsoft.ContainerRegistry/registries/REGISTRY_NAME",
  "registryServer": "REGISTRY_NAME.azurecr.io",
  "domains": ["corgtex.com", "www.corgtex.com"]
}
```

List exactly the domains bound to this app, which may differ from this example if
an apex redirect lives elsewhere. No domain or certificate binding is created.
Use an existing Azure CLI login with read access to the target and ACR manifests;
execution additionally needs Container App update permission. The script does not
grant access, change accounts, or install CLI extensions. Receipt origin and build
settings remain the coordinator's acceptance responsibility; a local JSON receipt
is validated structurally against the hosting workflow format, not authenticated
against GitHub.

Set `SITE_IMAGE` to the imported `REGISTRY.azurecr.io/corgtex/site@sha256:HEX`
reference matching the receipt, and `PREVIOUS_SITE_IMAGE` to the exact current ACR
digest reference from approved readback. Both are nonsecret image identifiers.
Each `--out` must be a new directory whose parent already exists.

```sh
# Read-only plan. Existing .artifacts/ contains target.json and receipt.json.
node scripts/azure-site-image-release.mjs \
  --target .artifacts/target.json --receipt .artifacts/receipt.json \
  --image "$SITE_IMAGE" --expected-current-image "$PREVIOUS_SITE_IMAGE" \
  --out .artifacts/site-release-plan

# Only when the coordinator authorizes this exact target and serializes writers.
node scripts/azure-site-image-release.mjs \
  --target .artifacts/target.json --receipt .artifacts/receipt.json \
  --image "$SITE_IMAGE" --expected-current-image "$PREVIOUS_SITE_IMAGE" \
  --execute --confirm-target "$SITE_RESOURCE_ID" --out .artifacts/site-release-run
```

`--confirm-target` must exactly equal the target file's full app resource ID.
Every Azure call pins the subscription. Resource IDs, ACR login server, imported
manifest digest, app/container, current digest and domain/certificate bindings are
checked before the sole `az containerapp update --container-name site --image ...`
write. A second app read immediately before submission detects intervening drift;
it is not an atomic lock. Keep all other writers fenced for the run.

Evidence uses a private directory (0700) and exclusive files (0600): `intent.json`
holds the previous image, redacted configuration and whole-configuration/template
fingerprints; `submitted.json` is written before submitting an update; successful
readback adds `after.json` and `ready.json`. Other outcomes write `result.json`.
Environment values, arguments, headers and arbitrary configuration strings are
redacted. Secret payloads are never requested, forwarded in argv or written to
evidence; provider stdout/stderr and raw CLI exceptions are never printed. Secret
names/references are checked, not secret values or external Key Vault contents.
Treat the local evidence as private recovery material, not a signed attestation.

Readiness polls for up to 300 seconds by default (`--wait-seconds 1..1800`,
`--poll-seconds 1..30`, default 5). Each CLI call is bounded to 30 seconds; polling
calls are further limited by the remaining readiness deadline. Preflight and the
single update submission precede that deadline. `READY` requires the latest ready
revision to contain the exact digest, be active/provisioned/healthy, and match the
original template and configuration. Environment values, secret references, domain
and certificate bindings, identity, registry settings, resources, scale, probes,
arguments and other configuration must remain unchanged. The full app fingerprints
exclude only the selected image and generated revision suffix; they are not
normalized for API response differences. Revision comparison alone allows omitted
`imageType` and `resources.ephemeralStorage` string fields, absent/null
`customMetricsSettings`, and absent/null scale cooldown/polling values equivalent
to defaults 300/30. Explicit revision values are compared; nondefault scale values,
CPU, memory, replica bounds and rules remain checked. If the revision omits image
type or ephemeral storage, their preservation is proved by the full app readback,
not independently by the revision response. The expected revision template comes
from live app readback only after its full fingerprint matches the saved baseline,
so existing intents need no rewrite or new plaintext configuration evidence.
A scale-to-zero
revision can pass only if Azure also reports it Healthy; no replica is forced up.

Timeouts, failed readbacks and ambiguous submissions exit nonzero. They never
resubmit the update or roll back automatically. Keep the run directory and first
reconcile that same intent and target using read-only provider calls:

```sh
node scripts/azure-site-image-release.mjs --target .artifacts/target.json \
  --reconcile .artifacts/site-release-run --out .artifacts/site-release-reconciled
```

If Azure's update response was lost but subsequent same-target readback proves the
digest ready and configuration unchanged, the run can still report `READY`. A
still-pending, failed or drifted target requires coordinator investigation before
another write. An interrupted process may leave only `intent.json` or
`submitted.json`; these are sufficient for reconciliation. Do not infer failure
of the Azure operation from the local timeout.

For an explicitly authorized image rollback, retain the previous ACR manifest and
use the original run or reconciliation directory. The script selects its saved
previous digest and first reconciles the attempted image's exact revision and
configuration through fresh readback. That revision must be healthy/ready or
terminally failed (`Failed` provisioning plus `Failed`/`ActivationFailed` running
state), with no app update pending. It refuses ambiguous or drifted targets, then
uses the same image-only update and readiness path. Omit execute/confirmation to
plan first. Config drift is not repaired by image rollback.

```sh
node scripts/azure-site-image-release.mjs --target .artifacts/target.json \
  --rollback-from .artifacts/site-release-reconciled --expected-current-image "$SITE_IMAGE" \
  --execute --confirm-target "$SITE_RESOURCE_ID" --out .artifacts/site-rollback-run
```

`READY` proves provider revision/configuration readiness only. Both runtime and
public health remain explicitly `UNPROVEN` in this tool's output. Separately run
the existing read-only site candidate smoke against the intended runtime origin
and each actual public origin, then apply the coordinator's browser acceptance.
The current site `/api/health` identifies `corgtex-site` but has no build SHA or
image digest, so a healthy response alone cannot identify the serving release.
Provider certificate bindings are checked; DNS, TLS validity, certificate resource
contents and external identity permissions are outside the configuration proof.

```sh
node --test scripts/azure-site-image-release.node-test.mjs
node scripts/migration/site-candidate-smoke.mjs "$RUNTIME_ORIGIN" "$SIGNUP_ORIGIN"
node scripts/migration/site-candidate-smoke.mjs "$PUBLIC_SITE_ORIGIN" "$SIGNUP_ORIGIN"
```

CLI references: [image update](https://learn.microsoft.com/en-us/cli/azure/containerapp#az-containerapp-update)
and [manifest metadata](https://learn.microsoft.com/en-us/cli/azure/acr/manifest#az-acr-manifest-show-metadata).

## Monitor acceptance and writer handoff

The monitor template overrides the existing image's issue-writing command with
`health-sweep.mjs --dry-run`. It has no schedule, GitHub token or control-plane
credential, sets issue creation false, and cannot make probes or incident writes
when started in that configuration. Copy the exact source `OPS_HEALTH_TARGETS_JSON`
array into the private parameters. Names and URLs drive incident deduplication;
do not silently replace source coverage as part of the hosting move.

Keep the acceptance evidence separate:

| Evidence | What it proves | Still required for active monitoring |
| --- | --- | --- |
| Offline contract tests | Compiled Manual/dry-run defaults and synthetic parsing with zero probes or issue writes | Provisioning, actual image startup, probe parity and writer handoff |
| Provisioned job and one manual dry-run | Image startup, target parsing and output | Real probes, incident behavior and scheduled executions |
| Approved probes with issue creation off | Target/result parity | Incident create/dedupe/resolve and exclusive scheduled operation |
| Activation readback and execution evidence | Source schedule fenced and drained; Azure Schedule, issue writing and approved credential bindings verified; incident behavior proven; two scheduled executions observed | Ongoing operation and observation |

After the coordinator approves creation, one manual execution proves image startup,
target parsing and output only. For real probe parity, review the targets first:
even a GET demo URL can create a session. Run approved probes with issue creation
off. Before activation, prepare a private full job configuration based on provider
readback: remove `--dry-run`, preserve the command override, add the existing
GitHub token through Key Vault and `OPS_GITHUB_TOKEN` secretRef, preserve
`OPS_GITHUB_REPOSITORY`, and set `OPS_CREATE_GITHUB_ISSUES=true`. Transfer existing
control-plane credentials only if the source actually uses them.

### Exclusive publisher handoff

Before capturing the baseline, establish and verify a coordinator-owned external
change freeze that prevents manual Railway source deployments/restarts and
configuration changes outside the recorded handoff. Cover every human/API writer
and retain the freeze's owner, enforcement and verification evidence privately.
Keep it effective for the entire period Azure may publish, including uncertain
drain or recovery. The source-fence adapter reports manual-deploy prevention as
`UNPROVEN`; disabled automatic triggers, an empty drain check and periodic readback
do not replace this freeze. If it cannot be established, verified or maintained,
stop: keep Azure Manual and do not activate or accept an exclusive Azure publisher.
If verification fails while Azure is scheduled, enter recovery: set Azure Manual
and verify its drain without resuming Railway or lifting the freeze.
This requirement does not authorize new access or permission changes.

Retain a private recovery baseline before changing either provider: exact source
project/environment/service and source link, effective/configured/file cron,
autodeploy and image-update policies, current deployment/instance IDs, image digest,
command/arguments, target array, repository and credential bindings. Keep raw
configuration and credentials out of Git, CLI arguments and public evidence.
`deploy/railway.ops-monitor.toml` still declares the source cron; clearing a schedule
alone is not a fence against a later source deployment or an inherited file setting.

Use the existing `scripts/migration/railway-source-fence.mjs` adapter through the
coordinator's durable operation journal, scoped to **only the monitor service**.
Do not invoke the Ops/Core migration controller or activate a new Core runtime to
move this job. Before effects, capture and validate the adapter's recovery baseline
at an idle boundary: every baseline service must have empty `activeDeploymentIds`,
and retained completed scheduled deployments must be proven stopped. Preserve the
expected source-link digests. If the deployment inventory changes between capture
and fencing, stop and reconcile; do not silently adopt a new baseline after effects.
File-only cron without a proven exact restore path is a stop condition, not
permission to guess a provider override.

Fence source autodeploy, applicable source image updates, and the Railway
`*/15 * * * *` schedule. Require fresh readback of null configured/effective cron
and `nextCronRunAt`, disabled automatic deploy/update triggers, no unrelated staged
or pending work, and a complete deployment/instance inventory. Wait for running
executions to finish; stop/cancel them only within the authorized handoff. Require
stopped deployments and no live instances or queued deployments before Azure
activation. A `SUCCESS` deployment status alone does not establish this drain.
Retain the source link and recovery configuration; do not delete the service.

Then enable Azure `Schedule` with `*/15 * * * *` (UTC), parallelism 1, completion
count 1, retry limit 0 and timeout 600 seconds. Read back that configuration,
immutable image, command without `--dry-run`, issue-writing setting, repository,
targets and approved secret references. Parallelism is per execution, not a global
singleton. Incident lookup/create is not an atomic cross-provider lock: stable
dedupe keys protect sequential checks, not concurrent publishers. Do not manually
start overlapping runs, leave both providers active, or retry an uncertain start
or incident publication before reconciling its actual provider/issue state.

Keep a private acceptance ledger with these distinct results:

- Approved probe parity for every source target, including expected status/JSON,
  retry/timeout policy and any source control-plane coverage. A renamed target,
  changed URL or missing coverage needs separate approval, not silent migration.
- Authorized incident create and repeated-failure dedupe against the same issue,
  followed by resolution after **three consecutive healthy checks**. A new failure
  must reset recovery; preserve existing issue identities and recovery labels.
- Two distinct **scheduled**, completed Azure execution IDs after the source fence,
  with start/end times, accepted image/configuration, logs, each target's result and
  incident-publication outcome. Exclude manual executions, duplicate log records,
  overlaps and executions from an older configuration. Recheck the source fence.

A published health incident can exit successfully, so a successful execution is
not proof that targets are healthy. Two scheduled executions prove cadence and
operation only; they do not replace incident recovery evidence or a separately
required crash-free observation window. Missing/ambiguous provenance, target drift,
unresolved publication errors or an overlapping publisher blocks acceptance.

Recovery: set Azure back to Manual and verify it, stop/drain all active executions,
then restore only the retained Railway trigger policies after proving no Azure
publisher remains. Restore the idle baseline's triggers only; do not restart a
completed scheduled deployment to satisfy recovery, because that would replay its
monitor/incident work. If Azure drain is uncertain, do not restore Railway
scheduling or lift the external manual-deployment/configuration freeze. Release
that freeze only after proving no Azure publisher remains and completing the
recorded source recovery or an explicitly coordinated end to the publisher window.
Reconcile any uncertain issue write before resuming; never blindly
replay it.
Preserve issue dedupe keys and evidence. Reapplying the monitor bootstrap template
disables active monitoring and removes credentials, so use it only for preparation
or an intentional coordinated deactivation.

The offline regression checks below use synthetic provider/HTTP fixtures; they do
not disable a source schedule, provision Azure, publish real incidents or establish
live cutover acceptance:

```sh
node --test scripts/migration/railway-source-fence.node-test.mjs
node --test infra/azure/hosting/monitor.node-test.mjs
npx vitest run --project unit scripts/ops/ops-core.test.mjs scripts/ops/github-incident.test.mjs scripts/ops/customer-readiness-sweep.test.mjs
```

Azure references: [jobs and scheduling](https://learn.microsoft.com/azure/container-apps/jobs)
and [Consumption billing](https://learn.microsoft.com/azure/container-apps/billing).

## Incremental cost inputs

Site replicas request 0.25 vCPU and 0.5 GiB each, minimum 0 and maximum 2. Billable
active/idle replica seconds and HTTP requests depend on traffic and cold starts;
an existing environment is not a prepaid pool of free execution. Monitor executions
request 0.25 vCPU and 0.5 GiB for up to 600 seconds. At a later 15-minute cadence,
2,880 runs in a 30-day month imply at most 432,000 vCPU-seconds and 864,000
GiB-seconds at that timeout; a 30-second mean implies 21,600 and 43,200 respectively.
The prepared Manual job has no scheduled runs. Subscription-wide free allowances
may already be consumed and must not be subtracted without billing evidence.

Also budget Log Analytics ingestion/retention, retained site/monitor ACR images
above included storage, outbound traffic, and any backup-object storage/operations.
No extra registry base plan or dedicated environment is requested here. Identity
and role deployment is an access decision; it does not justify a zero-total-cost
claim. Measure candidate memory, latency, log volume and execution duration before
the coordinator asks for a production spend decision.
