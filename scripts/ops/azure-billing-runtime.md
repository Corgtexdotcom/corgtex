# Azure billing wire/runtime preparation

This patch adds real Azure Storage request construction, a bounded HTTPS transport,
conditional source reads, a single-blob CAS store and a runnable mocked runtime.
It adds only new files atop exact v7. The separately reviewed retirement correction
is not folded into this patch. No live credentials, Azure data, provider calls,
recipient transport, deployment, grants, image publication or spend were used.

Run the synthetic end-to-end wire demonstration:

```sh
python3 -B scripts/ops/azure_billing_mock.py
python3 -B -m unittest discover -s scripts/ops -p 'test_azure_billing_*.py' -v
```

The demonstration constructs only `MemoryWire`, synthetic tokens, a synthetic run
proof and synthetic retention attestation. It prints counts/status without raw
rows, tokens or URLs. A degraded summary is expected because the fixture does not
cover every configured service/day. There is no live command-line entry point.

## Wire and source boundary

`AzureClient` pins Storage REST `2023-11-03`, the reviewed subscription, tenant,
account, primary HTTPS host, source/ledger containers and UAMI resource ID. The
postcreation approved client ID is a required explicit configuration value; it is
not discovered. The credential-provider interface receives that exact tenant,
client ID, identity resource ID, Storage scope and deadline. The provider must
prove their relationship and return only that identity's token. No environment,
CLI, developer login, shared-key, SAS or identity fallback is implemented.

`StdlibHTTPS` performs TLS verification on the fixed primary host, does not follow
redirects or use proxy/environment discovery, and explicitly closes the connection
even if a response is rejected before its body starts. Request/token/response
objects suppress their normal representation. Errors expose bounded codes rather
than bodies, raw source URLs or credential values. Injected transports/providers
are trusted implementations that must preserve these contracts; a synthetic mock
is not evidence of Azure authentication.

The monotonic budget is at most 540 seconds, 200 requests, 64 MiB received and
32 MiB written. Individual socket operations use the smaller remaining deadline
or 30 seconds. Responses require exact Content-Length, full unencoded bodies and
bounded chunks; partial/truncated/oversized responses and redirects fail closed.
Credentials, proof/retention callbacks and summary emitters must also honor the
same bounded execution contract; a blocked third-party callback cannot be safely
preempted by a Python library. Container timeout enforcement remains a runtime gate.

Source listing handles every opaque NextMarker, including short nonfinal pages,
with cycle, 64-page, 65-object and XML-size bounds. It admits UTF-8 XML only, rejects
DTD/entity declarations before parsing, and validates response account/container
and object prefixes. Paths reject encoded escapes, traversal and arbitrary query
strings. GET uses each listed ETag in If-Match and verifies response ETag/length.
ETags remain opaque; SHA-256 is computed over the authenticated fetched bytes.

`capture_run` preserves exact manifest bytes in memory and captures conditional
object identities/hashes. It does not assert that separate objects came from one
completed provider run. No two-pass listing is treated as atomic proof, and the
code does not enable versioning, create snapshots, copy exports or mutate source
settings. No source-object PUT is permitted.

## Admitted normalization and source authority

`azure-manifest-utc-z-floor-v1` accepts UTC-Z submitted timestamps with up to seven
fractional digits. The engine's second-resolution timestamp is explicitly floored,
which conservatively ages freshness by less than one second. The exact source
bytes and precision remain in the atomic receipt. Start/end require whole-second
UTC-Z. Offset-less/non-Z times and unapproved schemas fail; no timezone is guessed.
This profile is an implemented admission contract, not approval of an actual
agreement-specific schema. A production schema snapshot must still be reviewed.

The runtime requires approved digests for both the complete CSV profile and the
complete policy/mapping content. Deployment must pin these reviewed digests, not
compute new approval values from arbitrary runtime input. Version labels alone
cannot silently authorize a remap. Existing exact export/root/timeframe/month
checks remain in the ingestion engine; automatic prior-month output from the MTD
export is not relabelled as the dedicated prior-month export.

