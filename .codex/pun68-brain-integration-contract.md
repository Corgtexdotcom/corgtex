# PUN-68 / Bloop Brain continuation integration contract

## Pins and authority

This candidate extends published PUN-68 checkpoint
aef530642100e8e41dc555517fef193316e3d2bb in draft PR1517. The implemented
source composer, complete source lock union, semantic guards and allocation
contract are in [the bounded source commit contract](pun68-source-commit-contract.md).
That contract supersedes the earlier proposed source interfaces and ordering
below. No schema changes are included in this candidate. Pin the exact joint
code/schema head before tests; do not test a moving checkout.

Bloop's default-off foundation is published in draft PR1523 at
9050c76d7794c74cd68253965e73083cda0e0801. This isolated checkout fetched that
read-only reference and verified tree514d9f4cb97531bf8b879e448bacb7cdc1115122,
matching the reviewed8bbfa306 tree reported by the PR. Its subsequent patch
publication remains held by the parent for exact approval. This route does not
authorize that publication, merge, activation or deployment. The foundation explicitly
defers SQL saver, lifecycle schema, registered worker and actual composition.
Its earlier caller-tx review of0c00c554 is not current composition evidence.

## File and schema ownership

| Owner | Files / responsibility |
| --- | --- |
| PUN-68 | packages/domain/src/source-lineage.ts; source-permission-epochs.ts; source-permission-parents.ts; artifact-input-actor.ts; artifact-commit-preflight.ts and native Slack/Box/MCP authority adapters; conversation-lineage.ts; conversation-ingress.ts; conversations.ts; conversation-brain.ts. Complete source/read/model/publication proofs and native prompt/ingress/turn constructors. |
| PUN-68 | packages/agents/src/conversation-inputs.ts; conversation-lineage.ts; conversation-tool-lineage.ts and their provenance tests. Actual model-input collection; admitted native ID reuse; permission-safe history/context/tool output. |
| PUN-68 schema | ArtifactInputLineage, ArtifactInputSnapshot, SourcePermissionEpoch, ConversationPromptInput, ConversationIngressInput, native input/control tables through migration183. Existing migrations are immutable. No Bloop lifecycle columns are to be added by PUN-68 without coordination. |
| Bloop | packages/agents/src/conversation.ts and conversation.test.ts canonical Brain lifecycle sections, its held foundation files, and its dedicated assistant-harness export. Connection-bound saver, admission, queue intent, approval generations, canonical publication/finalization, recovery and claim fencing. |
| Bloop proposed new files | packages/agents/src/assistant-harness/postgres-checkpoint-port.ts; claims.ts; lifecycle.ts; lifecycle.integration.test.ts. checkpoint-store.ts remains the pinned SDK boundary. The dedicated assistant-harness subpath avoids packages/agents/src/index.ts; enqueueJob is injected without a new queue or agents-to-workflows dependency. These paths are reservations, not implemented composition evidence. |
| Bloop lifecycle schema | Durable checkpoint/channel-write records, immutable admission/generation/approval identities, canonical publication and finalization receipts. Bloop proposes exact models/unique keys and a migration; parent owns schema.prisma merge, Workspace/tenant-purge registration and the next migration number after183. Local replay only. |
| Coordinated shared files | prisma/schema.prisma, packages/agents/src/index.ts, packages/shared/src/env.ts, packages/workflows/src/outbox.ts, packages/agents/src/conversation.ts (PUN-68 already owns its published CRM source wrapper), apps/web/app/api/workspaces/[workspaceId]/conversations/[conversationId]/route.ts and native MCP conversation registration. Agree named hunks before editing. Bloop owns new Brain-specific route/worker dispatch hunks; no blanket file release. |

Proposed persisted checkpoint/write envelope v1 (Bloop maps to its held schema):
workspaceId; requestId; conversation/session identity; native prompt/ingress ID;
principal kind+ID+scopeHash+credentialVersion/consent epoch; runId; jobId;
attempt/lease generation; approval/output generation; checkpointId+parentId;
namespace; channel; serializer type/version; exact serialized payload bytes and
SHA-256; complete immutable consumed roots plus original permission vectors;
write taskId+write index for pending channel writes. Unique keys scope namespace,
checkpoint and task/write index to tenant/request/generation. Serialize and hash
before the bounded transaction; do not hash a differently normalized replay.

