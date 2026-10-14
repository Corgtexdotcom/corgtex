# PUN-68 implementing checkpoint

This draft extends c9ffa7d35ead059bf5cd50e93780e8768c62650e and composes main
8e484c4216b8217879ac64aa46042b32fe715501 (PUN76 guards and PUN78 sensitivity fix). Full acceptance
is INCOMPLETE. Keep PR1517 draft; do not merge or deploy.

## October13 source commit and standing-note checkpoint

### Next repair checkpoint after020a8997

Published repair1a844d52f80a45454d6b046ad75318d6c831b8a8 exact-head
[CI38471741937](https://github.com/Corgtexdotcom/corgtex/actions/runs/38471741937)
finished with12323pass/7fail/2skip, one failed file and755passed files. All earlier
non-Recall repair groups pass. Remaining seven cases are authenticated recorder
intake, recovery/duplicates/late callbacks and transaction rollback; no CI rerun
can replace actual native receipt integration. Build/schema/policy/scans pass.

The additive fence/type prerequisite9bfe757d is independently reviewed by
GPT-6.1 Sol xhigh. Affected units172/172 and final pure/alias8/8 pass; domain
types/scoped lint exit0. Actual mixed native publication passed; final-fence
rollback passed after its expected error was updated to the deliberately distinct
ARTIFACT_INPUT_WRITE_FENCE_LOST (Request/Result/audit/original snapshot assertions
remain unchanged). The compatible alias shares one storage; prerequisite
types/registration are dependency-only, no durable SQL runtime. The Finance
historical actual trigger/full saved-row rollback probe passes1/1 in55510ms;
successful restatement remains missing. Current runtime/schema ownership and
company policy contracts are in `pun68-pun85-shared-contract.md` and
`pun68-policy-integration-contract.md`. Local batch Astra connector worker owns
orchestration/tests; PUN68 owns additive shared schema. PR1523 has no schema edits.

Published020a89977ca19bc90a4f8a023793e5672f5912e9 exact-head CI
[38460491798](https://github.com/Corgtexdotcom/corgtex/actions/runs/38460491798)
finished red:12266pass/14fail/2skip and one import-suite failure. Build,
DatabaseSync/seed/schema, lint/types, docs/policy and scans passed. Failure groups:
Recall7 genuine authenticated intake/audience gaps; Brain2 actual missing newborn
history-Version epoch defects; Finance1 historical snapshot coverage defect;
Build2, frozen CRM1 and Meeting context1 faithful fixture repairs; and a local-only
database guard that rejected the verified Actions database before importing tests.

The next bounded checkpoint fixes those non-Recall groups. Its final composed
units pass314/314 across15 files, domain types and changed-file lint pass.
Actual PostgreSQL: existing Brain/digest8/8, new history constructor4/4, retained
Execution7/7, affected source-plan3/3 and expired-source-context1/1. Cohorts
overlap earlier evidence and are not full acceptance. Independent GPT-6 Sol xhigh
review cleared the bounded history constructor, historical coverage and epoch
read-pass/lifetime corrections. Required exact-new-head CI remains outstanding.

The trusted history constructor creates the Version itself and consumes a private
one-shot birth receipt bound to exact transaction/workspace/source/output hashes.
It keeps every original source epoch unchanged and adds only the newborn Version
own epoch. Original history remains valid under its saved envelope; stale or
unproved derived history is preserved as UNKNOWN. No existing Version can be
promoted by an `isNew` flag or refreshed old permission vector.

Historical coverage now walks hash-bound immutable snapshot preimages, preserving
their original parent/governor identities instead of borrowing mutable later Fact
metadata. This fixes the unit regression, but REAL Finance restatement remains
open: its Fact parent-binding trigger advances the Fact own epoch, so the earlier
immutable Fact snapshot still correctly fails current proof. A trusted immutable
Fact revision or independently authenticated original-value recipe is required;
restamping the historical epoch or dropping the source is forbidden.

Bounded proof passes batch fresh covered epoch observations at entry/exit and
still validate every original vector and referenced newborn key. Expired inherited
source contexts now deny before standalone fallback. In one synthetic mixed
Execution sample, preparation operations fell1367→1044 and publication2236→2008;
elapsed times worsened1403→2632ms and2474→7833ms. These are Prisma operation
counts, not SQL statement counts; lock metrics are lower bounds. Query fanout,
actual lock duration, latency and scaling acceptance remain open.

Bloop retains PUN85 as well as PUN94/95. The published Knowledge fence callbacks
are available, but durable source-run generation and EXTERNAL_DATABASE native
authority remain unimplemented. Bloop must propose narrow shared Knowledge hunks
and claim persistence before edits; PUN68 source-authority files remain reserved.
The release task and all production resources remain untouched.

This candidate extends published aef530642100e8e41dc555517fef193316e3d2bb.
The bounded architecture/ownership contract is [source commit contract](pun68-source-commit-contract.md).
It implements complete discovered source/governor/predicate locks, original
semantic fingerprints, separately tagged current ambient/structural fences,
preallocated immutable snapshots, actual retained Execution ownership, and the
explicitly approved standing public Action note. Internal read/output registration
cannot be restored from JSON or borrowed from a permission-only governor.

Current composed focused units: 477/477 across19 files. Domain types, scoped
owner lint, public docs and private boundary checks passed. Source foundation:
58/58 units and21/21 actual PostgreSQL. Execution:69 focused units,6 actual PG,
then2 affected PG positives under the final semantic guard. Action:34 units,
13 actual PG, and2 earlier standing-note capture cases. Final shared mixed/Action
PG passed48/48 across2 files, with type/lint/diff checks clean. The final
post-review client-compatibility/semantic gate units passed191/191. Independent GPT-6 Sol
xhigh reviews cleared these bounded corrections after concrete repros/fixes;
that clearance does not mean global acceptance.

At aef5306 exact-head CI38440156622 finished red:12122pass/13fail/2skip.
The unpublished corrections address its Action2 and Brain4 failure groups;
Recall7 remains a genuine intake/audience gate. New exact-head CI is required.
Legacy writer ordering/owner migration, canonical Bloop lifecycle/HTTP, native
audience/intake and private graph review/regeneration, archived DERIVED CRM
partition, backfill/rollback and latency/concurrency remain open. Request/Result
transactions still perform thousands of Prisma operations on synthetic mixtures.

Bloop retains conversation.ts/tests, its held PR1523 patch and the single
docs/architecture.mdx PUN46 correction. PUN72 createActionAction and PUN85
connector-local cursor work remain reserved as coordinated. This checkout has
not touched their release branch, browser, Azure CLI, lease, runtime or patch.

## October13 current read-boundary correction

Hosted CI at67e1b956849ef8d15dc26cf2f8e75ee83f84ad60 finished FAILURE
(run38421210772):12059 tests passed,22 failed,2 skipped; one additional suite
failed during import. Build, DatabaseSync/seed, schema, scans, policy, lint and
type checks passed. Seven Recall and two Action failures remain product gates.
Thirteen test failures and the import failure prompted faithful fixture repairs
and actual Brain/native-caller corrections; these are not aggregate acceptance.

The primary read APIs now complete local admission of the entire closure before
native replay. They recheck the current local permission closure after awaited
native work, using a fresh memo, and bind admission/replay/final admission to the
same exact manifest heads. A same-body new manifest cannot introduce an unplayed
native contributor during replay. List collectors receive only surviving allowed
rows. Restricted source queries never reach the provider as a side effect of
checking an otherwise inaccessible derived entry.

Optional physical caller hooks run outside native authority, before full proof
checks. The exact opaque Slack claim reserves its native/governing rows once;
mixed wrappers cannot first lock earlier rows after epoch acquisition. The ambient
physical helper grants no read capability and captures no epochs. These changes
do not yet establish the complete global writer/target union.

Independent GPT-6.1 Sol xhigh cleared this bounded root slice after reproducing
and verifying the pre-replay scope, mid-replay permission and same-body manifest
races. Focused units195/195 and exact final PostgreSQL28/28 pass; full domain
typecheck and scoped lint exit0. Route/CRM import fixtures72/72,
graph fixtures75/75 and Brain-maintenance/outbox fixtures35/35 pass without
relaxing source permission negatives.

Bloop's default-off foundation is published in draft PR1523 at
9050c76d7794c74cd68253965e73083cda0e0801, verified tree
514d9f4cb97531bf8b879e448bacb7cdc1115122. The earlier publication hold is no
longer current. Its actual SQL saver/lifecycle/admission/approval/worker composition
remains deferred and unproved. The shared source-plan API and ownership are in
the integration contract. Its new foundation has34 focused units and10 actual
PostgreSQL passes, but current writer/head/coverage migration and structural target
receipts remain under implementation; those results are not complete acceptance.

Independent caller review also found an overlapping same-key ExecutionResult
reconciliation gap and a variant candidate whose new native contributor was not
preflighted. Both owners are correcting them before those deltas are published.
Mixed execution currently costs1969ms/1118 Prisma operations in preparation and
6088ms/2215 operations in publication in the disposable fixture. Increasing its
transaction timeout to120s establishes correctness evidence only; reducing this
lock duration and proving the complete composed writer remain required work.

## Architecture and migration/backfill

- Record complete actual input lineage independently of citations, including saved
  row content hashes, immutable historical snapshots and transitive permission
  parents for Articles, graph objects/edges/evidence/proposals and copied content.
- Current membership, source permissions, Finance policies, credential scope and
  version, source envelopes, and durable permission epochs gate content, counts,
  ranks, paths, context, cached output, search and MCP reads. Publication rechecks
  exact inputs and current authority within its caller transaction.
- Preserve originals. Regenerate separate member-specific Article variants from
  independently permitted sources, as explicitly selected by the user. Removing
  one of several sources rebuilds from those left. Standalone originals remain valid.
- Unknown legacy lineage and old v1/v2 epoch proofs remain stored and withheld.
  Rebuild only with a verified producer recipe, current requester and actual inputs;
  never infer completeness from citations or stamp current epochs onto old content.
- Additive migrations through 20261013230000_external_mcp_response_inputs (183)
  were developed and applied only to synthetic local PostgreSQL on port55468.
  Fresh replay of all183 migrations succeeded and has zero Prisma schema difference.
  Migration176 checksum remains
  bb0d420ff522689e1af059cadacaec0d42a1a439159e52dec126d70c3ace97ef.
- 181 persists MCP OAuth consent epochs across revocation/restoration/recreation.
  182 adds body-free native source-removal outcome controls. 183 records complete
  immutable Box/Notion MCP response inputs and absence-sensitive connection-set epochs.
- Backfills must retain unknown entries until authenticated recipes rebuild them.
  No automatic production backfill dispatch or production DDL is authorized here.
  Rollback must retain these read gates or disable affected serving; reverting to
  an unprotected reader must not resurrect restricted cached or historical content.

## Implemented corrections in this checkpoint

- Knowledge indexing now uses distinct safe commit capabilities for freezing
  inputs and publishing chunks; provider/embedding work stays outside both SQL
  transactions. Worker ownership precedes direct local source-row locks and source
  epoch locks. Exact native provider byte drift preserves older committed rows;
  local archive races commit without row/epoch deadlock and withhold old chunks.
- A fresh independent HUMAN_ORIGINAL with exactly empty inputs/roots may regenerate
  using its current captured permissions after restore. Its creation vector is not
  a consumed generation. Old snapshots, DERIVED and native-control vectors stay
  mandatory; missing captures and malformed ancestry remain held. Meeting transcript
  and agenda captures use their canonical Meeting governor. No stored vector is reset.
- Actual CRM confirmation now commits the effect, complete producer lineage,
  applicable audit and canonical EXECUTED result on one exact caller transaction.
  Its independently guarded three-tool route retains PUN76 authorization and both
  prepared and confirmation native inputs; it avoids nested generic collector writes.
  Owner locks precede source/native locks. A wrong transaction rolls back the effect.
  Success and failure finalizers serialize on the same exact owner/lease row; a
  post-commit source-read failure cannot overwrite EXECUTED with FAILED.
- Slack/Box/MCP publication uses one deeply immutable, single-use capability and
  safe adapters on the same complete roots/actor/workspace/transaction, including
  all provider mixtures. Complete local caller/scope admission and old permission
  vectors are checked before SDK replay. Native/governing rows lock before epochs;
  unbound and detached callback scopes cannot open provider connections. Empty
  connection sets retain their captured policy epoch. Derived-only native inputs
  recover only vectors from the exact latest DERIVED ancestor; no fresh capture
  repairs a revoked consumed generation.
- New HUMAN_ORIGINAL snapshots bind their exact consumed manifest ID/revision in
  the hashed access envelope. Unbound legacy same-hash history is held if an
  incomplete original candidate makes its ancestry ambiguous. A later valid
  original does not redeem an earlier malformed snapshot. Original reads and
  captures require literally empty declared inputs and roots.
- Archived CRM HUMAN_ORIGINAL bodies have a separate direct presentation receipt,
  using the exact latest strict original and current target/relationship/principal
  delivery fence. It never becomes model/copy/source authority, including nested
  read capture. Free-text archive metadata and unproved relation labels/counts are
  omitted. Ordinary contributors, predicates, counts and returned decorations
  retain complete source proof in one final fenced transaction. The native archive
  API serializes the exact result immediately after its delivery check, with no
  cache. Archived DERIVED body partition is still incomplete.
- Meeting RESOLVE for Action/Tension/Proposal freezes complete input history before
  changing its own consumed records. Preparation writes snapshots only; publication
  commits target, APPLIED Insight, applicable Flow/Policy lineage, audits and events
  together, with separate outside-TX preflights. Meeting locks precede Insight locks
  to match generation. A strict latest independent human-original Proposal can still
  be explicitly published by its draft manager; old private history stays held.
  Copied/model/MCP publication retains all old inputs and cannot use that distinction.
- addConversationTurn seals the exact actor and copies content/context/roots before
  its first await, retaining the exact supplied transaction separately. Bloop's
  canonical conversation lifecycle files remain untouched. The proposed Brain
  integration contract is in .codex/pun68-brain-integration-contract.md; current
  preflight does not attest an independent run/lease/connection, and a complete
  global lock plan plus typed checkpoint replay validation remain integration gates.
- Fresh synthetic demo initialization settles only its own exact unclaimed native
  event, in the still-open creation transaction before semantic data exists. All
  permission epochs remain stored and protective pre/postflight guards stay intact.
  Existing refreshes have no exemption and roll back when postflight rejects them.
- Integration configuration supplies a fixed synthetic encryption key so hosted
  fixtures do not require developer or production credentials.
- PUN76 operation guards precede trusted source wrappers. Immutable actor identity,
  submission, scopes and roots remain sealed before awaits. Metadata-only pending
  CRM permission checks precede reading full stored arguments or calling mutators.
- Source retirement is a single-use, current native archive-generation control
  capability. It exposes no archived body to models. Fresh retries use independently
  permitted remaining inputs. Linked documents may already be archived only with
  matching current native generation; shared documents remain active when required.
  Restore during model generation stales the candidate. Original payloads remain intact.
- Brain edit history copies only the prior manifest and original epoch vector.
  Archive envelope transitions preserve exact old ancestry without making restored
  stale derived content readable. Unknown history is never recertified.
- Document source rebuilds require the actual current typed Document and complete
  proof, current native requester/credential, pre/post-model checks, saved-row reread
  and final publication fence. Old private guidance is not passed into new variants.
- Chunk hashes are taken from full persisted SQL rows, including normalized JSONB
  and embedding/ranking fields. Variant signatures include captured permission epochs.
- Audit/timeline readers require current complete target and job source proofs
  before exposing IDs, counts or events. Only fixed structural event vocabularies
  survive; free-text metadata and unauthorized target existence are withheld.
- External MCP native receipts retain the full Box/Notion tool response before
  normalization and trimming, fixed tool/request, local principal and connection
  grant, and original pre-SDK local epochs. Empty searches retain the complete
  connection-set proof. Live replay is outside SQL transactions; supplied transaction
  publication needs an opaque single-use preflight. Provider error text is withheld.
  Actual chat/Brain saver composition is still a gate; helper success is not acceptance.

## Validation and remaining failures

All data is synthetic/disposable. No live provider calls, customer mutations,
credential/grant changes, production migrations, purges, releases or deployments.
The separate release task's branch/browser/Azure CLI/lease/runtime were untouched.

| Check | Latest result | Local evidence |
| --- | --- | --- |
| Aggregate unit, after fixture and asset repairs | 11459 pass, 7 fail, 24 skipped; 681 passing files | /tmp/pun68-current-final-aggregate-unit.log |
| Full repository TypeScript | pass | /tmp/pun68-current-final-types.log |
| PUN78 sensitivity/chunks/ranking/cache composition | 80/80 pass | /tmp/pun68-pun78-composition-unit.log |
| Public docs and private boundary | pass | /tmp/pun68-current-public-docs.log; /tmp/pun68-current-private-boundary.log |
| Root changed-file lint and diff | pass | /tmp/pun68-root-final-lint.log |
| Remaining static/script/native-dispatch cohort | 549/549 pass | /tmp/pun68-materialized-static-native-cohort.log |
| Lifecycle/route/archive fixtures | 267 pass, one old registry count then repaired | /tmp/pun68-archive-inventory-fixtures-final-unit.log |
| Final schema inventory | 11/11 pass | /tmp/pun68-schema-inventory-final-unit.log |
| Linked Document retirement/restore races | 3/3 local PG pass | /tmp/pun68-linked-document-retirement-new-integration.log |
| Document rebuild/removal cohorts | 29/29 local PG, 4 unit pass | /tmp/pun68-document-source-rebuild-final-integration.log |
| Native external MCP receipt | 29 unit, final3/3 local PG pass | /tmp/pun68-external-mcp-response-final-integration.log |
| OAuth epochs and workspace/pending CRM | current unit coverage included in aggregate; 20/20 local PG pass | /tmp/pun68-oauth-current-checkpoint-integration.log |
| Source history/archive/native control | 72/72 units pass | /tmp/pun68-linked-removal-control-unit.log |
| Native Action completion | 31 units, 7/9 local PG pass; two public-reader tests RED | /tmp/pun68-action-completion-* |
| Fresh183 migrations/schema | all183 replayed, zero difference | /tmp/pun68-fresh183-migration-replay.log; /tmp/pun68-fresh183-migrations-schema-diff.log |
| Current correction unit cohort | 468/468 pass across11 files; includes dispatcher7/7 and real provenance15/15 | /tmp/pun68-current-delta-units.log |
| Native CRM atomicity/rollback/terminal races and registered MCP | 9/9 local PG pass; complete prepared/confirmation closure | /tmp/pun68-final-atomic-crm-native-integration.log |
| Mixed native providers, empty-search insertion revocation and private graph variants | 16/16 local PG pass | /tmp/pun68-native-provider-current-integration.log |
| Existing native Box variant cohort | 3/3 local PG pass | /tmp/pun68-native-mcp-complete-inputs-box-integration.log (MCP assertion subsequently corrected to inspect immutable closure) |
| Fresh seed lifecycle | 90 unit pass; actual seed retains521 epochs; existing refresh rolls back identical table/epoch hashes | /tmp/pun68-demo-seed-lifecycle-unit.log; /tmp/pun68-demo-seed-lifecycle-replay.log; /tmp/pun68-demo-seed-lifecycle-rollback.log |
| All three CRM native tools | 15/15 local PG pass: registered MCP activity/suggestion/completion, rollback, applicable audit and finalizer races | /tmp/pun68-crm-all-three-native-final-integration.log |
| Knowledge and fresh-original restoration | 74/74 units pass; rejects old snapshots/derived vectors/missing captures/malformed original inputs, permits fresh originals and Meeting aliases | /tmp/pun68-original-restore-knowledge-final-unit.log |
| Actual Box-to-KnowledgeChunk caller | 2/2 local PG pass: complete owner-only receipt, no provider SDK in TX, post-embed drift preserves old chunks | /tmp/pun68-knowledge-box-caller-final-pg.log |
| Local Document privacy/write race | 1/1 local PG pass: observed row wait, no deadlock, prior chunks preserved and unreadable after archive | /tmp/pun68-knowledge-document-lock-pg.log |
| Retrieval mock composition after a4 hosted failures | 48/48 unit pass: real dispatcher in current-proof ranking fixture; exact single-use synthetic dispatcher in cache/gateway fixture | /tmp/pun68-a4-retrieval-ci-fixture-unit.log |
| Slack/Box/MCP commit and historical original review fixes | 16/16 local PG, 3/3 latest-manifest PG, 69/69 focused units; 101/101 broader lineage units | /tmp/pun68-slack-all-native-reviewed-final-pg.log; /tmp/pun68-native-latest-manifest-pg.log; /tmp/pun68-final-original-history-unit.log |
| CRM direct original/native ordinary cohort | 11 PG cases passed initially; corrected invalid fixture enum and remaining native-provider case passed; final137/137 focused units | /tmp/pun68-crm-direct-pg.log; /tmp/pun68-crm-direct-native-pg.log; /tmp/pun68-crm-direct-cohort-unit.log |
| Actual CRM original/empty/unreadable-contact deal delivery | 22/22 actual-helper units, including listDeals plus canonical serializer, revoked membership and changed unreturned positive contact contributors | /tmp/pun68-crm-direct-cohort-unit.log |
| Meeting RESOLVE complete closure and atomic publication | 294/294 units, 18/18 PG: three targets, uncited private ancestor, self-target mutation, Flow/Policy DAG, canonical writer rollback, restore race, generation concurrency and strict human-original publishing | /tmp/pun68-meeting-resolve-unit.log; /tmp/pun68-meeting-resolve-pg.log |
| Conversation turn immutable caller submission | 42/42 conversation/input units; exact actor/TX/content/context/roots survive attempted caller mutation | /tmp/pun68-turn-immutable-unit.log |
| Running Finance visibility at503dd0e0 | two synthetic contributors each see1 permitted import; member revoke API403/UI markers withheld; restore API200/0 old imports | .artifacts/pun68-finance-ui/README.md and screenshots/result JSON (ignored local evidence; font fixture, no provider/model call) |

Focused cohorts overlap and ran on successive local revisions. Do not add their
counts or claim them as a single final acceptance run. Missing tracked test assets
were restored from exact Git index blobs. Site next-intl4.12.0 was restored only to
this checkout's ignored node_modules; manifests and package-lock were unchanged. Sparse checkout is now disabled only in
this isolated repository so future merges retain tracked validation assets.

### Genuine behavior/integration gaps

1. All seven aggregate failures are Recall recorder intake/recovery success paths
   in meeting-recorders.test.ts. Calls currently lack immutable authenticated
   provider input, live recording/lease/grant proof and an approved audience. They
   are denied with UNKNOWN_LINEAGE before model/writer use. These are product gaps,
   not stale fixtures to relax. Automatic/historical recordings have no human owner.
2. The Action-note audience decision is resolved and its current partition passes
   34 unit and 13 PostgreSQL cases. A separate standing public note preserves the
   exact old Action ancestry; private raw MCP integrity evidence is not a public
   input or editor grant. Reopen, former-assignee departure, current read families,
   incomplete old vectors and revocation/restore have regression coverage. Current
   central nested-provider fences and derivative composition remain separately
   recorded acceptance evidence; these results do not close the global writer gate.
3. Bloop's actual canonical Brain admission/checkpoint saver/run/job/approval,
   publication receipt and finalization composition remains UNVERIFIED. Source
   helpers and mock provider dispatch do not establish canonical lifecycle acceptance.
4. Private graph native edit/review/publication and requester attribution remain
   incomplete. A regenerated approved fact currently requires a fresh proposed bundle;
   review inheritance is a pending product choice.
5. Delegated provider user authority for bare credentials and archived DERIVED CRM
   body partition remain incomplete. Strict original-only direct CRM presentation
   and Slack/Box/MCP safe scopes are now separately proved; neither proves canonical
   Brain lifecycle acceptance. Unsupported recipes are held.
6. Independent GPT-6.1 Sol xhigh review found raw runner, empty-set dispatcher,
   unsupported Slack replay, fresh-original creation-vector overreach, canonical
   Meeting identity and indexed-source/epoch lock ordering issues. Their corrections
   have focused evidence above. It retains Action/Recall/Bloop/CRM archive gates.
   Exact-head CI remains a gate. Running Finance content visibility now has synthetic
   evidence; that does not establish report regeneration or canonical Brain lifecycle.
   No ready/complete/ship claim is made.

### Hosted CI ata4be4f9b

Run38404855677 finished FAILURE:11996 passed/18 failed/2 skipped;735 passing
files/5 failing/1 skipped. Build, DatabaseSync (including fresh seed), docs/policy,
scans, lint/typecheck and migration/schema checks passed. The four Box knowledge
writer failures from503 are resolved. Failures are7 genuine Recall gaps,2 Action
public-reader gaps,1 archived CRM body-view gap, and8 retrieval test cases whose
domain mocks lacked the newly integrated preflight exports. The retrieval fixtures
are corrected with distinct transaction clients and48 passing units; the ranking
fixture uses the real dispatcher and actual source helpers. The cache/gateway mock
does not establish native source authority. A subsequent push needs exact-head CI.

### Hosted CI at503dd0e0

Run38398138310 finished FAILURE:11982 passed/14 failed/2 skipped;735 passing
files/4 failing/1 skipped. Build, DatabaseSync (including fresh seed), docs/policy,
scans, lint/typecheck and migration/schema checks passed. Failures were7 genuine
Recall gaps,2 Action public-reader gaps,1 archived CRM body-view gap, plus4 actual
Box knowledge writer composition regressions introduced by the stricter supplied-TX
provider scope. The latter are corrected and have actual caller PG evidence above;
they were not dismissed as stale fixtures. Next head must run its own exact-head CI.

### Hosted CI at prior published682c8da3

Run38387829094 failed. Build, policy/docs/secret/data scans and migration/schema
checks passed. DatabaseSync failed the fresh seed fixture postflight; that cause
is addressed by the strict native initialization transaction above. LTT had11908
passes and29 failures:7 genuine Recall gaps;19 missing synthetic ENCRYPTION_KEY
failures;2 stale Brain/digest archive fixtures corrected without source-policy
relaxation;1 real archived CRM body-view regression. The missing crypto also masked
the2 Action public-reader failures, which remain outstanding. Next published head
must be checked independently; this prior run is not current-head acceptance.

### Repaired stale fixtures/environment issues

The earlier aggregate had11316 passes/78 failures. Credential hashes/current grants,
real OAuth epochs/native request receipts, distinct TX client identity, full saved
ranking/chunk rows, route capability inventory and schema ownership registry fixtures
were corrected without weakening private-source or revocation assertions. All those
unit failures now pass. Missing public test docs and pinned TLS fixtures caused static
script failures and were materialized from Git; no live migration runner was executed.

## Completion-note audience decision — resolved October13

Jan selected public visibility to current Action readers at18:09:43 UTC:
“Note needs to be public.” This authorizes a separately typed publication of only
the new completion note, preserving the existing Action/body/status audience.
It does not publish raw MCP requests, unrelated private chat or earlier private
sources. Security owns the Action completion files; root owns the central lineage
dispatch and coordinated source authority registration. Implementation and actual
PostgreSQL validation passed for the bounded Action partition. The full source
approach remains incomplete; see the source commit contract and current evidence.

The implementation uses independent native body/status and note projections.
Private caller acknowledgment remains separate from the standing public note
projection. Old copied/unknown Action body ancestry must stay restricted.
Other pending choices cover Box audience, private prompt contribution publishing,
uploaded/automatic transcripts, and graph reapproval.
