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
chunks, and vector-bearing embedding/staging/publication batches of 128. Limits
throw before publication; they never partially advance a cursor or silently reduce the 10000-row cap.

Bounded staging declares complete identities/counts in PREPARING before models,
streams each 128-vector model batch into immutable non-serving staging, and drops
those vectors before the next batch. Only the complete descriptor/hash set can
seal PREPARED. Publication loads at most 128 staged vectors per batch; private
preparation state keeps compact identities/hashes, and a compact SHA256 manifest
ledger preserves complete post-callback rollback checks. Identity-only row
replacement pages remain 500. Persisted-row verification and final callback
content checks use the same 128-vector bound, including the final partial page.
No complete output/vector limit or preparation/publication timeout changed.

The actual `7cb4c6b2` transport checkpoint still failed the unchanged 4,000-row /
12,000-chunk x 1,536-vector worker at model batch 3 / 1,500 embedded chunks:
startup 423,591,936B, capture 714,244,096B, model 1,078,345,728B and OS peak
1,078,394,880B against 1,073,741,824B. All 13 connector process/cold-reader/race/
provider cases pass, but these functional results do not clear capacity. The
128-vector correction passes 51 source PG regressions plus two final-tail
callback rollback cases; the model-failure/fresh 600-output retry uses
1,536-dimensional vectors. Bounded independent Sol QA accepts this correction.
Existing connector ownership retains the complete unchanged 512MiB-V8 / 1GiB-RSS
rerun, including ordinary reads, query, transaction and concurrency measurements.
Actual capacity remained unaccepted at that checkpoint.

The actual `bc6ccb2d` composition subsequently committed all 4,000 rows and
12,000 chunks x 1,536 vectors: 94 model batches, publication duration 126,696ms,
OS publication peak 807,960,576B, longest locked transaction 76,296ms (below the
unchanged 120s limit), 4,289 top-level queries and 136,348 including triggers;
2,411 observer queries were excluded. Its 13 smaller process cases pass. The
first ordinary fetch then failed at 1,079,689,216B against 1GiB, with 55,846,776B
of array buffers. Full fetch/count/search/downstream capacity remained withheld
at that checkpoint.

The followup read correction transports complete originals in at most two
512KiB ciphertext parts per query. Full client/server SHA and exact entry/exit
headers reject partial, substituted or mixed reads. Local bulk proof rechecks
retain complete ciphertext equality through server SHA and original headers.
Existing immutable-byte cache reuse requires the exact stored ciphertext SHA;
current membership, configuration, original epochs and live provider proof are
still rechecked. Cache budgets, ciphertext format and public domain ports remain
unchanged. The decoder authenticates complete GCM ciphertext in a bounded first
pass before interpreting base64; a second bounded pass produces the exact V8
bytes, retaining the 64MiB byte bound, payload SHA and full native shape checks.
This adds no migration or serving authority. Source-lineage, retrieval, bulk
proof and downstream commit preflight share the same bounded custody loader.

Read correction evidence: 53/53 real source PG regressions, 6/6 focused positive/
substitution/read-proof cases, 1/1 final downstream source-commit case and 18/18
crypto/fingerprint units pass. Bounded independent Sol QA found no remaining
crypto/custody/hash/authority blocker. The connector owner composed source
`ed5f379a8a98ce014208cddcaf292cb97cc30fc1` into clean local head
`3d737527543aa102de78538215ae0be3ee88381e`. The unchanged 4,000 rows / 12,000
chunks x 1,536 vectors pass complete publication, ordinary fetch, count 12,000,
search and downstream proof at 512MiB V8 and whole-process 1GiB. OS peak is
946,290,688B (902MiB), leaving 127,451,136B (122MiB) headroom. Publication takes
125,117ms, longest locked transaction 75,316ms below the unchanged 120s limit,
and reads 46,713ms. Publication has 4,288 top-level queries / 136,347 including
triggers, excluding 2,379 observers. All 13 independent process/race/cold-serving
cases pass. Independent Astra accepts this bounded composed SQL integration.
Evidence remains in the connector owner's ignored `.artifacts/` files:
`sql-bounded-reader-full-run-metrics.json`, `sql-bounded-reader-full-run.log` and
`sql-bounded-reader-process-races.log`. Separate read-query counts and full
concurrent-job capacity are unmeasured; connector ownership retains pre-claim
SQL-exclusive admission and its acceptance. No resource or timeout changed.