PUN-68 will add typed checkpoint/source validation only after Bloop supplies that
exact schema. Proposed continuation receipt validation must bind saved payload
hash/type/namespace/channel to exact principal/generation and current complete
proof before get/getTuple/list or pending-write replay returns context bytes to
the model. Listing IDs/counts also needs current access. A withheld body cannot
become a pending-write result or collector input. JSON cannot restore a collector's
WeakMap receipts; re-admit exact persisted values through the typed validator.
Lifecycle ownership does not grant checkpoint body access. Reuse WorkflowJob/Event
where appropriate; do not introduce a second independent effect queue.

## Existing interfaces and required composition

These are implemented PUN-68 interfaces, not replacements for Bloop's lifecycle:

- `prepareArtifactSourceCommit` and `withArtifactSourceCommit` now compose the
  complete source plan with native replay and the trusted owner adapter. Use this
  wrapper for new composition, with every output/snapshot ID preallocated and
  exact original semantic inputs. The following lower-level native preflight
  remains available but does not provide the complete source/target lock union.

- createConversationPromptInput(actor,{workspaceId,conversationId,content,tx})
  and createConversationIngressInput(actor,{workspaceId,content,tx}) join native
  admission to the caller transaction. Preserve the original authenticated actor
  object (including process-local capabilities) and copy submission before awaits.
- prepareConversationInputs({...promptInputId|ingressInputId}) validates/reuses
  the admitted ID. Run its current global-client reads after admission commits;
  do not read uncommitted admission through a separate connection.
- One createConversationLineageCollector per generation must register every
  actual dynamic model input before use, including uncited context, history,
  eager/search/tool output, counts and predicates. A reconstituted checkpoint
  cannot invent opaque in-process receipts from serialized JSON.
- captureImmutableArtifactInputProof(actor,ws,completeRoots,tx) preserves complete
  consumed revisions. Store those exact roots/vectors with checkpoint content and
  content hash. Never recapture current epochs onto old checkpoint/generated data.
- prepareArtifactCommitPreflight(actor,ws,roots) runs outside the SQL transaction.
  withArtifactCommitPreflight(actor,ws,tx,roots,token,work) checks the same actor
  and exact complete roots, consumes the token once, and scopes native validation
  to the supplied non-primary transaction object. It does not independently attest
  that object's run/lease/connection. Bloop's mandatory exact saver/fence binding
  must provide that guarantee. A retry needs a new preflight. No model/provider/
  embedding call belongs in the callback.
- ArtifactInputWriteFence = (tx:Prisma.TransactionClient)=>Promise<void>.
  withArtifactInputWriteFence and withAdditionalArtifactInputWriteFence propagate
  trusted worker/claim guards. Helpers invoke assertArtifactInputWriteFence(tx);
  this guard is optional for standalone APIs, so Bloop must make it mandatory at
  each lifecycle/saver entry and reject an absent, foreign or expired binding.
- ingestConversationOnDemandInTransaction(tx,actor,submission) writes BrainSource,
  complete DERIVED manifest, audit and outbox on tx. Submission contains workspaceId,
  title, content, optional sourceType, lineageInputs and lineageRoots. It does not
  write Bloop's canonical publication receipt or checkpoint.
- addConversationTurn(actor,{...,promptInputId,lineageRoots,tx}) joins the final
  human-session turn to tx and requires its exact prompt. Native MCP ingress does
  not become a fabricated user-session prompt. Bloop must use its appropriate
  canonical MCP finalization receipt and persist full proof for its output.

Saver requirement: put/putWrites use tx.$executeRaw/tx.$queryRaw on the bound
Prisma interactive connection. A stock Postgres saver with its own pool cannot
join this transaction. The binding carries the immutable tenant/principal,
request/run/job/attempt/lease/checkpoint-generation tuple, exact tx and active
lifetime. Mandatory pre/post claim checks use that tx; finally invalidates the
binding, including detached tasks. Reads use current permission-checked durable
proof. Serialization/model work occurs before the bounded transaction.

## Atomic lifecycle transitions

1. Admission: current native caller/tenant/conversation authority, exact native
   input, unique admission/request identity, initial checkpoint, queue/outbox intent
   commit together. Only after commit may a worker consume the queued generation.
