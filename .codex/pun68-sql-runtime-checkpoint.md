# PUN-68 SQL runtime integration checkpoint

This is an additive, draft integration checkpoint for PR1517/PR1526. It does
not clear full PUN-68 or batch release acceptance. No production migration,
source cursor reset/resync, deployment, data/grant/credential change or purge is
authorized. Existing private records and immutable input bytes are preserved.

## Ownership and runtime imports

PUN-68 owns shared schema/source authority/Knowledge. The batch's isolated SQL
connector worker owns native Postgres capture/validation, orchestration,
heartbeat/cursor/status and actual two-process tests. No concurrent schema editor.

From `@corgtex/domain`:

- `claimSqlIngestionAttempt`, `renewSqlIngestionAttempt`, `failSqlIngestionAttempt`.
- `captureSqlIngestionAttempt`, `disposeSqlIngestionCapture`.
- `sqlIngestionConfigurationFingerprint`, `SQL_INGESTION_LEASE_MS` (300000),
  `SQL_INGESTION_RENEW_INTERVAL_MS` (60000).
- Opaque `SqlIngestionAttempt`, `AuthenticatedSqlRunReceipt`,
  `PreparedSqlKnowledgeAttempt`, `SqlPublicationIdentity`,
  `CommittedSqlKnowledgePublication` types.

From `@corgtex/knowledge`:

- `prepareSqlKnowledgeAttempt({attempt, receipt})`.
- `publishPreparedSqlKnowledgeAttempt({attempt, prepared, beforePublication?,
  commit(tx, identity)})`.

From `@corgtex/domain/sql-native-driver`:

- `registerSqlNativeDriver("postgres", captureDriver, {accessValidator})`.
- `renderSqlNativeRow(row, definition.columns)` derives deterministic model text
  from actual native cells; receipt issuer does not trust supplied `row.content`.
- `SqlNativeDriver`, `SqlNativeDriverResult`, `SqlNativeAccessValidator`,
  `SqlNativeDefinition`, `SqlNativeCapturedColumn`, `SqlNativeRow`,
  `SqlNativePage`, `SqlSourceConfiguration` types.

All port types also live at `@corgtex/domain/sql-ingestion-contract`. Domain
claim/capture modules do not import Knowledge publication. A type port is no
runtime grant: attempts, captures and preparations require exact private identity.

## Claim, capture and publication contract

Claim before parsing/decrypting/connecting:
`{workspaceId, sourceId, expectedConfigurationFingerprint, expectedCursor, logId}`.
The immutable birth tuple includes durable generation, nonce, original source
permission vector, config fingerprint, cursor and bound log. The compatible v1
fingerprint preserves exact existing JSON property order, including encrypted
credential bytes and selected-table order. Never rewrite compatible v1 cursors.

Caller heartbeat renews the same token every sixty seconds. Stop and await any
outstanding heartbeat in `beforePublication`; that hook cannot replace native
authority. The private native hook rechecks DDL/owner after models and closes the
provider, then the mandatory registered current-access validator runs outside app
SQL. Issuer checks after capture/model awaits precede receipt/vector admission.
Disposal is idempotent on completion, preparation error or cancellation.

The final transaction holds canonical source/claim ownership and the exact
original source/native policy epochs. Chunk replacement, original lineage,
Postgres cache version, callback cursor/own success log, publication receipt and
terminal attempt/claim status commit together. The final complete chunks and
manifests are rechecked after the callback. Only `commit(tx, identity)` can update
cursor and that attempt's success log; failure rolls all effects back. Return is
discriminated `{committed:true, ...identity}` only after the real transaction
commits. Numeric zero is never a publication acknowledgement. A verified native
empty page may acknowledge zero chunks with either unchanged null or typed cursor.
Late failure may update its own unfinished log, never newer source status; a
cascaded missing old log is tolerated and duplicate cleanup preserves original errors.

