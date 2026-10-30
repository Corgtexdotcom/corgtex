# Offline ingestion and durable publication preparation (v6)

This increment keeps the reviewed v4 engine unchanged. It supplies a bounded
CSV admission function, a dependency-injected durable-store/delivery protocol,
synthetic failure tests, and inactive infrastructure templates. It does not
implement Azure storage calls, a deployed monitor, credentials, alert delivery,
provider registration, grants, image publication, or a production schema profile.

Run all synthetic and static tests with Python stdlib:

```sh
python3 -B -m unittest discover -s scripts/ops -p 'test_azure_billing_*.py' -v
```

## Source admission

`azure_billing_ingestion.ingest` consumes one explicitly scoped immutable export
run and returns one normalized period snapshot. To replay current and prior
months, call it separately for each admitted export and combine the two snapshots
into the engine manifest. Never concatenate an older revision with its replacement.
The caller owns authoritative monotonic revision assignment; a listing position,
run UUID sort order or fetched timestamp is not such authority.

The exact reviewed export names bind to `mtd`/`MonthToDate` in the submission
month and `prior-month`/`TheLastMonth` in the preceding complete calendar month.
Mismatched names, roots, timeframes and run months fail closed.

The supplied `CsvProfile` must describe every column and each semantic role.
ServiceName must be a distinct explicitly present `ServiceName` header or null.
There is no header alias detection, guessing of monetary fields, currency
conversion, or synthesized ServiceName. The tests use a deliberately synthetic
profile. Actual agreement-specific field casing, date representation, optional
fields and version must be captured and approved before a real profile is added.
The current admitted contract requires ISO calendar dates, whole-second `Z`
timestamps, `ActualCost`, `USD`, data version `2023-05-01`, and manifest version
`2024-04-01`. Other timestamp forms (including the fractional and offset-less
forms in Microsoft's example), schema variants, compression, or unknown columns
fail closed. This is an explicit admission limit, not a claim that every Azure
export conforms to it.

Injected `list_page(source, run_prefix, continuation)` returns bounded pages of
`{items: [{name, sha256}], nextToken}`. Injected
`fetch_blob(source, name, expected_sha256, maximum_bytes)` returns bytes. The
source includes the exact storage resource ID and `billing-exports` container.
A future implementation must use immutable version/ETag-pinned reads and enforce
response/request deadlines and byte limits while receiving data. The manifest
itself does not provide SHA-256 hashes; the trusted discovery/admission layer must
supply them from immutable content. Hash comparison here detects mismatch; it does
not establish provenance or substitute for authenticated source access.

Every part must occur once in both manifest and inventory, within the admitted
run prefix. Page token cycles, unexpected parts, incomplete partitions, per-part
or aggregate byte/row mismatches, changed hashes, malformed CSV, inconsistent
headers, in-data repeated headers, scope/currency/date/decimal violations stop
without producing a snapshot. Each partition must repeat its exact header at
the beginning. Empty exports remain unknown days; no zero-cost day is fabricated.

Source record IDs include export, run, full part path, immutable part hash and
row ordinal. Two identical-looking rows still count twice. One exact-value
mapping column assigns each row to at most one configured service. Other rows,
including negative refunds, remain unallocated. Raw, mapped and unallocated
Decimal totals reconcile exactly. Provider and available ServiceName are retained;
ServiceName stays null when the profile does not carry it. Ingestion completeness
means all admitted file parts reconciled; it never asserts billing finality.

Bounds are 64 pages, 64 parts, 8 MiB raw export, 25,000 rows, 128 columns and
4,096 characters per cell, with the v4 decimal/output/state limits retained.
These small-run limits intentionally reject oversized exports; streaming larger
exports is a separate design. The injected IO implementation must enforce a total
job deadline; a blocking callback cannot be interrupted by these library functions.

## Durable ledger and outbox

`azure_billing_pipeline.publish` reads a detached document plus ETag, evaluates
both months, and performs one conditional write. The state, commit ID, monotonic commit sequence, sanitized
summary, and delivery journal share one atomic envelope. Only a successful durable
CAS returns a summary eligible for logging. Conflict losers must reload/re-evaluate;
IO exceptions can mean an unknown commit outcome and must be reconciled by reading
stored state. Neither an error nor process exit proves rollback. Commit sequence advances only with the successful CAS and breaks same-second
correction ties independently of log arrival order. A restore must preserve the
sequence; loss/reset of the store requires a separately reviewed recovery plan.
A post-commit
crash can lose the console event; external heartbeat must then remain alert until
a later successful publication. No summary is emitted by the module itself.

`Store` is an interface, not an Azure implementation. Acceptance requires
linearizable detached reads, immutable ETags and atomic durable conditional writes.
Documents are bounded to 24 MiB and journals to 4,096 entries; capacity exhaustion
fails closed rather than deleting history. A future writer must enforce the total
1 GiB monitor-owned retention budget across all objects/versions/output, including
temporary copies, and must obtain an explicit capped policy for the new export
prefixes. No existing data is deleted by this preparation.

The separate delivery journal does not change v4 engine statuses or falsely mark
pending corrections as sent/retracted. `dispatch_one` only claims a currently
eligible intent, by CAS, before contacting an injected destination. Superseded,
out-of-window, changed-evaluation or invalid-ID intents are ineligible. A claim
uses a 120-second recovery lease and stable event ID; an active lease blocks a
second claimant. A CAS loser does not call the destination.

New sends also require a current/prior UTC-month subject and a publication no
older than its recorded policy freshness (inclusive, at most 36 hours). Positive
or known-low claims additionally require fresh source evidence at dispatch time.
Envelope schema 2 binds `freshnessHours` into the commit hash; legacy v6 schema 1
has no recorded bound and permits evidence-only recovery until republished.
`attempts` now counts durably reserved sends, starting at zero; lookup/recovery
never consumes this budget. Existing v6 counters remain conservative upper bounds.
Even at 100 sends, expired or out-of-window claims can reconcile a valid receipt.
Stale schema-2 claims with zero reserved sends can become `retired_no_send` only
after authoritative event-bound absence and a CAS against the current claim ETag.
That CAS fences older workers before their send reservation; it unblocks publication
without claiming delivery. Retirement records its commit sequence and remains
terminal for that publication even if a delayed worker supplies an earlier time.
Only a strictly newer successful, fresh publication can admit that intent again.
Legacy schema-1 claims (even zero counters), attempted sends and unknown lookups
remain blocked; they cannot prove that no late send is in flight.

Before any send, the destination must return an authoritative event-ID lookup:
acknowledged, absent, or unknown, bound to the requested event ID. An acknowledged
lookup must include an immutable SHA-256 receipt identity; absent/unknown must
include no receipt. There is no caller-supplied status/ack transition API.
Unknown/timeout is persisted as unknown, never
assumed delivered or failed. After expiry, recovery looks up the same event ID;
only authoritative absence permits a send. Downstream idempotency must cover late
responses and competing attempts, not merely a local deduplication cache. Ack CAS
retries do not repeat delivery. Ack persistence failure leaves a recoverable
claim; the next lookup can confirm the existing destination receipt.

While any claimed/unknown delivery exists, ledger replacement is blocked so a
correction cannot race a stale send. This is an explicit safety/liveness tradeoff.
`recovery_status` reports `delivery_reconciliation_required`, blocked publication,
and which leases are due. Persistent unknown does not become healthy or silently
expire. Recovery requires destination evidence; no force-clear path is supplied.
A future operator workflow and real destination lookup semantics must be reviewed
before activation. The fake tests demonstrate recovery once evidence becomes
available, and show that unresolved delivery remains visible and blocks publication.

## Infrastructure preparation and remaining gates

`infra/azure/billing-monitor/main.bicep` binds resources to the reviewed production
subscription/resource group. It references the existing account, environment and
Log Analytics workspace; it creates only the two named containers, identity,
manual job, inactive exports and disabled log rules. There are no role assignments,
role definitions, network/account changes, Redis changes, ACR changes or provider
registration. The JSON contract records proposed scoped grants; it grants nothing.
Export identities' provider-managed creation/grant side effects still require
review before any deployment, even with exports inactive.

The job has 0.25 CPU, 0.5 GiB, a 600-second timeout, zero retries and one replica.
It has no schedule and its command deliberately exits without executing a monitor.
A verified dedicated image digest is required with no default. No image is built,
published or validated here. No runtime wrapper is wired in; an approved wrapper
must replace the inert command after durable store, source, policy, retention,
summary and destination acceptance. A manual job can still be manually started,
so manual status is not a security boundary; no execution is authorized here.

Three disabled external rules query the existing log workspace, using one time
series each. The heartbeat rule detects absent/recently failed publication; the
other two select the greatest durable commit sequence so old corrections do not persist as
current alerts. Query syntax, actual system-log failure reasons, late log arrival,
absence behavior and end-to-end outside-job evaluation are unverified. They must
be tested with controlled fixtures/live telemetry before enabling. No action
group, webhook, ChatGPT endpoint, email or Slack destination is configured.

Bicep compilation and provider/KQL acceptance have not run locally. They require
cloud review after source freeze; no Node/compiler execution occurs during the
Mac security hold. Daily `TheLastMonth` support, export managed-identity side
effects, runtime budgets, exact grants after principal creation, image contents,
all-new-prefix retention and private ChatGPT integration remain activation gates.
Apply only via a separately approved incremental deployment. Never use complete
mode or delete/replace existing resources to make these templates fit.

## Primary schema references

The [Microsoft export manifest documentation](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-improved-exports)
provides partition metadata and notes export identity behavior. The
[cost-detail field reference](https://learn.microsoft.com/en-us/azure/cost-management-billing/automate/understand-usage-details-fields)
distinguishes agreement-specific cost fields and ServiceName availability.
The templates follow the published
[exports schema](https://learn.microsoft.com/en-us/azure/templates/microsoft.costmanagement/2025-03-01/exports)
and [scheduled query rule schema](https://learn.microsoft.com/en-us/azure/templates/microsoft.insights/2023-12-01/scheduledqueryrules).
Published schema support is not provider acceptance or permission to deploy.