2. Approval: exact current approver authority, approval generation, checkpoint,
   output/content hash, complete context proof and destination identity plus wakeup
   commit together. Any changed input/output/destination needs a new approval.
3. Publication: after outside-TX native preflight, lock/recheck the exact current
   owner/run/job/attempt/lease and approved checkpoint generation. BrainSource and
   lineage/audit/outbox, canonical unique publication receipt, checkpoint and
   lifecycle state commit together. Unique publication key binds tenant, request,
   approved generation and destination; receipt binds exact source ID/content/proof.
4. Finalization: same owner/generation guard, exact native prompt or ingress and
   complete assistant/context proof, final turn/receipt, checkpoint and job/run
   completion commit together. A post-commit delivery failure cannot overwrite a
   COMMITTED receipt or turn the successful job into FAILED.

UNKNOWN/restricted lineage blocks publication/content replay. On lost acknowledgement,
the authenticated worker reconciles commitment from the canonical control receipt
under its exact tenant/request/generation and ownership guard, even when source
content is now revoked. It must not rerun a committed effect or mark it FAILED.
Separately validate current contributing sources before releasing any source/body,
checkpoint or result bytes to a caller/model. Control reconciliation exposes no
unpermitted body, source IDs, labels or counts. Never infer commitment from a
checkpoint flag, synthetic marker or output text. Reconciliation cannot replay
restricted bytes or regenerate from old output.

## Proposed exact lock order for joint implementation

The historical proposal below is superseded for source commits by the implemented
contract: the entire sorted source advisory union is held BEFORE the owner
callback locks its durable control rows. Bloop must coordinate earlier request,
claim and conversation locks against that order; joint lifecycle acceptance is
still open. Do not implement the historical sequence literally.

1. Request/admission idempotency advisory key scoped by tenant/principal/request.
2. Existing WorkflowJob claim row, then AgentRun row, then continuation request,
   approval/publication/finalization control rows in fixed type/id order (when
   present). Recheck exact tenant, principal, attempts, lockedBy, lockedAt, lease
   expiry and checkpoint generation. Admission with no job/run skips absent rows;
   it does not create a contrary order for existing records.
3. Conversation sequencing advisory key, then checkpoint/idempotency keys and
   checkpoint rows in fixed namespace/id order. addConversationTurn already takes
   the conversation_turn advisory key; acquire/reuse it before source epochs.
4. ConversationSession row, then native provider/governing rows and local target/
   source archive/advisory/row locks,
   using the same stable union/order as the selected PUN-68 adapter and producer.
   All direct semantic target rows must be locked before permission epoch checks.
5. SourcePermissionEpoch full closure union ordered by sourceKind/sourceId COLLATE C; then all
   actual content, lineage, saver, receipt and outbox writes. Repeat claim/source
   checks without acquiring an earlier class of lock after this point.

This was a proposed shared order, not a claim that8bb implemented it globally.
PUN-68 now supplies the bounded lock-plan interface (native/governing/local rows,
head union and saved epochs). Earlier legacy locks, including conversation
sequencing/session and Bloop lifecycle controls, still require actual coordinated
composition. Locking a saved union is not permission
to capture/restamp a fresh proof. Joint concurrent-writer tests must establish the
actual combined order. Bloop compares its held saver/claim order before coding.
Existing CRM confirmation
owns its own publication transaction and ConversationPendingOperation owner lock;
do not nest that helper in a bound saver TX. If checkpoint+CRM effect atomicity is
required, coordinate a caller-tx API change first. No provider call under DB locks.

## Joint synthetic PostgreSQL acceptance (actual held lifecycle)

Use only disposable port55468, two users/two workspaces, mocked remote/model
transport and actual SQL rows/triggers. Pin both code heads and schema checksum.
Primary Prisma delegates, second pools and SDK calls throw during bound TX tests.

- Inject failure after each admission native input/request/checkpoint/queue write:
  all roll back; retry preserves request/idempotency identity but may create a new
  DB-generated native ID. After committed admission/lost ACK, retry must reuse the
  exact committed input ID. Mutated caller,
  tenant, request/context, transaction or reused inactive binding is rejected.
- Inject failure after approval/checkpoint/wakeup writes: all roll back. Duplicate
  approval/wakeup is idempotent; old generation or changed output/destination cannot
  publish. No publication proceeds without its exact approval.