The four existing count-fixture failures reproduce with the published `bc6ccb2d`
retrieval/count modules. The fixture now returns the missing empty native
collection stamp and models the existing final snapshot port using its original
complete-root permission proof before and after native authorization. All prior
privacy/window/cache/count assertions remain. Three new final-snapshot negatives
withhold on parent ancestry, uncited-child ancestry or SQL collection changes.
The fixture passes 40/40 and affected read/count/cache/renderer selection 87/87;
scoped ESLint and independent Sol QA pass. Logs are
`/tmp/pun68-count-fixture-unit.log` and
`/tmp/pun68-count-fixture-aggregate-unit.log`. This followup changes tests only.

Exact `ed5f379a` CI run 38515120361 fails TypeScript with exit134 near the default
4GiB heap before tests. Build, database sync, policy and boundary checks pass;
synthetic ARM64 preparation separately fails the pinned Postgres image pull with
registry rate limiting. One cold local compiler trace at the established 8GiB
diagnostic heap succeeds with incremental disabled. Its dominant 5.296s relation
is `shared/db.ts:42` passing the inferred PrismaClient to the TransactionClient
argument of `assertMcpOriginActiveAdvisory`; this identifies a type expansion
hotspot, not total memory attribution. Trace dumping itself forces type rendering
before statistics, so traced memory is not an uninstrumented CI estimate. Prior
untraced 4,082,802K and actual hosted OOM remain the budget evidence. Diagnostics
are `/tmp/pun68-cold-ts-diagnostics.log`,
`/tmp/pun68-cold-ts-trace-summary.json` and `/tmp/pun68-cold-ts-hotspots.json`.
No shared DB/MCP guard, workflow, provider or resource setting changed here.

The fixture-only `2f4b7479` hosted run 38518341397 also OOMs at typecheck with
exit134 before tests; its ARM64 preparation passes. The identical local cold
4096MiB baseline reproduces OOM. Per-source attribution then identifies a second
whole-client comparison at the shared-state factory's custom-datasource callers.
The correction describes only the MCP checker's exact existing read queries and
generated payloads, and gives the shared-state factory its four actual generated
query/transaction/version capabilities. Canonical MCP writer/capture/scope ports,
complete transaction overloads and caller-owned invalidation transactions retain
their original generated types. No runtime statement, query, option or test
fixture changes: emitted JS matches `2f4b7479` byte-for-byte. The constructor
experiment is removed; `db.ts` itself is unchanged.

Full cold repository TypeScript now passes at the unchanged 4096MiB heap with
incremental disabled and no trace: 5,460 files, 1,337,742 types, 5,159,998
instantiations, 3,715,144K reported memory, 57.90s wall time and 3,992,600,576B
maximum RSS. All type assertions are included: configured/default/transaction
compatibility, required query shapes/full authority payloads, missing capability
negatives and unchanged transaction writer ports. Affected MCP/database/shared
state units pass 39/39, scoped lint/diff pass, and independent Sol accepts the
bounded correction. Evidence: `/tmp/pun68-types-4g-shared-state-boundary.log`,
`/tmp/pun68-shared-typing-unit.log`, `/tmp/pun68-shared-typing-lint.log` and
`/tmp/pun68-mcp-typing-runtime-proof.json`. Exact correction-head hosted CI remains
required; this local compile does not clear the held full PR/source integration.
No checked-in compiler configuration, workflow, resource, permission or provider change.

The coordinator confirms sole source-lane ownership of recorder/intake/native
transcript receipt/principal, Recall bindings/webhook callers and matching tests,
with no known competing editor. Connector ownership stays SQL/outbox/bootstrap;
Brain conversation remains separate. The compiler-only head `b0f97af6` settled
before the following authenticated recorder checkpoint.

## Authenticated Recall recorder checkpoint (migration 188)

The complete `b0f97af6` CI run 38521473365 terminated with test failure:
12,492 passed, 15 failed and 39 skipped. Hosted typecheck, unused locals, build,
ARM64 preparation, database checks and policy/private/public boundaries passed.
The failures were seven recorder intake cases, six ranking mocks missing the
external-source delegate and two tenant derived-selector drift checks. The
compiler blocker is closed; this is not a whole-PR CI success.

