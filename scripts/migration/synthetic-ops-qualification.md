# Synthetic Ops Target Qualification

`qualify-synthetic`, domain `ops`, in the existing protected PostgreSQL rehearsal
workflow is distinct from production-source `rehearse` and metadata-only
`qualify-target`. It uses the same main-only gate, environment, identity checks,
non-cancelling concurrency group, existing server and one-hour lifecycle. The
last fifteen minutes remain reserved for cleanup. This code is not authorization
to dispatch, publish inputs, grant roles or spend money.

The same job also accepts `prepare-synthetic`, domain `ops`: it verifies the
published pins, exercises Linux bootstrap/TLS/baseline and Docker client transport checks, and removes the
local fixture, skipping Azure login and all provider steps. Use that bounded
preparation receipt before requesting an actual target run. The outer job timeout
includes pre-START dependency preparation; it does not extend the one-hour Azure
intent or its cleanup reserve.

## Premerge Native Preparation

The existing CI workflow has a separate, PR-only `Synthetic Native ARM64
Preparation` job on `ubuntu-24.04-arm`. A read-only scope job compares the tested
merge tree to the PR base, including deletions. It covers synthetic harness files,
PostgreSQL runner/validator/schema dependencies, qualification dependencies,
migration-foundation inputs, both workflows and package/runtime-test manifests.
Customer application changes alone do not select this check. This adds no main,
merge-group or production execution path and changes no protected Azure ref gate.

Both jobs have only `contents: read`, no environment, secrets, OIDC or provider
credentials, and checkout does not persist credentials. The native job anonymously
downloads only the four fixed PUBLIC assets below, checks their exact hashes,
installs locked dependencies without lifecycle scripts, and caches the digest-pinned
official client. Missing/unpublished inputs fail closed, not skip-green. Publication
and actual hosted execution remain parent-owned gates; keep acceptance pending
until a real native run passes. macOS tests do not establish native Linux proof.

The bounded entrypoint is:

```sh
node scripts/migration/prepare-synthetic-ops-local.mjs prepare /absolute/public-bundle /absolute/new-evidence
node scripts/migration/prepare-synthetic-ops-local.mjs cleanup /absolute/new-evidence
```

Preparation rejects non-Linux/arm64 hosts. It invokes the existing source worker
and actual Docker client/relay probe, not the Azure orchestrator with a fabricated
ref. Child tools receive only PATH and a newly owned HOME/TMPDIR; no inherited
Docker remote context, provider configuration or Node options. The native Docker
daemon is local to the ephemeral hosted runner; no Docker socket is mounted into
a fixture. Work has a ten-minute deadline with a two-minute cleanup reserve.

Intent and label-owned resource receipts are retained outside credential temp
storage before resource creation, allowing a separate bounded cleanup retry.
In-process cleanup verifies absence and removes private temp files; an `always()`
step retries owned cleanup after failures/interruption. It never drops an unowned
database or changes a provider resource. A missing summary is an error, not cleanup
success. Cancellation/host loss can prevent `always()` and upload from running:
then cleanup is UNPROVEN, and only ephemeral host-local resources are implicated.
A previously written successful local summary proves that completed cleanup, not
successful completion of a subsequently cancelled CI job.

Only `public-summary.json` is uploaded (seven-day retention): source code SHA,
fixed input pins, source runtime, bounded comparison/transport booleans, cleanup
status and `azureComparison: NOT_RUN`. Full source/ownership receipts, certificates,
keys, manifest and binary inputs stay on the ephemeral host and are not artifacts.
The summary is not source-data acceptance or Azure execution evidence.

## Inputs And Local Bootstrap

The parent must first audit and publish four reviewed fixture assets under the
existing repository's `ops-synthetic-source-v1` release. This repository and its
release assets are PUBLIC, not private storage. Publication of every payload
requires a privacy/provenance audit separate from Azure approval. No new secret or
permission is required by the downloader (`contents: read`); it cannot create a
release. Missing assets fail before Azure login/START. All four bytestrings are
hash-bound in `synthetic-ops-source.mjs`, not trusted by filename, tag or receipt:

- `source-image.tar`: 161855488 bytes, pinned Docker-save export of the accepted
  source image. Keep this exact export, rather than assuming a new tar is identical.
- `synthetic.dump`: 858929 bytes, the retained fictional Ops archive, not a source
  backup. Contains the frozen migration ledger and synthetic queues; no workers run.
- `corpus.sql`: 930 bytes, the predeclared 48-string corpus.
- `source-baseline.json`: 7683 bytes, a minimal projection of the retained capture:
  schema version, attested source runtime, corpus SQL hash and exact observations.
  SHA256: `307c6d2543a29e29c39df4c5cd843b82c38f8b794c1c4f3b595a8635f4200905`.

The original 21090-byte receipt and local ownership/publication manifest stay
private and must NOT be release assets. `projectSourceBaseline` derives the
projection without recomputing/reordering observations; both consumers validate
the runtime/corpus binding and new file pin. Parent audit must verify exact
`JSON.stringify(observations)` equivalence against the original receipt. Its SHA256
is `87e6f6000c360231e78bc340927459acd6ad6d6f567340adce43a6be555d1eec`.
The other three payloads are unchanged. The image includes BuildKit invocation,
relative build-context path, revision and timestamp metadata; the dump includes
synthetic migration IDs/timestamps. Those require audit too. Do not silently
repack the image or change the accepted dump to remove metadata.