- Inject failure after Brain content, manifest, audit, canonical receipt, saver
  put/putWrites and outbox writes: all roll back. Crash after commit/before ACK plus
  retry produces one canonical source/receipt and reconciles from it.
- Crash after a successfully committed independent tool effect but before saver
  putWrites/checkpoint. Reconcile from that tool's canonical effect receipt without
  duplicate mutation, even if source access is subsequently revoked; withhold its
  bytes from resume/model/delivery. A missing/ambiguous effect receipt blocks retry.
- Exercise early streamed model/tool/preview output. Check current complete sources
  before each delivery boundary and after awaited work; restricted or unreceipted
  bytes never escape. A permitted draft preview must remain a preview and cannot
  imply approved publication or completed effects before their canonical commits.
- Expire/reclaim job or change run/checkpoint generation between model and commit;
  old attempt publishes/finalizes nothing. Test both winner orders, cancellation,
  concurrent finalizers and stale FAILED terminalization after COMMITTED success.
- Race session edits, source/privacy writers, claim/cancellation and checkpoint
  transitions in both orders; observe blocking and verify no combined lock deadlock.
- Mix public/private and uncited contributing sources; revoke membership, source,
  OAuth consent, credential scope/version or native provider access before model,
  during generation, after commit and before final delivery. No unauthorized body,
  context, counts/ranks/paths/audit labels or cache/checkpoint replay reaches a model
  or response. Restoring access never revives a consumed stale epoch vector.
- Remove one of two sources: preserve originals, withhold old derived output, make
  a fresh permitted-source variant from independently allowed inputs, with new
  approval when required. Unknown legacy checkpoints hold only unproved derivatives.
- Final turn/receipt+saver+job/run completion rollback together; committed final
  result dedupes on retry. Native prompt remains available independently when its
  assistant derivative is withheld. No checkpoint garbage collection or rollback
  path resurrects restricted historical content.

Existing caller-tx helper PG tests and Bloop's41 focused tests are supporting
evidence only. Full acceptance requires this actual composed lifecycle, independent
GPT-6.1 Sol xhigh review and exact-head required CI. Keep both PRs draft; publication
of the foundation does not authorize activation, merge or deployment.

## Response to Bloop's October13 concrete mapping

The mapping is compatible with this contract subject to these corrections:

- Preserve the stronger publication barrier: serialize the exact checkpoint and
  pending writes before the bounded transaction, then commit the effect, its
  canonical receipt, checkpoint and lifecycle together. A receipt-first graph
  effect followed by a later LangGraph checkpoint is not equivalent. Preallocate
  effect identifiers or serialize a typed publication intent when the checkpoint
  needs a not-yet-written effect identity; never call a provider or serializer
  under the transaction locks. An already independent tool effect uses its own
  canonical receipt and control reconciliation, not a fabricated atomic claim.
- Read authenticated control-only COMMITTED receipts before loading checkpoint
  bodies during recovery. Revocation withholds content without erasing committed
  success; never expose restricted IDs, labels or counts and never overwrite
  COMMITTED with FAILED after an acknowledgement failure.
- Use ConversationContinuation-prefixed models. Request uniqueness is
  (workspaceId, principalBindingHash, requestKey); generation is
  (workspaceId, requestId, generation); approval is
  (workspaceId, requestId, approvalGeneration); publication is
  (workspaceId, requestId, approvalGeneration, destinationHash); finalization is
  (workspaceId, requestId, generation). Checkpoints include namespace/checkpointId
  and writes include taskId/writeIndex. Enforce tenant/request/generation
  consistency in relations and immutable semantic hashes, not only unique keys.
  Preserve SDK pending-write conflict semantics. Do not retrofit uniqueness onto
  historical turns. Dispatch is (workspaceId, requestId, dispatchKind, ordinal),
  reserving actual run-wide dispatches; Gateway remains the sole billing owner.
- Reuse WorkflowJob/Event and namespaced wakeups. Waiting and committed states
  cannot fall through generic completeJob/failJob terminalization. Compose the
  human path first; MCP continuation registration remains deferred.
