# Accepted Core Baseline

This feature ships disabled: `.github/accepted-core-baseline.json` is absent.
Absence preserves the existing source-CI release policy. A supplied but invalid,
expired, inaccessible or drifted baseline fails closed; it never falls back to
health-derived SHA, a latest artifact or the legacy release-match exemption.

## Authority and Activation

1. Merge the implementation through ordinary protected review. Do not bootstrap
   from its candidate branch. No live baseline is adopted by that merge.
2. Obtain approval for **Accept Existing Core Baseline**, dispatched from reviewed
   `main`, under the existing `fleet-release-production` environment. The approver
   must review the exact sanitized `evidence_json` input and the retained private
   build/auth evidence identified by its hashes. Environment protection must
   actually require the intended independent review; do not remove protection to
   run bootstrap. Its effective workflow/source SHA becomes the verifier pin.
3. Bootstrap uses existing Railway and production database read credentials. It
   checks both existing service deployments/digests before and after verification,
   the accepted source's migration names/checksums and Prisma-supported schema,
   and the retained Core authentication job/step provenance. It never deploys,
   runs migrations/seeds, creates diagnostics/jobs, edits the ledger, or logs in.
   Retained build/auth observations must be at most 24 hours old at bootstrap.
4. Only a successful exact run/attempt can publish an accepted receipt. Retain the
   private evidence separately. Review the receipt and adopt it in a **separate
   small protected config PR** using the exact artifact ID/archive digest and
   receipt digest. This separation prevents unreviewed producer code from adopting
   its own claims. Workflow run completion is not itself adoption.
5. After config merge, main CI validates that baseline. PR/merge-queue source and
   schema checks remain isolated and cannot choose a baseline or receive production
   credentials. Explicit Fleet Release and explicitly dispatched Production
   Validation retain their incoming exact SHA, matching checkout and recovery gates.

No additional credential, database model, access scope or repository variable is
needed. Parent delivery owns dispatch, artifact retention and config adoption.

## Input and Pin Contract

The implementation's `validateEvidence` defines the strict bootstrap input:

- `target`: `id=backup-app`, `origin=https://app.corgtex.com`, `provider=railway`,
  exact project/environment/web-service/worker-service UUIDs, and
  `databaseIdentitySha256`. The latter is the canonical SHA256 of
  `{host, port, database, schema: "public"}` derived from the privately verified database URL;
  username/password/options are excluded. Provider target fields must also match
  the existing `FLEET_RELEASE_BACKUP_APP_TARGET_JSON` binding.
- `sourceSha`: the full accepted source SHA, an ancestor of reviewed main.
- `images.web` and `.worker`: exact `deploymentId` and immutable `sha256:` digest.
- `buildProof`: `kind=direct-container-build-readback`, retained evidence SHA256,
  observation timestamp, and both roles' exact deployment ID/source SHA. This
  proves the selected containers when combined with provider readback; it does
  not claim every replica or worker job execution.
- `authProof`: `kind=protected-review-retained-core-auth`, exact run ID/attempt,
  workflow SHA, job ID, step number, origin, actual smoke observation timestamp,
  evidence SHA256, and six true checks: health, releaseMetadata, loginPage, login,
  session, rootFlow. The job must be the successful **Production Smoke Test** in
  trusted main CI; the successful step must run `railway-smoke.mjs` against Core.
  Use actual smoke time, not a later log-extraction timestamp.
- For reacceptance after activation, `authProof.kind` may instead be
  `protected-review-retained-baseline-auth`. It retains all those common fields
  and adds `baseline: {sourceSha, targetSha256, imagesSha256, verifierSha,
  receiptSha256}` from the sanitized proof described below. The exact successful
  step must be **Verify accepted Core provider, health, auth and schema using
  pinned verifier and source**, in the same trusted main CI job. Bootstrap reads
  the config at that auth run's exact `workflowSha` and verifies its source,
  target, verifier and receipt bindings; the image hash must match the proposed
  evidence. A generic successful job or a baseline step claimed as legacy proof
  is insufficient.

**Retained-proof hashes are not automatic authentication/build attestations.**
The protected approver must inspect the actual matching private readback and
uniquely attributed auth messages/step, including their target binding. The
producer corroborates job metadata; an arbitrary successful CI job is rejected.
Missing proof is a blocker, not permission to create a new diagnostic or login.
Never put raw logs, credentials, cookies or customer data in workflow inputs.

The adoption config contains only these fields (values must come from the reviewed
successful producer, never guessed or copied from a health response):

```text
schemaVersion: 1
target: backup-app
targetSha256: hash of exact receipt target
sourceSha: full accepted source SHA
verifierSha: reviewed producer workflow/source SHA
receiptSha256: SHA256 of exact receipt.json bytes
run: {id, attempt, workflowId, workflowSha}
artifact: {id, name, sha256}
```

