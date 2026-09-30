# Core logical retirement

`Retire Existing Core` replaces only the known Core web and worker start commands
with a same-image Node HTTP utility. Web health identifies `source-freeze-utility`
and `applicationWrites:false`; legacy pages link to selfserve. API/OAuth reads and
all writes return 503 with Retry-After. The worker runs only the inert utility.
The commands bypass application startup, Prisma and business queues. Services,
images, variables, database, credentials, domains, and recovery evidence remain.

Run the default dry-run on protected main first. It requires a newly accepted Core
baseline (at most 24 hours old), exact recovered deployment IDs/digests, no drift,
no pending provider work, disabled autodeploy and no cron. It inspects each actual
image's entrypoint and verifies the stock Node wrapper. Unknown triggers or
entrypoints block before writes; this workflow does not change trigger policy.

Before execute, independently review public selfserve acceptance, provider and
source-data disposition, image startup proof and fresh Ops mappings. Prepare an
`approval_json` dispatch manifest for independent review with:

- `schemaVersion: 1`, `kind: "core-logical-retirement"`, `reviewedAt` (UTC; at most
  one hour old when execution begins).
- `baselineReceiptSha256`, `providerBeforeSha256`, `opsSnapshotSha256`, and
  `imageStartupProofSha256` copied from the verified dry-run.
- `publicSelfserveEvidenceSha256`, `providerDispositionSha256`, and
  `sourceDataDispositionSha256` referencing the reviewed retained evidence.
- `sourceDataDisposition: "retain-unchanged"`, `customerTargets: "selfserve-only"`,
  `physicalServices: "retain"`, and `databaseChanges: false`.

Dispatch on protected main with `dry_run=false`, the exact `approval_json`, and
its canonical `identityHash` as `approval_sha256`. The independent reviewer must
inspect that run's exact input, dry-run hashes and retained supporting evidence
before approving the existing `fleet-release-production` environment. The owner
must not self-approve. Payload hashes alone provide no authority: only the trusted
main workflow under independent environment approval may execute, and fresh
provider/Ops hashes must still match. The intent artifact retains the approved
manifest and executing commit. No additional feature PR is needed for this
short-lived operational manifest.

The managed release lease API admits Azure deployments and a changed image tag;
it cannot represent this same-image Railway operation. Exclusion therefore uses
the shared non-cancelling `fleet-release` concurrency group, native environment
approval and fresh Ops checks that **all release leases are absent** before each
write. This is not an acquired Ops lease. Keep all provider writers under the
existing release ownership contract during execution.

A started execute step is a durable GitHub attempt barrier. Any previous started
execution, even a failed one, blocks another execution; mutations are never
retried automatically. Retain artifacts, inspect current commands, deployment
IDs, digests, active instances and serving utility proof under the same exclusion,
then create a separately reviewed recovery/reconciliation change. Do not rerun,
clear history, create an alternate workflow, or restore business execution merely
to bypass the barrier. Physical shutdown or deletion remains a separate decision.