- Parent owns schema/migration after183 and coordinated tenant purge/transfer/
  export classifications. Bloop owns only agreed conversation dispatch/recovery
  hunks in outbox/worker, and the opt-in durable admission/subscription/result
  hunks in the canonical conversation route and conversation.ts/tests. PUN-68's
  existing CRM/source wrappers remain PUN-68-owned. Named hunk ownership must be
  confirmed before any edit in a shared file; this response reserves no whole file.

The bounded source composer now uses the closed authority-edge/physical registry,
rejects changed ancestry without late locks and requires whole-head reservation.
Existing native scope tokens alone do not prove Bloop owner/connection binding.
No schema, SQL saver or actual canonical lifecycle acceptance is
established by the current foundation mapping. The foundation is now published
as described above; this response does not authorize its live composition.

## Bounded source-plan API for the staging-barrier integration

These modules have bounded independent review and synthetic PostgreSQL evidence
in the current candidate. They are not an accepted joint lifecycle ABI. PUN-68
owns them and the existing source/authority adapters. Prefer the composed API
in the bounded source contract; these are its lower-level internal interfaces.

```ts
prepareSourceCommitLockPlan(actor, workspaceId, immutableRoots, {
  writeTargets, ownerBinding,
}): Promise<SourceCommitLockPlan>

prepareSourceCommitOwnerAttestation(
  actor, workspaceId, tx, plan, ownerBinding, assertOwner,
): Promise<SourceCommitOwnerAttestation>

withSourceCommitLockPlan(
  actor, workspaceId, tx, immutableRoots, writeTargets, ownerBinding,
  plan, attestation, dbOnlyWork,
): Promise<T>
```

- Plan and attestation are opaque process-local single-use capabilities. Actor,
  OAuth origin, native purpose, complete saved roots, output identities, owner
  binding and actual interactive connection are immutable and exact. The current
  implementation checks pg_backend_pid/transaction identity. Bloop's trusted
  owner adapter must additionally verify the real request/run/job/attempt/lease/
  generation; a caller-supplied callback or serialized tuple alone proves none
  of those durable ownership facts.
- ownerBinding is a typed WORKFLOW_JOB, AGENT_RUN, CONVERSATION_GENERATION or
  HUMAN_REQUEST identity with a positive generation and immutable control data.
  Current recovery ownership and the committed receipt's original writer tuple
  remain separate. Control-only commitment reconciliation precedes this source
  re-admission API and must work when body re-admission is denied.
- writeTargets declares exact artifact IDs and projected governing metadata.
  Preallocate creation IDs. Existing unreadable target bodies are not semantic
  roots merely because a new permitted-source variant needs their structural
  authority. Any structural saved-vector receipt needs a trusted constructor and
  remains separate from content proofs. Unplanned snapshot/output IDs cannot be
  silently introduced or used to refresh historical vectors.
- Native replay and checkpoint serialization finish outside SQL. The source plan
  is the OUTER executor and holds its scope through the INNER safe native adapter
  and domain writer. The outer layer locks declared source heads/archive keys,
  physical rows/predicates, then the original saved epoch union, and rewalks the
  same closure before/after. It does not activate native authority. The inner
  adapter may only reacquire already-covered rows/epochs, verifies the complete
  proof, then invokes the writer. The temporary physical lock hook cannot host
  this executor: its scope would end before the writer runs.
- Existing manifest/semantic writers must reserve compatible heads BEFORE DML.
  A lock added only when appending a receipt after content mutation is too late.
  New ancestry, missing coverage, changed heads, conflicting saved vectors,
  unknown aliases or exceeded budgets reject without acquiring extra locks.
- Current ambient authorization observations are tagged commit-only fences, never
  recorder inputs or substitute historical vectors. Scope/node/channel-write
  metadata must bind immutable operationScopes and original proof. Source schema
  remains through183; parent owns coordinated ConversationContinuation models,
  compound tenant/request relations and the next migration, tested locally only.
- The SDK staging saver must capture every callback and signed write index with
  pinned conflict behavior, then CAS parent checkpoint and pending-write frontier
  at the commit barrier. Run-wide dispatch reservations remain distinct from
  checkpoint generations and Gateway billing. Actual PostgreSQL rollback,
  claim-race, revocation and SDK equivalence tests are still required.

There are no source-plan schema changes in this foundation. Complete existing
writer migration and actual Bloop composition still precede full acceptance.