No binaries, database archives, credentials or generated proof belong in Git.
The workflow downloads only these named assets and verifies them before Docker
load. Runtime tools use `--pull=never`; the official pinned PostgreSQL client is
cached before the lifecycle. The source image is Linux arm64, so bootstrap uses
`ubuntu-24.04-arm`, not emulated or silently substituted binaries.

Bootstrap creates a uniquely labelled internal Docker network and local database,
with no published port or default route. It restores the pinned archive locally,
creates a read-only synthetic reader, and attests PG180006/UTF8/en_US.utf8/libc,
recorded=actual2.41, vector0.8.2 and verified TLS. A separate local corpus database
must reproduce the retained observations and same-runtime index checks before
Azure preparation. Source TLS keeps the unchanged runner's verify-ca contract;
the bootstrap connections and Azure target verify hostname and CA. The source
remains frozen; there is no Prisma migration, application boot or production URL.

The Linux host accesses the internal source through a loopback-only TCP relay.
Docker clients remain on that internal network. Their only external relay binds
the network gateway and has one fixed upstream: the exact rehearsal target on
5432. Its hostname remains the TLS identity; no certificate override is installed.
This host-network plumbing must be exercised on Linux before an authorized cloud
dispatch; macOS Docker Desktop is not silently treated as an equivalent host.
`prepare-synthetic` exercises the same gateway relay and Docker PATH wrapper
against only the owned local source. It maps `synthetic-target.invalid` to the
internal gateway, uses that hostname's fixture certificate SAN, and runs the
unchanged `probeTargetClientConnection` with the pinned client image, generated
service/pass files and verify-full TLS. A single read-only `SELECT 1` must complete,
psql must exit, its container must disappear and its reader session must close.
The gateway relay, client files and wrapper then close. No Azure hostname is
resolved or contacted by this local test, and no default route is added. Native
Linux execution of this new path remains NOT_RUN until separately exercised.

## Work And Proof

The synthetic intent wraps the unchanged qualification lifecycle with pinned
inputs and three exact run/attempt-derived scratch identities. Two sequential
restore passes use `runPostgresRestoreRehearsal` unchanged, replacing each newly
generated dump through its existing archive hook with the same pinned bytes.
Each pass cleans before the next starts. A third, small scratch database isolates
the corpus from full-schema parity. At most one owned scratch database should
exist at a time. No collation metadata refresh, source repair, C/ICU substitution,
schema guard relaxation or extension allowlist change is performed.

The target must still attest PG180006/en_US.utf8/libc2.38 and vector0.8.2 availability
and allowlisting. Vector installation occurs only inside owned scratch databases.
Index valid/ready flags and sequential/index result agreement are recorded
separately from ORDER BY, range and lower/upper/initcap cross-runtime observations.
Zero divergence is required for exactly this representative corpus, not universal
locale equivalence. Logical restore/index reconstruction alone proves neither.

After actual database/firewall/credential cleanup, the unchanged strict validator
runs on each captured restore receipt. Known 2.41/2.38 representation mismatch can
still fail it even when corpus observations agree. Failed guards remain failures.
No synthetic result establishes production data, workload capacity, costs or cutover.

## Interruption And Recovery

The owner supervises child process groups with absolute deadlines, SIGTERM then
SIGKILL, including stubborn descendants. Source workers terminate their nested
tool groups on interruption. Label-owned Docker clients are also removed because
killing a Docker CLI does not kill its daemon-owned container. Restore/SQL child
limits cannot consume the cleanup reserve. Logs suppress raw exceptions/secrets.

`always()` cleanup independently attempts local-resource removal, exact scratch
deletion and the existing firewall/STOP lifecycle. A scratch failure does not skip
STOP and cannot produce a successful overall cleanup receipt. Local resource
ownership, scratch state and lifecycle receipts remain outside credential temp dirs.
Guarded local cleanup and temporary credential removal run before provider
preflight, including when identity/target checks fail. Such provider failure keeps
its original error, blocks all provider cleanup mutations and requires recovery;
local success alone cannot produce a successful lifecycle cleanup receipt.

For a completed failed/interrupted run, dispatch `recover` with
`recovery_kind=synthetic-qualification`, domain `ops` and its exact run ID/attempt.
The existing native recovery proof checks completed original attempt, exact
synthetic job/steps, START marker, unsuccessful cleanup and no intervening run.
Metadata-only and production-restore recovery retain their separate contracts.
An intent alone never authorizes deletion. An existing database requires the
matching runner state at ABSENCE_VERIFIED or CREATED and exact host/name binding;
missing state or INTENT means HOLD. Partial CREATE/restore can therefore recover
when that retained evidence exists. Missing execution artifacts need reviewed
operator reconciliation, not a reconstructed grant of ownership.

Recovery reuses the existing exact ARM database-delete operation, avoiding a new
START or a new runner IP rule for SQL access. It reconciles ambiguous deletion
once and requires absence. Provider rejection (including a stopped-server
restriction) remains HOLD; there is no fallback START or permission escalation.
The original deadline is never extended as a success claim. The parent retains
independent deadline/spend supervision if the runner or provider fails.

Before execution: independent integrated QA, audited PUBLIC input publication,
Linux bootstrap/transport evidence, explicit scratch/vector/two-restore window
approval, and parent confirmation of the existing exact temporary Reader plus
Contributor role pair are required. Those roles were removed after metadata
qualification; this script does not restore them or assume that a spend approval
also grants access. No new environment, credentials, server, SKU or allowlist
change is introduced. Actual Azure comparison remains NOT_RUN until authorized.