An injected verifier must establish a provider-consistent run and return a
capture-bound proof ID, authority lineage and strictly ordered per-period authority
sequence. **No production verifier or provider guarantee is supplied.** The mock
verifier is explicitly synthetic. Without a verifier, runtime publication is
blocked. The exact prerequisite is reviewed evidence tying every captured object
to one completed run plus an authoritative replacement ordering independent of
arrival time, UUID/path sorting or local counters.

The same source identity reuses its revision and must retain identical capture
content/authority. A different source requires a higher authority sequence; only
then is the next engine revision proposed. Same-identity changed content and
stale authority fail. Current and prior periods replace complete admitted
snapshots; legitimate duplicate-looking rows and unallocated refunds retain the
engine's exact Decimal reconciliation and no invoice finality is invented.

## One atomic durable object

The protected `billing-ledger/v1/current.json` object contains runtime generation,
source admissions and the unchanged pipeline envelope. Each admission retains its
raw manifest (base64 metadata only), normalized profile identity, authenticated
object hashes/ETags, proof and source revision. No raw CSV rows are stored in an
additional object. The ledger itself contains the engine's normalized private data.
Its maximum serialized size is 8 MiB; larger runs fail rather than dropping history.

`PublicationStore` binds the source decision and evaluated ledger to one exact
read ETag. One If-Match PUT commits both; a loser emits no summary. Retrying a stale
candidate rereads the winning admission and rejects lower authority rather than
renumbering stale data as new. There is no separately written admission counter.
Every subsequent journal CAS preserves the same outer admissions/generation.

Bootstrap requires an explicit one-use `BootstrapPermit` for an approved first-run
generation and an authenticated BlobNotFound. It uses If-None-Match `*`. The permit
is consumed before attempting PUT, including uncertain outcomes. Normal startup
has no permit and missing ledger fails. ContainerNotFound, 403, malformed responses
and initialized-ledger loss never create empty state. A configured sequence floor
and generation detect disallowed restores; cross-process rollback detection needs
a separately durable, approved restore floor. This patch does not invent that
control or silently reset commit/source lineage.

Only 412 `ConditionNotMet` is classified as a clean CAS loss. Other failure,
timeout or malformed-success outcomes trigger a bounded authoritative read-back.
Success requires equality of the **complete outer object**, including admissions
and journal; commitId alone is insufficient. If exact outcome cannot be proved,
`WRITE_OUTCOME_UNKNOWN` remains unresolved. No blind PUT retry or summary follows.

The runtime uses fresh trusted UTC after fetches and before publication, plus the
monotonic budget across IO. It emits a sanitized summary only after successful or
exactly reconciled durable commit. A crash before logging leaves committed state;
absence of a console event must remain visible to independent heartbeat monitoring.
There is no delivery adapter or dispatch call in this runtime.

## Capacity and activation gates

Runtime requires a trusted aggregate retention attestation covering monitor-owned
versions, temporary objects and logs, with one maximum-object allowance under
1 GiB. It checks the attestation at entry and again immediately before publication
CAS, rejecting stale (>5 minute) or oversized evidence. Current blob size alone is
not capacity proof. No production inventory/retention-attestation implementation,
export-prefix retention policy or delete/lifecycle action is supplied. Generic
Blob CAS is a storage primitive; any future standalone journal writer must enforce
that same aggregate budget in its approved orchestration.

Before activation: prove the source consistency/ordering authority, actual schema,
fixed UAMI/client binding, credential implementation, aggregate retention and
restore floor; review the dedicated image and exact scoped permissions; compose
and validate the separately accepted protocol correction; test real Storage CAS,
provider semantics and external KQL/heartbeat. Future delivery needs its own
receipt/idempotency contract. Native alert/email enqueue is not that contract.
The pending live/schedule/laptop-off cases in the acceptance map remain unexecuted.

Primary wire references: [List Blobs](https://learn.microsoft.com/en-us/rest/api/storageservices/list-blobs),
[Get Blob](https://learn.microsoft.com/en-us/rest/api/storageservices/get-blob),
[Put Blob](https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob),
[REST 2023-11-03](https://learn.microsoft.com/en-us/rest/api/storageservices/version-2023-11-03),
and [export manifests](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-improved-exports).
These establish API shapes, not account acceptance or authorization to execute.
