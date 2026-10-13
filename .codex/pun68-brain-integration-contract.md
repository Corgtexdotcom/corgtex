# PUN-68 / Bloop Brain continuation integration contract

## Pins and authority

Published PUN-68 implementing checkpoint: bcc9031bf3221d1e29afc03050c6b16051dae6ec,
draft PR1517, extending a4be4f9b80411bad1667a6d93ee2bf2e53fa2775. It seals turn
submissions before awaits and supports safe Slack/Box/MCP commit mixtures. These
corrections have no schema changes. Pin the exact joint code/schema head before
tests; do not test a moving checkout. A follow-up test database guard correction
does not change these publication interfaces.

Bloop reports local 8bbfa306db9133be6c334bb08087a20710f434fb, default-off,
with no remote branch/PR. That implementation is not in this checkout and has
not been reviewed here. Its earlier caller-tx review of 0c00c554 is not current
composition evidence. This is a contract for review, not permission to publish
Bloop's held work. Parent coordinates any later authorized integration.

## File and schema ownership

| Owner | Files / responsibility |
| --- | --- |
| PUN-68 | packages/domain/src/source-lineage.ts; source-permission-epochs.ts; source-permission-parents.ts; artifact-input-actor.ts; artifact-commit-preflight.ts and native Slack/Box/MCP authority adapters; conversation-lineage.ts; conversation-ingress.ts; conversations.ts; conversation-brain.ts. Complete source/read/model/publication proofs and native prompt/ingress/turn constructors. |
| PUN-68 | packages/agents/src/conversation-inputs.ts; conversation-lineage.ts; conversation-tool-lineage.ts and their provenance tests. Actual model-input collection; admitted native ID reuse; permission-safe history/context/tool output. |
| PUN-68 schema | ArtifactInputLineage, ArtifactInputSnapshot, SourcePermissionEpoch, ConversationPromptInput, ConversationIngressInput, native input/control tables through migration183. Existing migrations are immutable. No Bloop lifecycle columns are to be added by PUN-68 without coordination. |
| Bloop | packages/agents/src/conversation.ts and conversation.test.ts canonical Brain lifecycle sections, its held foundation files, and its dedicated assistant-harness export. Connection-bound saver, admission, queue intent, approval generations, canonical publication/finalization, recovery and claim fencing. |
| Bloop proposed new files | packages/agents/src/brain-continuation/checkpoint-saver.ts; claims.ts; lifecycle.ts; lifecycle.integration.test.ts; packages/agents/src/assistant-harness.ts. These are reservations, not a claim that these paths exist at8bb. Bloop should map its existing held paths onto these responsibilities; no renaming is required. |
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

Use this order in every Bloop transition, retry, cancellation and terminalizer:

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

This is a proposed shared order, not a claim that8bb or PUN-68 already implements
it globally. Current PUN-68 epoch checks lock each proof's sorted entries during
traversal; addConversationTurn does not currently prelock ConversationSession.
PUN-68 must supply a complete bounded lock-plan interface (native/governing/local
row union plus saved epoch union), and Bloop must prelock the session/control rows
on its bound TX before invoking helpers. Locking a saved union is not permission
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
GPT-6.1 Sol xhigh review and exact-head required CI. Publication hold remains in place.
