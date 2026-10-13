# PUN-68 implementing checkpoint

This draft extends c9ffa7d35ead059bf5cd50e93780e8768c62650e and composes main
8e484c4216b8217879ac64aa46042b32fe715501 (PUN76 guards and PUN78 sensitivity fix). Full acceptance
is INCOMPLETE. Keep PR1517 draft; do not merge or deploy.

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
- Mixed Box/MCP publication uses one sealed, single-use capability and both safe
  adapters on the same complete roots/actor/workspace/transaction. Raw scope runners
  are private. Local epoch revocation is checked before SDK replay. Empty connection
  sets use their local captured policy epoch; unsupported Slack-native publication
  is withheld before provider replay until it has a safe commit adapter.
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
2. Two native Action PG public-reader assertions remain RED. The whole private
   MCP submission currently becomes an ancestor of the changed Action, hiding its
   body from another member. Existing Action body/status must retain its prior
   lineage while only the note and its derivatives use a separate audience proof.
   Dropping the input ancestor or broadening private note access is not a fix.
3. Bloop's actual canonical Brain admission/checkpoint saver/run/job/approval,
   publication receipt and finalization composition remains UNVERIFIED. Source
   helpers and mock provider dispatch do not establish canonical lifecycle acceptance.
4. Private graph native edit/review/publication and requester attribution remain
   incomplete. A regenerated approved fact currently requires a fresh proposed bundle;
   review inheritance is a pending product choice.
5. Delegated provider user authority for bare credentials, mixed CRM archive body
   projection, and Slack-native generic commit support remain incomplete. The mixed
   Box/MCP adapter and actual CRM atomic confirmation are now separately proved;
   neither proves canonical Brain lifecycle acceptance. Unsupported recipes are held.
6. Independent GPT-6.1 Sol xhigh review found raw runner, empty-set dispatcher,
   unsupported Slack replay, fresh-original creation-vector overreach, canonical
   Meeting identity and indexed-source/epoch lock ordering issues. Their corrections
   have focused evidence above. It retains Action/Recall/Bloop/CRM archive gates.
   Exact-head CI remains a gate. Running Finance content visibility now has synthetic
   evidence; that does not establish report regeneration or canonical Brain lifecycle.
   No ready/complete/ship claim is made.

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

## Pending completion-note question for the parent to present

Exact question: “When MCP completes an already public Action, who should be able to
read the newly submitted completion note?”

Options:
- “Only the submitting principal” (recommended conservative default until sharing is
  explicit): retain existing Action body/status visibility; show the note only to its
  authenticated owner and restrict all derivatives that consume it.
- “All current Action readers”: record this explicit command as authority to share
  only the newly submitted note with members currently permitted to read the Action.
  Do not widen any earlier private sources or the raw MCP request.

This choice is still unresolved. The implementation needs independent native
body/status and note projections either way. Preserving the public Action while
withholding the private note is feasible; it has not yet been implemented or proved.
Other pending choices cover Box audience, private prompt contribution publishing,
uploaded/automatic transcripts, and graph reapproval.