Recorder intake now claims a durable generation/nonce before provider HTTP.
Only signed Recall webhook origin or authenticated canonical Recall recovery can
produce private attempt/prepare receipts. Workspace, provider credential/account
configuration, recording/bot/Meeting, exact provider event and original policy
vectors are sealed before fetching. Migration 188 adds workspace custody binding,
claim, attempt and publication rows plus a distinct RECORDER native mode with no
fabricated human owner. Original encrypted native inputs and publication identity
are immutable; binding revocation cannot revive an old revision. Database
configuration disable/restore invalidates the original policy vector.

Preparation preserves complete provider response text in encrypted custody and
selects the trusted adapter's exact response branch in declared request order.
Discarded partial downloads and failed responses remain custody during fallback.
The existing 20 MiB attempt transport budget is enforced while streaming, shared
across parallel responses; oversized streams are cancelled before full-body
allocation. Ordinary provider requests retain their existing reader. Unknown
prior transcript or Meeting ancestry is withheld even when its text matches.
Legacy processed/duplicate markers cannot substitute for an exact durable native
publication receipt; authenticated recovery can proceed while unknown ancestry
still fails closed. Verified empty intake has its own fenced native terminal
receipt and creates no serving transcript or event.

Provider work and full preparation stay outside application SQL. A single real
120-second transaction publishes the Meeting/transcript, exact complete manifests,
insight/progress/audit controls, pending outbox event, recording/smoke/provider-event
markers and immutable publication receipt. Source head/physical locks, original
epochs, exact control before/after projections and complete output/manifests are
checked after writes. A direct native consumer explicitly holds the publication's
original transcript manifest through commit. Positive committed results return
only after transaction commit; failure leaves the captured original and rolls all
publication effects back. Later privately authenticated recordings retain exact
prior recorder ancestry without borrowing a later worker lease as a reader grant.

Validation: 31/31 final real-PostgreSQL recorder cases pass, including actual
signed-webhook/authenticated-recovery drivers with synthetic HTTP outside SQL,
claim/reclaim and busy retry, owner/epoch restore races, empty custody, exact event/
manifest/output rollback, unreceipted legacy recovery, partial-download fallback,
direct original-manifest lock contention and shared/oversized response cancellation.
The earlier sequential source aggregate passed 103/103 (five files); its unaffected
SQL/native/source-plan coverage is reused. Final affected units pass 213/213 across
ten files; earlier broader affected units passed 233/233. Ranking and tenant
fixtures retain their original policy assertions; the staged SQL child is included
in indirect tenant selectors and the direct custody relation count is now 190.
Full TypeScript and unused locals pass with incremental disabled at the unchanged
4 GiB heap. Affected ESLint, diff and public/private boundary checks pass.
Independent Sol xhigh accepts the bounded checkpoint after review of the final
code and PostgreSQL/unit evidence; compiler completion is confirmed separately.
Migration 188 was applied only to the source-owned disposable PostgreSQL fixture;
no production DDL or connector fixture operation occurred in this checkpoint.

Evidence is local ignored/temporary output:
`/tmp/pun68-recall-transport-final-pg.log`,
`/tmp/pun68-recall-aggregate-pg.log`,
`/tmp/pun68-recall-final-unit.log`,
`/tmp/pun68-recall-types-final.log`,
`/tmp/pun68-recall-unused-final2.log`,
`/tmp/pun68-recall-review-closure-lint.log`,
`/tmp/pun68-recall-transport-lint.log`,
`/tmp/pun68-recall-migration188.log`, and
`/tmp/pun68-b0-terminal-ci.json`. No generated evidence or provider data is committed.

Automatic approval review rejected a proposed `source-lineage.ts` change that
would have replaced the exact recorder private-purpose check with general
`actor.kind === "agent"` readability. Its stated reason was that this broadened
authority and conflicted with the explicit no-label/private-purpose boundary;
focused tests did not authorize the weakening. The rejected edit was never
executed or retried. The exact active-member/private-purpose gate is retained.
This permits the bounded recorder intake/member-read workflow but still blocks
generic agents from consuming committed recorder sources. Broader Brain/agent
consumer integration and any new authority remain held, together with unobserved
external credential restore and full category/circle/consent integration.

The existing connector owner retains SQL/outbox/bootstrap and resource acceptance.
Previously measured unchanged SQL full publication/fetch/count/search/downstream
capacity is reused; no duplicate connector or full worker run was started here.
The final source checkpoint still requires exact-head hosted CI and integrated
Astra QA before any full PR/batch clearance. No merge or deployment.

