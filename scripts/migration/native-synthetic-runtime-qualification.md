# Native synthetic runtime qualification

`native-synthetic-runtime-qualification.mjs` retains the reusable controls proven by
the R8 synthetic Azure qualification without copying the private, one-off controllers
or granting provider authority. It is an adapter contract, not a deployment command.

The workflow requires a synthetic-only fixture, an unavailable external AI provider,
an accepted non-DDL bootstrap bound to the exact scope and release, and an absolute
start/cleanup window. Only the synthetic fixture may disable `daily-digest`; normal
maintenance, fleet, and product jobs remain enabled. Existing maintenance must drain
before restart injection, and any failed baseline job stops the run.

Browser measurement uses a fresh page for every full navigation in the same
authenticated context, disables cache through the adapter, and observes each rendered
page for at least 500 ms before a second page/resource-error readback. The retained
`fixtures/reused-page-react418.json` case is still `UNRESOLVED_REGRESSION`: fresh-page
success does not suppress, reinterpret, or fix the R7 reused-page React 418 failure.

Failures record phase, operation, stable error code, and only allowlisted structured
signals such as known error codes, timeout state, and non-sensitive failure classes.
Free-form stderr and messages are not retained. Cleanup always runs and must prove both owned
resource absence and credential removal before the absolute deadline. A primary
failure plus failed cleanup is reported as a combined failure; one cannot hide the
other.

## Evidence boundary

The reused R8 evidence covers release `de69296016c74763a20cbd874b2ef3cc0379c5f4`
on a dedicated Standard_D2s_v7 VM, PostgreSQL 18 B1ms with 7-day backups and no HA,
and local Redis. It passed 427 fresh-page browser samples, the full 90-minute soak,
graceful and forced recovery, and PITR. The historical $13.71 is an estimate, not a
billed amount. No new cloud run is required or authorized by this repository change.

That evidence is not Ops/Core production-cutover acceptance. Before any proposed
cutover, read-only inspection and an explicit production authorization must establish:

1. exact proposed image digests, serving SHA, schema ledger, and database binding;
2. actual Ops/Core workload, maintenance jobs, AI and external connector behavior;
3. production compute, PostgreSQL and Redis topology, capacity, HA and failure domains;
4. backup retention, an approved recovery objective, and target-specific restore proof;
5. single-writer fencing, source retention, rollback/recover-forward ownership, and a
   serialized cutover window.

The smallest next step is a read-only exact-target inventory for the proposed Ops/Core
destination. Any provisioning, writer stop, customer-data copy, routing change, or
cutover requires separate approval.
