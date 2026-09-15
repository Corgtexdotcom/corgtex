# Synthetic Ops Target Qualification

`qualify-synthetic`, domain `ops`, in the existing protected PostgreSQL rehearsal
workflow is distinct from production-source `rehearse` and metadata-only
`qualify-target`. It uses the same main-only gate, environment, identity checks,
non-cancelling concurrency group, existing server and one-hour lifecycle. The
last fifteen minutes remain reserved for cleanup. This code is not authorization
to dispatch, publish inputs, grant roles or spend money.

The same job also accepts `prepare-synthetic`, domain `ops`: it verifies the
published pins, exercises Linux bootstrap/TLS/baseline checks and removes the
local fixture, skipping Azure login and all provider steps. Use that bounded
preparation receipt before requesting an actual target run. The outer job timeout
includes pre-START dependency preparation; it does not extend the one-hour Azure
intent or its cleanup reserve.

## Inputs And Local Bootstrap

The parent must first audit and publish four reviewed fixture assets under the
existing repository's `ops-synthetic-source-v1` release. Publication and repository
visibility/privacy review are separate from Azure approval. No new secret or
permission is required by the downloader (`contents: read`); it cannot create a
release. Missing assets fail before Azure login/START. All four bytestrings are
hash-bound in `synthetic-ops-source.mjs`, not trusted by filename, tag or receipt:

- `source-image.tar`: 161855488 bytes, pinned Docker-save export of the accepted
  source image. Keep this exact export, rather than assuming a new tar is identical.
- `synthetic.dump`: 858929 bytes, the retained fictional Ops archive, not a source
  backup. Contains the frozen migration ledger and synthetic queues; no workers run.
- `corpus.sql`: 930 bytes, the predeclared 48-string corpus.
- `source-baseline.json`: 21090 bytes, the retained source-only capture.

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

Before execution: independent integrated QA, private input publication/audit,
Linux bootstrap/transport evidence, explicit scratch/vector/two-restore window
approval, and parent confirmation of the existing exact temporary Reader plus
Contributor role pair are required. Those roles were removed after metadata
qualification; this script does not restore them or assume that a spend approval
also grants access. No new environment, credentials, server, SKU or allowlist
change is introduced. Actual Azure comparison remains NOT_RUN until authorized.