Exact recorder head `2c73321c68b88b83ee533235ef4c8662ea2ecd9c` CI run
38536877066 is now terminal FAILURE: 12,507 passed, 31 failed and 39 skipped;
768 files passed, two failed and two skipped. Hosted typecheck/unused/build,
database sync, ARM64, docs/policy/scope and secret/client-data scans passed.
Thirty recorder PG failures came from absent synthetic Recall shell settings;
the remaining demo-credential fixture expected billing refusal while recorder
DELETE correctly emitted permission rebuild work and the async guard refused.
All fifteen earlier b0 failures passed in this run. Later scripted test-job gates
were skipped after the full-suite failure, so complete hosted acceptance remains
outstanding. Separate Astra review accepts the bounded 2c implementation.

The reviewed fixture correction sets/restores only synthetic Recall settings,
clears developer binding JSON, and preserves all 31 recorder assertions. An
explicitly env-cleared rerun passed 31/31 in 73.65s. The batch coordinator reserved
the demo credential integration test for this lane. Its correction proves both
pending and dispatched permission work still refuse refresh, then isolates only
the exact synthetic workspace/type/recording-governor event IDs before the
independent billing negative. All original credential/SSO/billing/foreign-access,
later asynchronous refusal and actual revocation assertions remain. That real PG
case passed 1/1 in 824ms. No production disconnection guard, source permission,
resource, migration or runtime implementation changed. Evidence:
`/tmp/pun68-2c-ci-terminal.json`, `/tmp/pun68-2c-ci-failures.log`,
`/tmp/pun68-recall-ci-env-pg.log`, `/tmp/pun68-demo-recorder-event-pg.log` and
matching scoped lint logs. Full and unused-locals TypeScript pass at the unchanged
4 GiB heap with incremental disabled after both fixture corrections; evidence is
`/tmp/pun68-ci-fixture-types-final.log` and `/tmp/pun68-ci-fixture-unused-final.log`.
Independent Sol accepts the small fixture/proposal deltas. Fresh correction-head
hosted CI remains required.

The requested next-slice proposal lives in
`.codex/pun68-finance-restatement-design.md`: exact Finance proposal/reconciliation/
review/application/lineage consumers, later removal/variant consumers and exclusions,
real successful restatement/revocation/concurrency/rollback acceptance, and the
remaining parent decisions on Report archive/deletion/tombstones, restoration and
unreconstructable legacy recipes. Finance runtime/schema implementation has not
started; no new grant, production data cleanup, merge or deployment is authorized.


Capture avoids a complete ciphertext RETURNING response: the insertion returns
small immutable headers, and the same real transaction checks server SHA256 of
the stored ciphertext against the issuer's exact encrypted original, plus every
submitted header. A substitution rejects and rolls back before model admission.
Private custody still retains complete original native cells/pages and original
ciphertext. Knowledge receives frozen table/PK/content descriptors and original
fingerprint/proof, without full native/cipher clones. Trusted driver hooks are
receiver-independent closures and are retained separately from its row container.
Native header hashing streams bounded strings with exactly the prior canonical
JSON bytes, including escaped text and UTF16 surrogate boundaries; existing
receipt fingerprints remain compatible. No schema or public port changed.

Bounded ciphertext transport followup adds `SqlNativeCapturePart` in migration
`20261014030000_sql_native_cipher_staging` (187). At most two512KiB encrypted
parts cross each worker query; they have workspace custody and no lineage/read
authority. The same native-capture transaction verifies complete ordered part
count, inserts the entire original using server string_agg, verifies complete
cipher SHA/all original headers, and removes only that transaction's parts.
Any incomplete, substituted or failed part rolls back; no receipt or model is
admitted. One synchronous trusted rendering/V8 snapshot and private decode
replace duplicate full native cloning. Issuer checks current owner/policy again
after the capture transaction before minting the private receipt. Source/native
epochs, original vectors, permanent tombstones, all caps and public ports stay
unchanged; originals are never discarded. Actual1GiB evidence is recorded above.