Capture accepts only an opaque attempt and invokes registered trusted driver
code with authoritative sealed source config. Application callers supply no raw
rows or replacement native hook. Complete native rows/pages are encrypted and
hashed, including empty-page coverage and full native column definitions. Limits
remain ten pages of at most 1000 rows, 64 MiB native bytes, 100000 declared output
chunks, and embedding/staging batches of 500. Limits throw before publication;
they never partially advance a cursor or silently reduce the 10000-row cap.

Bounded staging declares complete identities/counts in PREPARING before models,
streams each500-vector model batch into immutable non-serving staging, and drops
those vectors before the next batch. Only the complete descriptor/hash set can
seal PREPARED. Publication loads at most500 staged vectors per batch; private
preparation state keeps compact identities/hashes, and a compact SHA256 manifest
ledger preserves complete post-callback rollback checks.

Full ordered captured columns are `{name,type,typeOid,typeModifier,collationOid,
position,isNullable,identity,generated}`: declared pg_type/pg_attribute metadata,
position=attnum. Raw records require the exact key set; JS integer-like property
enumeration is not SELECT order. Native driver owns protocol-field/race checks.
Ordering-only cursor/key definitions retain their existing v1 format.

Issuer uses V8 cloning/serialization to preserve native Buffer/date/int8 cells.
Encrypted native payload seals renderingVersion1 and derived text in actual
column order. Buffer/bytea rendering uses base64; nested arrays/objects and ISO
Date fallback are deterministic across replay timezone. That fallback cannot
recover precision/naive interpretation already lost by a provider parser. The
connector must retain exact temporal wire text under its scoped per-Client
decoder/session UTC/ISO; no global pg parser changes or temporal PK resync.
Already-decoded Date cells (including nested arrays) cannot mint or replay an
exact PostgreSQL receipt; ISO rendering fallback itself confers no native authority.

Validator receives `{source, parents:{rows,pages}, assertCurrentSource}`; rows
contain only exact table/definition/ordering values/PK identity, never model text.
Use full captured cursor+PK equality and authenticated SELECT of the full captured
column set under current RLS. Payload-only changes can prove current access to
preserved historical bytes; cursor-changing updates deny that old parent. Empty
page checks prove definition/column SELECT authority, not nonempty row authority.
Authenticated definitive denial returns false; unsupported/network/auth failures
and ambiguous RLS dependency errors throw. No local-permission fallback.

## Serving, rollback and migration

Ordinary retrieval, direct chunk fetch, cache/citation release and downstream
source commits require current membership/category/role/circle/Finance checks,
original vectors, exact staged committed membership and mandatory provider proof.
Provider replay is outside SQL; private one-use downstream preflight is bound to
the exact actor, workspace, roots/native inputs and real transaction and expires.
Expiry means the exact scope ends, not a provider grant lease or TTL. Provider
SELECT is a read observation. Provider-only revocation after replay and before
app commit can leave immutable storage committed; every subsequent delivery
freshly authorizes and withholds it. No cross-database atomicity or durable
provider permission is inferred from storage.
An observed provider denial permanently invalidates that receipt's own serving
epoch. Restoring grants cannot recertify original cached outputs; a new independent
native scan is needed. Unproved/network access is temporarily withheld, preserving
originals. Workspace-wide access conveys no Internet publication permission.

Bulk ordinary SQL candidate/read proof validates actual full candidate rows,
latest manifests, staged membership, original native/publication identities and
submitted plus persisted complete epoch unions. Caller policy/role history is
captured once before native/model admission. Local full closure is checked before
and after authenticated native replay, with exact entry/exit stamps. A failed
batch falls back to individual admission so one unknown child does not hide other
safe children. Mixed, agent and MCP paths retain the general executor. The bounded
16 MiB/16-entry cache stores decoded immutable bytes/shape only, never grant results.

