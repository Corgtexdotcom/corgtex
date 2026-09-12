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
the source site: `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_URL`,
`NEXT_PUBLIC_ENTERPRISE_APP_URL`, `NEXT_PUBLIC_DEMO_URL`,
`NEXT_PUBLIC_BOOK_DEMO_URL`, `NEXT_PUBLIC_INTERCOM_APP_ID`, and
`NEXT_PUBLIC_INTERCOM_API_BASE`. They are public build arguments, not secrets.
Next.js embeds public values at build time; changing Azure runtime variables alone
does not correct a wrong signup target or restore the Intercom widget. Omitted
Intercom app ID disables the widget, so its presence must be checked for parity.
The default production URLs retain selfserve signup and backup-app demo/enterprise
routing. A rebuild needs its own receipt and digest acceptance even at the same
source commit; commit identity alone is not proof of image identity.

```sh
az bicep build --file infra/azure/hosting/site.bicep --stdout > /tmp/site.arm.json
az bicep build --file infra/azure/hosting/monitor.bicep --stdout > /tmp/monitor.arm.json
az bicep build --file infra/azure/hosting/site-identity.bicep --stdout > /tmp/site-identity.arm.json
npx vitest run --project unit scripts/migration/site-candidate-smoke.test.mjs
npx vitest run --project unit scripts/migration/hosting-image-receipt.test.mjs
node scripts/check-public-docs.mjs
node scripts/check-private-boundary.mjs
```

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
demo and enterprise links also depend on the backup app. Keep that service until
its own migration is accepted. Preserve intentional external integrations.

Coordinator sequence: approve candidate and any identity/secret changes; prove
candidate parity; bind DNS/TLS for each actual source domain including any apex
redirect; switch routing; prove the public domain serves the candidate and observe
forms/analytics with authorized test data. Retain Railway for DNS rollback. There
is no site-owned datastore to synchronize, but form writes must keep their intended
backend. Do not replay this bootstrap template over a domain-bound app: it has no
custom-domain configuration. Subsequent releases use image-only Container App
updates with digest/readiness/public-smoke proof and the previous image retained.

## Monitor acceptance and writer handoff

The monitor template overrides the existing image's issue-writing command with
`health-sweep.mjs --dry-run`. It has no schedule, GitHub token or control-plane
credential, sets issue creation false, and cannot make probes or incident writes
when started in that configuration. Copy the exact source `OPS_HEALTH_TARGETS_JSON`
array into the private parameters. Names and URLs drive incident deduplication;
do not silently replace source coverage as part of the hosting move.

After the coordinator approves creation, one manual execution proves image startup,
target parsing and output only. For real probe parity, review the targets first:
even a GET demo URL can create a session. Run approved probes with issue creation
off. Before activation, prepare a private full job configuration based on provider
readback: remove `--dry-run`, preserve the command override, add the existing
GitHub token through Key Vault and `OPS_GITHUB_TOKEN` secretRef, preserve
`OPS_GITHUB_REPOSITORY`, and set `OPS_CREATE_GITHUB_ISSUES=true`. Transfer existing
control-plane credentials only if the source actually uses them.

Fence the Railway `*/15 * * * *` schedule and wait for any running execution to
finish before enabling Azure `Schedule` with `*/15 * * * *` (UTC), parallelism 1,
completion count 1, retry limit 0 and timeout 600 seconds. Parallelism is per
execution, not a global singleton; do not manually start overlapping runs. Do not
leave both providers active. Prove target/result parity and authorized incident
create/dedupe/resolve behavior, then observe two scheduled executions. A health
incident intentionally exits nonzero; distinguish that from startup failure.

Recovery: set Azure back to Manual, stop/drain active executions, then restore
Railway scheduling. Preserve issue dedupe keys and evidence. Reapplying the monitor
bootstrap template disables active monitoring and removes credentials, so use it
only for preparation or an intentional coordinated deactivation.

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
