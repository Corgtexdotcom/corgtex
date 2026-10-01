# Core logical retirement

`Retire Existing Core` replaces only the known Core web and worker start commands
with a same-image Node HTTP utility. Web health identifies `source-freeze-utility`
and `applicationWrites:false`; legacy pages link to selfserve. API/OAuth reads and
all writes return 503 with Retry-After. The worker runs only the inert utility and serves its configured `/healthz` on GET/HEAD.
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

## Unchanged-state reconciliation for run 36883501899

That run failed with `CORE_RETIREMENT_PRESERVED_CONFIG_CHANGED`. Authenticated
failure artifacts retain an unknown write outcome. Independent read-only
reconciliation found the complete original state unchanged; six fresh config
reads agreed, but the transient field was not established. Equality stays strict.

The same protected workflow admits one incident-bound reconciliation using
`reconcile_failed_run_id=36883501899`, `dry_run=false` and a newly reviewed
approval envelope. The committed `.github/core-retirement-reconciliation.json`
pins the failed run, artifact ZIP/member hashes, original approval and accepted
unchanged provider/config hashes. The runner authenticates all predecessor
evidence and requires the complete original starting state; partial utility
progress cannot use this path. Normal execution remains blocked.

The envelope uses `schemaVersion:1`, kind
`core-logical-retirement-reconciliation`, fresh `reviewedAt`, `caseSha256`
(canonical committed case hash), `failedRunId`, `originalApprovalHash`,
`expectedProviderSha256`, `expectedPrivateConfigSha256`, and a freshly reviewed
`retirementApproval` with the normal fields above. Its canonical identity hash
is `approval_sha256`. Never rewrite the old review time or extend the baseline's
24-hour deadline. Independent review may update public/disposition evidence.

Both normal and reconciliation started-step histories count toward the durable
barrier. Only the named failed predecessor and the current first reconciliation
are allowed; any additional started attempt consumes the exception permanently.
If this reconciliation fails, stop for a new specific recovery design rather
than repeating it. A configuration mismatch saves bounded structural diagnostics
with run-keyed HMAC fingerprints and no values; its random key is not retained.
Existing services, images, variables and database remain under the same retention
owner and physical-removal gate. This incident case exists only for governed
recovery and can be removed after retirement evidence is retained and accepted.


## Healthcheck recovery for run 36892304659

The first reconciliation staged the approved worker command and created one
failed utility deployment: its existing `/healthz` healthcheck received 503.
The failed utility is stopped; the original worker and web remain active.
Both consumed executions remain permanently recorded and must never be replayed.

The committed `.github/core-retirement-healthcheck-recovery.json` binds both
failed archives and their approval chain, the exact original command bytes,
failed deployment, and the complete unmodified partial provider/config state.
Run a new protected dry-run with `healthcheck_failed_run_id=36892304659`.
This dedicated plan authenticates both predecessors; it does not reinterpret
the failed latest deployment as the original baseline. The original baseline's
24-hour deadline remains unchanged. Unsupported healthcheck paths block.

A reviewed schemaVersion 1 `core-logical-retirement-healthcheck-recovery`
envelope binds `caseSha256`, `failedRunId`, `originalApprovalHash`,
`reconciliationApprovalHash`, `expectedProviderSha256`,
`expectedPrivateConfigSha256`, fresh `reviewedAt` and a fresh normal
`retirementApproval` using the new plan's partial provider hash. Review retained
acceptance and disposition evidence before approving the native environment.
Dispatch once with that envelope/hash, `dry_run=false` and the same failed-run
input. All three mutating step names across all attempts count toward the
barrier; only the two fixed failures and this first recovery are admitted.

Before any provider write, both original pinned images run the exact candidate
utility command in network-isolated, read-only containers. Tests exercise health
GET/HEAD and write rejection; the worker includes `/healthz`, and web includes
the selfserve handoff. Execution repeats this with its actual approval proof.
Only after this passes does the same worker-first completion change commands
and deploy each service once, proving original processes stop and configuration
remains unchanged. The failed utility remains in history. Any recovery failure
requires another explicit incident design; no retry or business restoration runs.