Migrations `20261014000000_sql_ingestion_claims`,
`20261014010000_sql_native_publication` and
`20261014020000_sql_bounded_staging` are additive. Claim/attempt/native/publication
tombstones have workspace custody, deliberately no source/log cascade that could
revive an old source generation. Existing source policy defaults are workspace
GENERAL and do not rewrite private records. No legacy chunk becomes eligible
without complete authenticated lineage. Fresh replay of all185 migrations on an
owned disposable local database passed. Tenant purge inventory includes all new
workspace custody models. Migration186 permits only the complete PREPARING-to-
PREPARED transition to seal the streamed hash; existing sealed receipts remain
immutable. It passed on the same disposable DB after the fresh185 replay.
Do not apply these migrations to production here.

Rollback must keep source epoch/claim/native tombstones and original inputs;
rolling back a reader/writer cannot restore eligibility for old unproved chunks.
Backfill cannot infer publication consent or re-stamp a native original. Full
legacy/lifecycle rebuild integration remains an acceptance hold.

## Evidence and remaining acceptance

Local real application PostgreSQL with a deliberately synthetic registered
native driver:29/29 claim/publication regressions pass, including full10000-row
publication/normal search, private/category/role-circle and caller loss/restore,
unknown lineage, provider denial/unproved/restore, final callback output/manifest
rollback, native await loss and downstream immutable article proof.104 focused
unit regressions and full repository TypeScript pass. Final null initial-cursor
empty-page and public destination cases are additional focused checks. Bounded
independent GPT-6.1 Sol xhigh review found no correctness blocker in this scope.
Logs are local `/tmp/pun68-sql-runtime-verified-cohort-pg.log`,
`/tmp/pun68-sql-runtime-final-cohort-unit.log` and
`/tmp/pun68-sql-runtime-verified-cohort-types.log`.

Bounded staging/count followup:44/44 real application-PG regressions pass,
including the complete4000-row/12000-chunk count in27.4s INCLUDING preparation
and publication, under the unchanged60s test limit. Mixed body/head/epoch races,
clock-driven role expiry, independent unknown-child withholding, a new source
during empty admission, second-model-batch failure/fresh retry, immutable cipher
updates and same-ID native replacement all pass. Original ciphertext remains
immutable; per-stage fences hold its actual row and compare every original header
and payload hash plus the complete original epoch vector without reloading its
full ciphertext each batch. Disposal clears only process-local capture memory.
Five focused count/renderer units, final full repository TypeScript and scoped
ESLint pass; independent Sol found no bounded code blocker. Evidence:
`/tmp/pun68-sql-bounded-aggregate-result.json`,
`/tmp/pun68-sql-bounded-aggregate-pg.log`,
`/tmp/pun68-sql-count-stream-unit-final.log`,
`/tmp/pun68-sql-bounded-final-types.log`,
`/tmp/pun68-sql-bounded-final-lint.log`.

These are not actual connector/two-process acceptance. Worker must compose the
published actual runtime and complete both publish orders, same cursors, reclaim,
configuration/credentials, delete/recreate, rollback/cache/status and full4000
rows/at least8000 chunks/over10000 combined identity regressions. Measure real
model-sized vectors, complete legal output sets, peak memory, query count, lock
duration and competing policy writes. Full-vector retention has been replaced by
bounded500-vector batches; actual worker1Gi resource acceptance remains open
until the connector reruns the composed production path.

Ordinary SQL counts scan the complete bounded100000-child collection in500
identity pages. PostgreSQL compares canonical children to immutable staged bytes
and validates exact original native/child vectors, independently withholding
unknown children. A compact SHA256 row/head ledger retains every raw candidate
and original epoch. After fresh native authorization, a shared RepeatableRead
snapshot rechecks complete raw cardinality/native collection, all row/head stamps
and original epochs, current native source/role/terminal authority (including
wall-clock role expiry), and bounded generic root bodies/heads/permissions for
mixed counts. Generic search/root budgets and the10000-native-row cap remain
unchanged; over-bound collections fail explicitly without a partial count.

Recall/native recorder, broader producer/category/audience/role-circle consent
integration, Finance immutable restatement revisions, lifecycle/regeneration,
legacy/backfill/rollback and integrated Astra QA remain full PR1517 blockers.
Do not merge/deploy or describe this checkpoint as the complete permission fix.
