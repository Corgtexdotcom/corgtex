# Provisional Azure billing ledger engine

This is an offline normalized-manifest engine with synthetic tests. It does not
fetch exports, establish billing finality, send alerts, access credentials or write
state files. It is not an active monitor or evidence that any Microsoft measurement
or service-qualification program has been satisfied.

The provisional rule is explicit: ActualCost, USD, at least USD 1.00 per distinct
mapped service per UTC calendar day, with at least six services qualifying
simultaneously. The official service mapping and measurement window remain unknown.
The policy supports six to 64 unique service IDs, a configurable minimum qualifying
count of at least six, and an exact positive threshold. Every result remains
provisional. No production configuration or resources are included.
The rule means any six of the designated configured set on each day, not the
same fixed six-service subset on every day of a simultaneous streak.

## Normalized contract

The CLI accepts manifest, policy and optional previous-state JSON files. Objects
have closed schemas. Duplicate JSON keys, numeric floats, nonfinite values, unknown
versions and unexpected fields are rejected.

Example policy uses synthetic service identifiers:

~~~json
{
  "version": "provisional-v1",
  "provisional": true,
  "mappingVersion": "synthetic-map-v1",
  "expectedSubscriptionId": "00000000-0000-4000-8000-000000000001",
  "services": ["service-1", "service-2", "service-3", "service-4", "service-5", "service-6"],
  "minimumQualifyingServices": 6,
  "thresholdUsd": "1.00",
  "maturityHours": 72,
  "freshnessHours": 36
}
~~~

The manifest requires schemaVersion 1, costBasis ActualCost, currency USD, the
exact policy mappingVersion and a snapshots array. It admits at most one
authoritative snapshot for each of the current and previous UTC calendar months.
A missing month remains unknown. The previous month's replay is not a claim that
its billing period has closed.
It also requires subscriptionId matching policy expectedSubscriptionId exactly,
using a canonical lowercase nonzero UUID. Persisted state is bound to the same
subscription and cannot be reused across scopes. This is a normalized source-scope
contract, not authentication of the upstream export; the future adapter must prove
the actual source identity and reject an unexpected provider data schema.

Each snapshot requires:

- period: UTC YYYY-MM in the admitted window.
- snapshotId: a lowercase SHA-256 identity supplied by the adapter; revision:
  monotonic integer from 1 to 1,000,000.
- exportedAt: UTC YYYY-MM-DDTHH:MM:SSZ, never in the future.
- ingestionComplete: boolean; completenessEvidence: nonempty bounded reference
  when true, otherwise null.
- days: distinct dates in the snapshot month, with no future dates.

Each day requires date, finalized, finalizationEvidence (nonempty reference when
true, otherwise null) and records. Each record requires sourceRecordId, serviceId,
provider, serviceName and chargeUsd. The sourceRecordId is globally unique across
the supplied window. The serviceId names exactly one configured service or is null
for an explicitly unmapped record. Splitting a source record across mappings or
repeating it to count a charge twice is rejected. The future adapter must also
reject overlap in its actual mapping rules, which this engine cannot inspect.

ServiceName may be null for unavailable data; it is never fabricated from
ServiceFamily, MeterCategory or a mapped ID. Provider, ServiceName and combined
provider-plus-ServiceName views each count every admitted source row once. These
are alternative views: do not add their totals together. Results retain the mapping
version, previous evaluation and current evaluation.
Unallocated adjustments remain signed amounts in a separate unallocatedView and
in the dimension totals; they are not discarded or assigned to a service to make
it qualify. Two legitimate equal-dimension rows with distinct sourceRecordIds both
count. Deduplication never uses reduced date/provider/amount keys.

Completeness and finalization are explicitly **unverified upstream assertions**.
Before asserting completeness, an adapter must validate every listed partition,
source identity, repeated headers, byte counts, row counts and blob counts. That
adapter is not implemented here. A complete export is not a finalized invoice.

Official references for future adapter work:

- [Improved exports](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-improved-exports):
  manifest version 2024-04-01, export/run metadata, overall and per-blob counts.
