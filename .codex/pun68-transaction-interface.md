# PUN-68 / conversation foundation transaction contract

## Publication status

**Implementation is LOCAL and UNPUBLISHED as of published code head
23cbd5b256288ab0e5fb1bc8d69b977e910b144c.** The documentation-only head
decd8ae52ec258165cd1131717dedc1ead4d6899 did not contain the implementations
or tests described below. Treat this document as a proposed integration contract,
not evidence that the published branch implements it. The owner is integrating
and testing the local cohort before publishing its implementing checkpoint.
Bloop's actual saver/route/worker lifecycle remains unverified.

## Locally implemented interface (not published evidence)

The optional caller transaction is implemented in createConversationPromptInput,
createConversationIngressInput, and addConversationTurn. Constructors capture the
original submission/principal before awaits and reject principal changes.
prepareConversationInputs validates and reuses server-supplied promptInputId or
ingressInputId after admission commit. It does not read uncommitted admission rows
through an independent connection.

LOCAL test evidence, absent from the published code: disposable PostgreSQL tests passed 5/5: native web/MCP input plus request/job
enqueue rollback; final turn/manifest plus generic job completion commit; failure
and mid-turn ownership-fence rollback. Unit transaction/terminal/provenance
boundaries passed 77 tests. This evidence does not cover Bloop's actual saver,
route/worker/recovery adapter or combined lifecycle.

Current PUN-68 write-fence API:
- ArtifactInputWriteFence = (tx: Prisma.TransactionClient) => Promise<void>
- withArtifactInputWriteFence(fence, work) propagates the trusted callback through in-process AsyncLocalStorage.
- assertArtifactInputWriteFence(tx) invokes it with the SAME interactive transaction supplied by the domain writer.
- captureImmutableArtifactInputProof(actor, workspaceId, completeRoots, tx), recordArtifactInputLineage({tx,...}), and addConversationTurn(actor,{tx,...}) use that caller transaction. addConversationTurn takes conversation advisory lock inside it.
- Pending CRM returns immutable ready operation/input roots plus executionFence(tx); compose the worker and pending fences and perform both inside each effect/result write transaction.

Checkpoint store requirements:
A stock Postgres saver on its own pg pool cannot join a Prisma interactive transaction. Implement put/putWrites SQL through tx.$executeRaw/tx.$queryRaw on the caller tx. The adapter must bind this exact tx and fail if a publication/admission/finalization checkpoint write has no bound tx. Do not start another transaction/pool connection or commit independently. Serialization/model execution happens before the bounded DB commit transaction. Gateway remains the sole usage/billing writer.

Atomic phases:
1) Admission: lock current owner/membership/conversation; exact native prompt + request/admission row + initial checkpoint + queue/outbox intent in one tx.
2) Approval: current approver authority + exact immutable approval/output/context/destination identities + approved-generation checkpoint + generation wakeup in one tx.
3) Publication: current worker/run/job/attempt/tenant/user/conversation/version/checkpoint lineage guard + exact approved immutable inputs + current complete source proof + Brain content/version + canonical unique publication receipt + outbox in one tx. UNKNOWN blocks replay; COMMITTED reconciles from canonical receipt and rechecks current sources.
4) Finalization: same ownership/checkpoint fence + exact final native prompt/assistant/context proof + final turn + job/run completion/checkpoint in one tx.

Lock order:
Use one reviewed order in all foundation transitions: tenant/conversation/run/job ownership authority first, then conversation sequencing/advisory key and operation/publication idempotency key, then archive/native artifact locks in stable kind/id order. PUN-68 readers revalidate under tx; current helper does NOT globally lock every ancestor or prescribe the run/job lock order. Any writer that takes source locks before a fence which locks job rows can deadlock against foundation order; it rolls back rather than serving unproved output but must be normalized/retried, not claimed globally solved. Snapshot/receipt writes invoke the fence within their tx. Do not hold DB transactions over model/provider calls.

Existing source readers must run after admission commit or use the same supplied
transaction. No provider/model network call belongs inside a bounded publication
transaction.

Smallest lifecycle/schema ownership split:
- Parent: schema/migration ordering, Workspace relations, tenant-purge model/DSL registration, deletion/restore/rollback coordination and migration validation; production DDL remains unauthorized.
- Bloop: conversation request/run/job/approval/checkpoint/effect/publication lifecycle and bound-tx checkpoint adapter; dedicated assistant-harness export and its route/worker/recovery files.
- PUN-68: source lineage/snapshot tables and helpers, native input/outcome definitions, actual model-input collector, Brain producer/read permissions and domain receipt/fence hooks. Agent index is released. CRM native job enqueue and Finance exact lease adapters are now wired in outbox; conversation lifecycle sections remain with Bloop/parent integration.

Current migrations through170 are developed and applied ONLY to the disposable
local database at 127.0.0.1:55468/corgtex_test. Added native rows include immutable
CrmQualificationFormInput, FinanceReportUploadInput and encrypted
ExternalProviderFetchInput. Parent retains schema/lifecycle integration ownership.
No production schema changes, deployment or live data mutation occurred.

## Product decision status

Answered: Create a separate permitted-source article variant.

Unanswered, exact wording:

1. For content imported through a person’s Box connection, should Corgtex keep it visible only to that person, or share it with workspace members who also have current access to the same Box item? I’ll verify current Box access on every read either way.
2. When publishing an article generated from a private chat prompt, should Corgtex keep that version private and generate a shared version from shared sources, or explicitly share the exact prompt contribution with the article?
3. Should a transcript or recording uploaded directly by a member be shared with the workspace, as the current Meeting upload flow implies, or stay private to the uploader? Any private sources used to generate it will still retain their own restrictions.
4. When changed source permissions require rebuilding an approved graph fact, should the rebuilt fact go through review again, or inherit its previous approval? I recommend review again because its evidence has changed.
