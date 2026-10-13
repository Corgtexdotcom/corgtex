# PUN-68 implementing checkpoint

This draft contains implementing code after published head0c00c554.
Full acceptance is INCOMPLETE; keep PR1517 draft.
All database operations used synthetic local PostgreSQL on port55468. No production
migration, deployment, customer mutation, credential/grant change or purge occurred.

## Architecture and migration/backfill

- Full actual-input saved-row hashes, immutable snapshots and transitive manifests
  capture every source independently of citations. Preserve originals.
- Current membership, credential scope/version, artifact envelopes, Finance policies
  and every contributing source gate content, counts, ranking, traversal, evidence,
  proposals, model context, cached results and copied writes.
- Capture durable permission epochs before generation; save exact vectors in proofs
  and snapshots, recheck current grants and epochs in publication transactions.
  Triggers retain tombstones across restoration/deletion/recreation. Receipt merges
  preserve captured permission revisions and reject conflicts.
- Separate permitted-source Article variants and private graph bundles regenerate
  from independently permitted originals, excluding old restricted semantic content.
- Unknown legacy lineage/epoch proofs remain stored and withheld. Never fill an old
  proof with current counters or infer complete input lineage from citations.
  Rebuild only through verified producer recipes.
- Additive migrations through20261013150000_brain_source_document_governor were
  applied only locally. v3 includes typed permission parents and foreign CRM
  access proxies; old v1/v2 vectors remain withheld. The additive index correction
  was checked against both a fresh replay and the existing local catalog. Brain
  source metadata changes revoke inputs when documentId changes, while content
  hashes and extraction progress remain protected by full-row fingerprints.
  Provider progress is a content revision; archive and stable
  principal/source binding changes advance permission epochs.
- Production rollout requires authorization and availability/backfill planning.
  Rollback must retain permission enforcement or disable affected serving; an older
  unprotected reader must not reactivate restricted content.

## Evidence and limits

Focused cohorts ran on successive local revisions, not one final acceptance head:
chat transaction/pending/memory38 units; conversation fixtures290; conversation DB6;
Slack153; native transcript/audio40 +DB1; Finance concurrencyDB5; epoch triggersDB12;
graph variants29 +DB8; graph auto reads/retirement139; chunks177; execution/outbox100;
residual jobs/run/audit40. Counts overlap and must not be added together.
Additional verified corrections: historical targets require structurally valid epoch
proofs; v2 covers communication, role, Advice, Build and Finance governors; CRM uses
the caller transaction for nested membership; pending CRM locks its exact authority
row before execution; MCP uses its real conversation session key; Box sync uses an
opaque preflight outside the copy transaction. Caller-owned Brain publication is
available through ingestConversationOnDemandInTransaction.

Focused additional evidence:175 legacy/producer tests;102 Box authority tests;35
conversation/pending units;27 epoch/governor DB tests;10 publication transaction DB
tests;3 pending lock DB tests;1 actual registered MCP DB test;6 durable rebuild
event DB tests (coalescing, rollback and feedback-loop prevention). Canonical publication
saver proof remains unverified. Counts overlap and are not aggregate acceptance.

Current typecheck, schema validation, public-docs and private-boundary checks passed
on local revisions. Logs are in /tmp/pun68-* and are not committed production proof.

The first full repo unit run completed with424 failures/10117 passes and15 environment
errors. Many lineage fixtures have since been repaired; sandbox socket/process/file
errors also affected unrelated scripts. A green aggregate, exact-head CI and final
independent review are NOT claimed.

## Prior remote findings

Remote synthetic checks at71c31c98 passed58/61 assertions with zero harness errors.
The remaining MCP session, nested CRM membership and authority-row-lock findings
have local fixes and regression evidence in this checkpoint; remote repin is pending.
Independent Sol review retracted its epoch-sort finding and identified real legacy,
governor, rebuild, lifecycle and provider-transaction gaps. Legacy/governor and Box
sync corrections are present; remaining integration/provider gaps stay open.
Implementing changes include supplied-tx membership/Finance reads; exact prompt and
native human/agent MCP ingress; original proposal principal/arguments/input roots;
pending execution fences and uncertainty blocking repeat effects; fifth-turn memory
inside caller ownership fences; and epochs preventing local revoke/restore replay.
Helper tests do not establish Bloop's combined lifecycle.