- [Usage detail fields](https://learn.microsoft.com/en-us/azure/cost-management-billing/automate/understand-usage-details-fields):
  fields vary by account type; Date/ConsumedService, CostInBillingCurrency for
  EA/MCA, Cost/PreTaxCost for PAYG, and ServiceName only for PAYG. Choosing an adapter
  still requires an approved live schema snapshot. These references do not prove
  adapter or deployment readiness.

## Exact amounts and separate streaks

Amounts accept an optional minus sign, at most 18 integer digits and at most 18
fractional digits. Exponent notation, leading plus signs, numeric floats, NaN and
infinities are rejected. Decimal precision 80 covers the bounded 25,000 rows without
rounding. No monetary quantization is performed; refunds remain signed.

The ledger distinguishes missing days, no matching records (null amount),
explicit matching zero records, nonzero charges offset to net zero, other values
below the threshold and qualifying charges. Zero and missing never qualify.

Three independent per-service and simultaneous-service streaks are retained:

The current provisional contract requires maturityHours exactly 72. Longer
maturity policies are not admitted by this bounded carry implementation.
Changing this internal provisional timing rule requires a versioned policy and
code review; it is not a statement of Microsoft's measurement window.

- observed: qualifying amounts from complete, fresh snapshots;
- mature: observed qualification at least 72 hours after the UTC day's end;
- confirmed: mature qualification with an upstream finalization assertion.

Missing, stale, incomplete, unmatched and below-threshold days cannot bridge
observed/mature streaks. Unfinalized days additionally reset confirmed streaks.
Maturity alone is neither completeness nor finalization. Lack of invoice finality
does not suppress truthful mature-observed provisional pending alerts. Their
alertBasis remains mature_observed and provisional remains true.
Every service with a fresh, complete, mature, known amount below the threshold
also produces a distinct below-threshold pending intent, including explicit zero
and offset-to-zero amounts. Missing, stale, incomplete or immature observations
never become zero-cost alerts; they remain separate data-quality findings.

## Replay, revisions and pending intents

Every run recomputes current and previous calendar months from authoritative
snapshots, instead of appending new exports to old totals. Snapshot/day/row order
has no semantic effect. Conflicting same-revision source data, decreasing revisions
and decreasing replacement timestamps are rejected. Revision watermarks survive
a temporarily missing export. A new explicit mapping version can remap unchanged
source rows without pretending the underlying export changed.

Refunds, replacement exports and mapping changes recompute classifications and
subsequent streaks. Identical semantic evaluations create no duplicate pending
intent, including a newer export with unchanged charges. Changes receive stable
sequence-based idempotency keys and supersede obsolete pending intents.

A bounded carry checkpoint retains at most one boundary evaluation per mapped
service plus one simultaneous-service evaluation (65 total maximum), for the day
immediately before the replay window. This preserves longer streaks across month
and year rollover without retaining every old daily row. Carry is bound to the
complete policy/mapping fingerprint. A changed policy or absent/unknown boundary
evidence starts that streak basis at zero; earlier history is never invented.
Corrections in the retained months recompute from that boundary. A correction
older than the retained boundary needs an explicitly admitted historical replay;
this engine does not claim to detect out-of-window changes.
Prolonged skipped-run recovery with an immature or unknown retained boundary also
requires an admitted historical replay before claiming continuity; an unknown
boundary reset is not proof that earlier qualifying activity did not occur.

Pending intents outside the new evaluation window are marked superseded while
their history remains retained. They cannot remain eligible for future delivery.
Known below-threshold to qualifying transitions, and the reverse, preserve both
evaluations and create pending correction intents without claiming message delivery.

There is no transport. The only outbox states are pending_no_transport and
superseded. A correction is a pending intent, never a claim that a delivered
message was retracted. Private ChatGPT destination ownership, authentication,
idempotent delivery and acknowledgement remain unproved. There is no fallback
to GitHub issues, email or an invented webhook.

## Bounds and activation gates

Each input/state is capped at 8 MiB, output at 16 MiB, records at 25,000, replay at
62 days, labels at 160 characters, IDs at 80 characters and CLI runtime at 540
seconds. Exhaustion returns a safe error code and leaves previous state untouched.
The CLI writes a private result to stdout for an explicit caller-controlled pipe,
not ordinary container logs. It writes neither raw exports nor state files.
Exit zero means the calculation completed, not that billing evidence is healthy:
the explicit dataQuality result reports missing, stale and incomplete exports and
missing mature dates. It also aggregates unmatched configured service-days,
including a mature count, so an unknown seventh service cannot make overall
configured coverage appear healthy. That does not disqualify six known qualifying
services, or convert the unknown service to a below-threshold observation.
A future wrapper must inspect dataQuality before issuing a success
summary. Valid observations on other dates remain truthful provisional results.

The future wrapper must provide atomic conditional state commits, single-writer
coordination and a total monitor-owned ledger/state/output retention cap of 1 GB.
This offline engine cannot establish aggregate cloud storage usage. Outbox history
is not silently deleted; reaching the state cap fails closed. Export retention
requires a separate explicitly capped policy before activation, with no deletion
of existing data inferred from this preparation.

The planned daily job remains 0.25 CPU, 0.5 GiB and at most 10 minutes. This patch
does not add that job, image, RBAC, network rules, exports, delivery or heartbeat
resources. A later wrapper must emit a sanitized success summary only after its
durable state commit. An outside-job monitor must detect missing success within
36 hours and select the newest committed summary so corrections replace old
conclusions. A job reporting its own failure is not an independent heartbeat.

Activation still needs the approved schema adapter, finalization authority,
measured resource use, capped storage/export retention, approved infrastructure
bundle, private delivery, independent cloud QA and accepted incremental cost.

## Focused tests

Run only where Python source/test execution is authorized:

~~~sh
python3 -B -m unittest discover -s scripts/ops -p 'test_azure_billing_ledger.py' -v
~~~

Fixtures are synthetic. Tests cover exact decimal boundaries, zero/refund
distinctions, six-of-more-than-six services, all three streak bases, unknown gaps,
duplicate source rows, unavailable ServiceName, late corrections, source ordering
and revision conflicts, month/year rollover, bounded long-streak carry,
below-threshold alert transitions, expired pending intents, idempotency,
subscription scope, unallocated adjustments, leap days, distinct legitimate rows,
mapping-dependent simultaneous streaks, safe CLI errors and resource bounds. No
provider calls, alert sends, local Node/npm/build/compiler execution or real
billing/customer data are used.
