# PUN68 / PUN85 shared publication contract proposal

This proposes the integration boundary before concurrent edits. Current source
head is draft1a844d52; it is not merged main. Published fence hooks alone supply
no durable source ownership. Current EXTERNAL_DATABASE writer returns0 and must
not be accepted as publication success. The pure fence/type/driver registration
prerequisite at9bfe757d is implemented; durable SQL runtime/schema/staging is not.

## Ownership

- PUN68: source/native authority, lineage/source-plan/epoch registry, Knowledge
  publication and a verified committed publication acknowledgement. Existing
  shared `packages/knowledge/src/chunks.ts` remains coordinated with this owner.
- Batch `/root/sql_integration`, a separate local Astra worker: connector
  SQL/cursor/configuration and ingestion orchestration plus two-process tests,
  calling the agreed source-claim/publication interface. Preserve current typed
  cursor patch at334083441baf2cbbcb9df19db2abc6354f7a4d12.
- PUN68 owns additive claim/native/policy/Finance schema and migration/purge/
  lifecycle implementation. PR1523 has no schema edits; the batch parent owns its
  dormant harness and relays connector coordination. The earlier unconfirmed
  Bloop claim proposal must not create a second schema editor. No harness edits here.

## Durable source attempt

One durable source-scoped monotonic generation identifies each admitted attempt,
with exact immutable configuration/credential identity, owner nonce, lease and
status. Claim/reclaim/renewal/control and terminal changes lock the source control
row and verify the same generation. A unique job lease or cursor text is not the
source generation. Older generations cannot publish or modify terminal status,
even if their starting/ending cursor strings equal the newer attempt's strings.

Configuration changes, disable/archive/delete, credential changes and expired or
reclaimed lease invalidate the attempt. Any config fingerprint excludes plaintext
secrets from storage/logging but binds the authenticated credential. Generation
cannot be reset by deleting/recreating a claim row; retain a durable tombstone.

The trusted callback is `ArtifactInputWriteFence = (tx: Prisma.TransactionClient)
=> Promise<void>`. Published `withArtifactInputWriteFence(fence, work)` propagates
it; `assertArtifactInputWriteFence(tx)` invokes it on the real writer transaction.
The callback needs the actual durable adapter. Source/head locks precede owner
control rows under the current complete source-plan contract. No SDK, SQL provider
query, embedding or model work belongs inside a publication transaction.

## Authenticated SQL row authority

Preserve exact provider bytes and native typed row identity/cursor/schema/table
configuration from the actual authenticated SQL driver, independently of citations
or display text. A trusted server capture owns the driver fetch and binds the
result to source/configuration/attempt; arbitrary JSON, model arguments and copied
legacy chunks cannot mint a native receipt. The row receipt is encrypted/immutable,
tenant-bound, hash-bound and stored with complete source-policy vectors.

Serving uses current workspace membership, current source/configuration authority
and explicit company category/role/circle restrictions. Company-wide means within
the workspace. Existing private records remain private. Worker attempt ownership
authorizes publication only; it does not become a permanent reader grant.
Revocation/delete/restore cannot revive old vectors or retained/cache/replayed
chunks. An authenticated independent rebuild is needed after a source transition.

## Publication and positive acknowledgement

Prefer a dedicated typed EXTERNAL_DATABASE publication API over changing all
legacy numeric return callers. It accepts only exact authenticated row receipts
and a trusted source attempt. Preallocate all native/snapshot/chunk/output IDs,
prepare the complete source union outside SQL, and recheck the source generation
on the same transaction before replacement and before commit.

Commit chunks, complete lineage, local shared cache invalidation and a durable
publication receipt atomically. The acknowledgement binds source, configuration,
attempt/generation, exact page/row identities and committed count/digest. Bloop
must validate that real committed receipt before any checkpoint advancement.
Unsupported source, zero admitted rows, stale attempts and unproved lineage are
distinct errors; numeric0 cannot be used as an acknowledgement.

The connector keeps its full ten-page/10000-row cap and stages the complete run.
Naive native/chunk output unions can exceed the source plan's10000-item budget;
non-serving bounded staging plus one final publication needs implementation and
measurement. Never reduce the cap or publish a partial run silently.

For final run progress, a same-transaction checkpoint callback is required: it writes
only the cursor/status fields under the already held source control, after real
publication acknowledgement, before the final owner/permission check. Final
success/failure terminalizers use the same generation fence. Authenticated empty
scan may terminalize without advancing a cursor; it must not impersonate denied
or unsupported publication. A process crash after a committed page reuses its
durable receipt, rechecking current source permissions before any replay/serving.

## Dependency imports and native capsule

- Implemented pure callbacks: `@corgtex/domain/artifact-input-write-fence`.
- Implemented server driver registration: `@corgtex/domain/sql-native-driver`;
  `registerSqlNativeDriver("postgres", async ({source,attempt,assertCurrentSource})
  => capturePostgresScan(source,assertCurrentSource))`. Registration grants no
  native receipt or claim. Only the future trusted issuer loads/seals authoritative
  source and validates the private attempt before dispatching the registered driver.
- Types only: `@corgtex/domain/sql-ingestion-contract`. Capsule result rows contain
  exact driver `row`, `table`, typed `definition`, native tuple `values`,
  `primaryKey`, rendered `content`; pages contain table/definition/previous tuple/
  rowCount/tail tuple, including real empty scans. Result adds rowsProcessed,
  nextCursor, mandatory native beforePublication DDL/owner check+close, and
  idempotent dispose for all error/cancellation paths. Normalize a bookmark's
  previous/tail to its lossless values tuple; full definition remains separate.
- Future claim/renew/capture/fail/dispose runtime from `@corgtex/domain`;
  future prepare/publishPrepared runtime from `@corgtex/knowledge`. Domain does
  not import Knowledge. Opaque brands alone grant no runtime authority.

Preparation must dispose on any model/capture/owner failure. Publication first
stops/awaits caller heartbeat hook, then invokes the private registered driver's
mandatory native DDL check and close after model preparation, before SQL. Caller
hooks cannot substitute native evidence. Same-TX commit callback follows real
chunk/lineage/cache/receipt writes; final owner/proof checks follow the callback.
Return `committed:true` only after transaction commit. Typed verified empty input
may return committedtrue/count0; an unsupported/unproven numeric0 cannot.

Fixed server lease is five minutes; caller renews every sixty seconds during
provider/model preparation. Renewal preserves token/nonce/generation and original
proof, and any loss aborts. Stop and await an in-flight heartbeat before final DDL
check/provider close. The final publication refreshes/rechecks the live lease
before its bounded transaction and holds exact source/control ownership through
final proof validation. A timeout increase is not latency acceptance.

## Actual acceptance

Two independent processes and PostgreSQL connections with deterministic barriers:
old pauses after fetch/embedding, new publishes, old resumes; reverse acquisition
order; same cursor text; source/config/credential changes; lease expiry/reclaim;
publication/final-fence failure; partial page rollback; process restart/retry.
Assert no stale chunks, manifests, receipt, cursor, status or cache delivery, and
no provider/model calls while the application transaction holds locks.

Exercise two users/two workspaces, category restrictions, private-source mixtures,
delete/restore and missing native lineage. Measure actual SQL statements, lock
wait/hold duration and bounded pages/output closure; raising timeouts is not
acceptance. Synthetic disposable source and application databases only. No cursor
reset, resync, customer mutation, credential/grant change or deployment.