## Open blockers

1. Compose Bloop's actual admission, checkpoint saver, run/job/approval, canonical
   effect/publication receipt and finalization transactions. Existing web streaming
   route still follows its earlier lifecycle; helper-only tests are insufficient.
2. Recall/provider/recorder intake needs immutable authenticated fetch inputs and
   live connection/recording/lease authority. Seven provider success tests stay red;
   the current intake denies unverified calls before model/writer use.
3. Native edit/review/publication of private graph bundles is incomplete. Canonical
   regeneration cannot invent requester authority from attribution. Graph reapproval
   and transcript/prompt/provider audience decisions remain pending.
4. Graph request/claim/publication/release now use opaque provider preflight outside
   interactive transactions. Box native proofs retain their original epoch vectors;
   byte drift and local revoke/restore deny replay. Ordinary reads retain live
   provider checks. Local epochs cannot detect an unobserved remote revoke/restore
   cycle; unsupported cross-provider commit adapters remain withheld.
5. Finish remaining fixtures, aggregate checks, running UI evidence for Finance
   visibility, independent GPT-6 Sol xhigh review and exact-head CI. Compose PUN76's
   independent operation guards while preserving PUN68's source receipts and fences.

Unsupported recipes are blocked capabilities, not complete backfills. A partial
filter is not the completed source-permission solution. Do not merge or deploy.

## Current checkpoint corrections and focused evidence

- Typed metadata-only permission-parent closure, RoleAssignment liveness and
  Role/Circle archive gates; public sharing rejects revoked BuildArtifact tokens
  and private decision parents. Provider and actor capabilities keep exact object
  identities; caller-owned Brain entry seals the authenticated actor before awaits.
- Archive lists and detail return only explicit structural metadata after current
  source admission. Purged/unknown entries are withheld; previousState, free-text
  labels and reasons never become read authority. Pagination follows admission.
  An exact known HUMAN_ORIGINAL can advance only allowlisted archive metadata,
  preserving its historical vectors. Copied/unknown rows cannot be recertified.
  Archive/restore responses expose only IDs; current transaction membership and
  actor authorization, immutable actor/submission and write fences guard effects.
- Graph provider cohort119 units,8 existing DB and3 new Box DB tests pass; actual
  provider transport was mocked, all Prisma receipts/epochs were real and the
  interactive-transaction transport counter stayed zero. SourceCore66 units pass
  including archive-metadata admission and ID-only mutation responses. Migration180 governor
  cohort16 DB passes, including metadata progress and document binding round trips.
- Brain absorption preserves existing articles and creates fresh explicitly public
  proposed drafts with complete frozen inputs and pre/post-model/publication gates.
  Producer cohort35 units passes;9/10 integration cases pass. The remaining
  Document indexing failure is traced to pre-persistence JSONB metadata hashing.
  Permission-parent/Goal concurrency cohort20 DB passes; fresh180 migration
  replay has zero schema difference.
- Latest published exact-head CI at0c00c554: Build, Docs, secret/data/policy gates
  passed; Database Sync failed on the corrected index spelling; combined test job
  failed30 files/108 tests, with11301 passes. Current fixture corrections are not
  yet exact-head aggregate acceptance. Earlier focused fixture cohorts: SourceCore
 66/66; seven CI integration files58/60; seven Brain integration files39/52.
  Subsequent code/fixture corrections require their affected reruns.
- Remaining production gaps include source-removal retry/document coordination,
  regenerated indexing, actual conversation saver/lifecycle integration, provider
  recorder authority, and linked mixed CRM archive body viewing. Ordinary model
  reads continue to reject archived content; a human actor alone does not establish
  a UI read purpose. No synthetic HUMAN_ORIGINAL fixture proves mixed production
  CRM rows (whose constructors record DERIVED) safe to expose in archive views.

Automatic/historical Recall recordings have no stored human owner. A product
audience decision is pending; credentials, bot IDs and signed wakeups cannot invent
a requester. Provider authority also needs a durable binding revision rather than
an environment hash that could return to an older value.