The prior1e3 checkpoint reached the first500-vector batch but still exceeded the
same1GiB complete-process guard (peak1,091,698,688B; capture917,766,144B;
startup423,444,480B). Its thirteen actual connector process/cold-reader/race and
denial/restore cases pass, including non-UTC count1. Those functional results do
not establish capacity. Migration187 removes large native-engine ciphertext
parameters; its actual full-vector/process resource rerun remains mandatory.

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
`20261014020000_sql_bounded_staging` and
`20261014030000_sql_native_cipher_staging` are additive. Claim/attempt/native/publication
tombstones have workspace custody, deliberately no source/log cascade that could
revive an old source generation. Existing source policy defaults are workspace
GENERAL and do not rewrite private records. No legacy chunk becomes eligible
without complete authenticated lineage. Fresh replay of all185 migrations on an
owned disposable local database passed. Tenant purge inventory includes all new
workspace custody models. Migration186 permits only the complete PREPARING-to-
PREPARED transition to seal the streamed hash; existing sealed receipts remain
immutable. It passed on the same disposable DB after the fresh185 replay.
Migration187 passed on that owned disposable database; its non-serving transport
model is included in the existing explicit tenant custody inventory. No production
migration or data change was performed.
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
bounded 128-vector batches; actual worker1Gi resource acceptance remains open
until the connector reruns the composed production path (later evidence above).

Actual connector composition at7c92532b proved a remaining resource failure:
unchanged4000 rows/12000 chunks with1536-vector models, a512MiB V8 heap cap and
complete-process1GiB RSS guard fails BEFORE the first model call. Native wire
length15,156,145B, encrypted stored length26,944,314B; production worker startup
peak454,901,760B, child startup420,675,584B, capture-phase peak1,079,508,992B.
The capture/header copy correction above is therefore required; its actual
complete-worker budget acceptance is still a connector-owned gate, not inferred
from local small-vector correctness tests.

The actual connector also reproduced positive count0 with successful fetch,
search and downstream proof: its application PostgreSQL session uses
America/Los_Angeles while KnowledgeChunk.createdAt is timestamp WITHOUT time
zone. Count now compares the original staged ISO instant AT TIME ZONE UTC to
Prisma's stored UTC timestamp, retaining complete JSON/vector/epoch predicates.
Real non-UTC application-PG regression uses1536-dimensional vectors. Exact-head
CI38504483543 failed at the default4GiB TypeScript heap BEFORE tests; local8GiB
compile passes with4,082,802K reported type memory. Hosted compile capacity is a
separate unresolved gate; no worker/CI resource settings changed here.

Corrected capture/count aggregate:47/47 real application-PG regressions pass,
including the full10000-row run, complete4000-row/12000-chunk publication/count,
non-UTC staged timestamp admission with1536-dimensional vectors, and SAME-TX
issuer rollback for cipher/header INSERT substitutions. Four deterministic
fingerprint/rendering units pass. Final repository TypeScript, affected ESLint
and diff checks pass; independent Sol found no bounded authority/hash/custody
blocker and confirmed actual connector hooks are receiver independent. Evidence:
`/tmp/pun68-capture-corrected-aggregate-result.json`,
`/tmp/pun68-capture-corrected-aggregate-pg.log`,
`/tmp/pun68-count-timezone-before.log` (red reproduction),
`/tmp/pun68-count-timezone-after.log`,
`/tmp/pun68-capture-bounded-fingerprint-unit.log`,
`/tmp/pun68-capture-corrected-types.log`,
`/tmp/pun68-capture-corrected-lint-final.log`.

Part-transport validation:50/50 real application-PG aggregate tests pass,
including full10000-row and complete4000-row/12000-chunk publication/count with
unchanged60s test budgets. Additional post-capture owner-loss and partial-part
failure/corruption/fresh retry checks pass3/3 on the final issuer;8 focused custody
PG checks and9 custody/hash/renderer units pass. Full repository TypeScript with
8GiB test heap, affected ESLint/diff and independent Sol review pass. Originals
remain stored on post-commit owner loss, but no receipt/model is admitted.
Evidence: `/tmp/pun68-cipher-parts-migration187.log`,
`/tmp/pun68-cipher-parts-aggregate-result.json`,
`/tmp/pun68-cipher-parts-aggregate-pg.log`,
`/tmp/pun68-cipher-parts-owner-final-pg.log`,
`/tmp/pun68-cipher-parts-unit-final2.log`,
`/tmp/pun68-cipher-parts-types-final.log`,
`/tmp/pun68-cipher-parts-lint-final.log`.

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

Authenticated Recall intake has the bounded checkpoint above. Generic agent
consumption, broader producer/category/audience/role-circle consent integration,
Finance immutable restatement revisions, lifecycle/regeneration, legacy/backfill/
rollback and integrated Astra QA remain full PR1517 blockers.
Do not merge/deploy or describe this checkpoint as the complete permission fix.