`run.workflowSha` must equal `verifierSha`. Artifact name is exactly
`accepted-core-baseline-RUN_ID-ATTEMPT`; `artifact.sha256` is the uploaded ZIP digest.
The consumer verifies API repository/head repository, workflow ID/path, source
SHA, main branch, dispatch event, conclusion, exact attempt, artifact ID/name/hash,
attempt time association, expiry, receipt bytes and target/source/schema binding.
Rerunning that producer run invalidates its old pin: review and adopt a new exact
successful run/attempt, never silently follow a rerun or another same-name artifact.
Artifact expiry is a baseline-unverified failure; arrange protected reacceptance
before the configured 90-day retention ends. An archive alone does not refresh
acceptance or authorize changing the pin.

## Protected Reacceptance

Successful baseline-mode CI retains `auth-smoke.json` in the private artifact
`core-baseline-smoke-RUN_ID-ATTEMPT` for 90 days. It is written only after the
accepted-source smoke exits successfully, all six fixed success messages are
verified, and the final provider readback passes. Raw child output is suppressed;
the file contains only the six check flags, observation time, run/attempt/source
metadata and baseline hashes, not credentials, cookies or customer data. Its
exact byte SHA256 is also reported in the check step.

For protected reacceptance, review that exact file and successful run/attempt.
Use its byte hash as `authProof.evidenceSha256`, copy its actual observation time,
origin, workflow/run/attempt and `baseline` binding, and obtain the exact job ID
and step number from the same run's GitHub API metadata. Do not use a latest or
same-name artifact as authority. GitHub whole-second step completion timestamps
cover their final fractional second only; observations in the next second fail.

The protected approver still inspects the retained proof against the input. The
producer checks repository, workflow, job, step, source config and exact attempt;
the sanitized file alone is not an accepted receipt or adoption authorization.
Both auth and build observations must still be at most 24 hours old, so obtain
fresh retained build readback as well. Reacceptance uses the same protected
bootstrap followed by a separate config PR, never an automatic renewal. The
known checksum variance remains nonaccepted by this path too.

## Validation Boundaries

Candidate migrations/tests/build still run against isolated CI PostgreSQL. For
Core, the pinned verifier and accepted source are separately checked out. Their
dependencies are installed without production credentials and with install
scripts disabled; Prisma generation and a database-free datamodel-to-itself diff
prepare and exercise the native engine before any credentialed step. Live diff
requires that prepared executable, sets an explicit engine path, disables update
checks and prevents external engine downloads. No candidate Prisma model or
candidate fixture is used against Core.

The live ledger query is bounded, read-only and compares the accepted source's
sorted migration-name/SQL-byte-checksum manifest exactly. Schema diff uses the
accepted datamodel and Prisma version with read-only/statement/lock limits. Only
Prisma-supported schema constructs are covered; no historical data-correctness or
all-database-features claim is made. Current Core's known original-Git checksum
variance remains **nonaccepted**. Supported-schema equality does not waive it.
Do not replay SQL, rewrite the ledger or silently add a historical checksum list.
That variance requires explicit later disposition before this strict producer can
accept the current baseline. Failed bootstrap can publish a nonaccepted diagnostic
code, never an accepted receipt.

Source CI retains Core health/authentication checks and post-deploy observation,
with the Core observation SHA pinned rather than selected from live health. Live
provider readback brackets checks and observation. Other existing observation
targets remain unchanged. Automatic Production Validation fixture runs (CI
completion and schedule) are disabled only when a valid accepted pin is verified;
baseline validation is owned by source CI. Explicit manual validation is unchanged.

When the failed source commit contains a baseline config, automatic source revert
is withheld with an actionable reconciliation message, including for invalid
config. An unhealthy baseline does not attribute failure to an undeployed source
commit. Absence retains legacy recovery. Explicit rollout recovery is untouched.

## Local Checks and Limits

Run `npx vitest run --project unit scripts/accepted-core-baseline.test.mjs
scripts/production-validation-context.test.mjs scripts/ci-production-boundary.test.mjs`.
Also run the policy and private/public-boundary checks. No application build is
needed for this workflow/script change.

Fixtures prove trust decisions and call order, not live provider authorization.
The provider reader reuses existing scoped Railway deployment/active-instance
queries and fails on GraphQL errors. Parent's authorized CLI readback confirmed
the deployment's `meta.imageDigest` field. The bounded direct GraphQL read returned
`Not Authorized`; live execution with the existing workflow credential remains
unproven. Do not infer schema support from that authentication failure, switch
credentials or add scopes to make the check pass. Protected activation must resolve
any actual read-access blocker without weakening the target checks.

Local preparation proof used installed Prisma 6.19.3: datamodel-to-itself diff
passed without a database URL, with an explicit prepared engine and unreachable
external download/proxy endpoints. A fresh offline install stopped on an uncached
dependency; fresh-install preparation on the hosted runner remains unproven.
The workflow installs and prepares before credentials are supplied, and fails the
job there if package availability or native engine preparation is incomplete.
