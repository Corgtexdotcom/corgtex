# PUN-68 / conversation foundation transaction contract

## Publication status

This document accompanies implementing code after71c31c98.
Earlier documentation-only headdecd8ae5 did not contain these APIs. The draft now
includes the transaction/native-input interfaces below. Their presence and focused
tests do not establish Bloop's actual saver/route/worker lifecycle, which remains
unverified and blocks full acceptance.

## Implementing checkpoint interface

The optional caller transaction is implemented in createConversationPromptInput,
createConversationIngressInput, and addConversationTurn. Constructors capture the
original submission/principal before awaits and reject principal changes.
prepareConversationInputs validates and reuses server-supplied promptInputId or
ingressInputId after admission commit. It does not read uncommitted admission rows
through an independent connection.

Disposable PostgreSQL tests pass10/10 for native admission/turn and caller-owned
Brain transaction commit/rollback, immutable submission, write failure and ownership
fence expiry. Three pending authority-lock tests and one actual registered MCP
confirmation test also pass. Unit conversation/pending tests pass35/35. These tests
do not cover Bloop's actual saver, canonical publication receipt or combined lifecycle.

Caller-owned Brain publication API:
- ingestConversationOnDemandInTransaction(tx, actor, submission) requires the supplied Prisma.TransactionClient and joins BrainSource, complete manifest, audit and outbox writes to it.
- Submission is ConversationBrainIngestParams: workspaceId, title, content, optional sourceType, lineageInputs and lineageRoots. Inputs are copied before the first await.
- Membership and write-fence callbacks use this same tx before and after writes.
- ingestConversationOnDemand(actor, {...submission, tx}) forwards to the same primitive; omitting tx retains the existing standalone transaction API.
- A canonical receipt written by Bloop in this transaction must remain its authoritative publication identity; synthetic marker tests prove atomicity only.

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

Current migrations through177 are developed and applied ONLY to the disposable
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
