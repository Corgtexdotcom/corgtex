# Personal conversation runtime foundation

This is a default-off, production-intended execution library. It does not admit live
requests, register an outbox handler, connect a checkpoint database, or enable a product
experience. The existing conversation route is unchanged. No task or artifact is required
to finish a conversation. Shared Slack/team authority is outside this personal runtime. Personal chats remain private
until explicitly approved publication of a selected result. Company memory is a separate
read/publication boundary; the harness does not turn personal conversation history into
company memory. Internet and personal connector access remain excluded at launch.

`createAssistantHarness` calls the existing `ModelGateway` directly. Gateway routing,
credentials, quotas and `ModelUsage` remain authoritative. The harness adds no provider
wrapper or usage writer. `workflowJobId` and `agentRunId` are passed through the current
gateway contract. The runtime accepts only an authenticated human actor bound to the
personal run. Future lineage integration must consume the domain owner's exports.

The only read capability names are `read_brain` and `read_meeting`; the application supplies
their permission-enforcing implementations. They must return source references, which are
reauthorized before reuse, including resume. Retrieved text stays in a tool message as
untrusted evidence. Web and personal connector tools are excluded. A separately supplied
publication port can propose exactly a selected result and optional context summary for
approval. It cannot publish conversation history implicitly.

## Invocation and application responsibilities

Use the supported `@corgtex/agents/assistant-harness` package export. Construct a fresh runner
for each claimed job segment. Pass `env.ASSISTANT_HARNESS_ENABLED` and the server-controlled
workspace opt-in explicitly; both are off by default. Disabling the gate holds existing runs;
it must never send their continuations through the legacy loop. Scope, actor, AbortSignal,
ports and callbacks remain outside checkpoints. The runtime exposes no raw SDK Command or
checkpoint selector to clients. Initial input permits user/assistant messages only.

A runner snapshots its admitted scope, job claim, actor, cancellation signal, delivery
audience and capability descriptions. Those identity objects are frozen; changing the
caller-owned objects cannot retarget a running segment. Port methods retain their original
receivers, including class private fields. Callbacks must bind their own authorization to
the admitted identity and consult live policy; freezing the harness context cannot freeze
or repair an adapter's closure or internal state. Use the admitted signal to cancel a run,
not replacement of the caller's signal property.

One runner rejects overlapping `run()` calls before any app-port access and releases that
local guard after completion or failure. Distinct runners remain independent. This is not
a lock across runners, workers or processes: the application must serialize the same job
and enforce claim/lineage fencing at its authoritative storage boundaries. Cancellation
can end the SDK invocation before a pending adapter settles. Adapters must cooperate with
the admitted signal; the harness cannot forcibly stop a noncooperative promise or guarantee
that rejected `run()` means all external work has terminated.

`AssistantRuntime.authorize` must verify current membership, personal session ownership,
source permissions, cancellation, budget, support/MCP revocation context where applicable,
and the job claim. `reserveDispatch` must atomically fence and count each harness gateway
or read-tool invocation against a run-wide limit, including replay after checkpoint loss.
After a model reservation resolves, the runner revalidates current authority and exact
saved sources before invoking the gateway. A denial keeps the reservation consumed while
preventing the gateway invocation; the harness neither refunds it nor writes usage.
Read dispatch also revalidates authority after both reservation and the awaited tool-start
delivery acknowledgement, immediately before calling the domain read implementation.
Approval decisions also receive post-await cancellation and authority checks before a
waiting/resume outcome. Checkpoint counters alone cannot guarantee the invocation bound. A read adapter's terminal
`AssistantHarnessError` (including cancellation, authority and budget denial) stops the run;
ordinary read failures remain sanitized tool errors. Failed dispatches consume reservations,
and retrying a runner does not reset that durable budget.

Gateway invocation is not an individual provider HTTP attempt. The current gateway has
internal retries and OpenRouter fallback, with no request-level retry-disable option or
per-attempt authorization hook. It also awaits budget/headers before its first HTTP send.
This harness therefore cannot claim fresh authority or separate reservations for each
downstream attempt. Before live enablement, gateway-owned integration must guard each
actual attempt with current source/claim authority, propagate revocation cancellation and
define the fallback policy. Gateway remains the sole usage writer; repeated provider work
may be billed again. There is no exactly-once provider billing claim.

Incremental output requires an `AssistantDeliveryPort` bound to the actual authenticated
personal subscription. The runtime rejects an audience that differs from its workspace,
user or conversation. Every content delta and tool event is awaited through that port with
an immutable snapshot of the trusted scope, actor, signal and exact accumulated source
references; raw provider tool arguments and graph values remain excluded.

The port must revalidate the recipient's current session, personal ownership, source access,
claim and cancellation at the transport handoff. It must serialize that handoff against
revocation under the application's policy. A permission read followed by an unrestricted
callback is not sufficient. No database/socket atomicity is supplied by this library.
`DENIED` or an authorization exception stops the runner and closes the gateway generator;
unknown errors are sanitized. The harness awaits generator closure on its stream exit and
preserves the primary stop reason if cleanup also throws. Closure of a pending iterator still
requires the provider/gateway to cooperate with cancellation. A known transport disconnect returns `DETACHED`, which does
not cancel the admitted turn or redispatch billed work. The port must keep that connection
detached. Cancellation must be checked by the port immediately before handoff as well as
by the runner before/after it. Already delivered authorized bytes cannot be retracted.

There is deliberately no raw `emit` callback fallback. Omit `delivery` until this guarded
transport integration exists: the gateway may stream internally, but no incremental events
are released and the runner returns its final result after the existing result authorization.
The future route must also authorize its actual recipient when delivering that final result.
The port is an additional live-integration gate, not an implemented production transport.

`ClaimedCheckpointPort` is a required app integration boundary, not an implemented PostgreSQL
saver. `AssistantCheckpointStore` bounds SDK access and uses the official patched base
saver/serializer. It does not make the supplied port atomic. In particular, checking a lease
before calling stock `PostgresSaver.put` on a separate transaction is unsafe. No `pg` is
imported, no extra pool is created, and no DDL or runtime `setup()` is present.

Minimum proposed transaction contract for the domain/queue owner:

- Bind immutable run/request identity, workspace, user, conversation and versioned policy.
- Preparation receives the exact accumulated source references. In the same transaction
  as any preparation write, revalidate current membership, source permissions, claim and
  cancellation; a caller-side authorization check alone is not atomic. The runner also
  rechecks after preparation returns before checkpointing a pending approval.
- Check the current job owner/attempt and expected checkpoint lineage inside every
  checkpoint/write transaction. Reject stale writers even after connection loss.
- For local publication, reauthorize and validate exact selection/decision/expiry, then
  commit the effect, unique canonical receipt and existing outbox event atomically.
- COMMITTED returns that canonical receipt without another effect. UNKNOWN requires
  authoritative reconciliation and must not be converted into a retry or success.
- Admission, approval wakeup, cancellation, final turn and job completion use the same
  claim/generation rules. An approval arriving before the interrupt must retain a retryable
  wakeup. New wakeup generations need distinct dedupe keys in the existing queue.

The publication interfaces expose semantic views and opaque receipt/approval IDs. They do
not define a second storage format. A decision is reloaded after interruption and before a
new effect. Application commit still must check authority and deduplication atomically;
the graph's read-before-write is not that guarantee. The runner reauthorizes after each
awaited effect inspection, approval decision and commit before its next action or checkpoint
update. If a commit succeeded but later authority fails, a retry must inspect the canonical
receipt instead of repeating the effect; the existing app-owned idempotency contract remains
required.

Authorization receives frozen copies of source references. Read evidence and provenance,
prepared approval references and effect receipts are copied before subsequent awaits, so
adapter-retained objects cannot change what is later checkpointed. Publication selection and
reference arguments are frozen before adapter calls. These copies preserve the exact values
seen by the harness; they do not validate an adapter's provenance or replace atomic source,
approval and receipt checks.

`handleConversationTurn` and `recoverConversationTurns` are callable integration functions,
not a registered worker path. Their ports must be supplied by domain admission/receipt and
the existing outbox. The recovery sweep is bounded and classifies early decisions, runnable
work, missing final results, cancellation and UNKNOWN. It creates no queue or timer itself.
The worker drain signal must cancel cooperative calls; browser disconnect only detaches an
ephemeral subscriber. User cancellation is a durable domain decision.

## Validation and outstanding gates

Unit fixtures exercise the real graph and gateway contract with `MemorySaver` and explicit
fake app ports. They do not prove PostgreSQL fencing, process-crash durability, automatic
`runPendingJobs` recovery, or production receipt integration. A new runner in these tests
is not a fresh process. Regression coverage includes mutable caller/adapter context, terminal
read failures, same-runner overlap and independent runs, effect authorization ordering,
cooperative stream cancellation, cleanup-error precedence, and budget consumption across
failed dispatch/retry. Existing approval/lost-acknowledgement/UNKNOWN tests verify the graph's
use of synthetic idempotent ports, not production exactly-once effects. Run with Node 22.22:

```
npx vitest run --project unit packages/agents/src/assistant-harness/gateway-node.test.ts packages/agents/src/assistant-harness/graph.test.ts packages/shared/src/env.test.ts
npm run check
env -u DATABASE_URL npm run build
```

The database URL required by Prisma schema validation may point at an unused disposable
local database; this foundation does not require connecting to it. Builds stay DB-independent.

Before enablement: agree/implement the atomic port, admission and lineage seam; release
the held outbox/barrel integration paths; test real claim loss, crash/restart and duplicate
completion; migrate official checkpoint tables through the reviewed release path; integrate
tenant/user deletion, retention and rollback version policy; consume PUN-68 privacy work;
verify the actual worker image and bounded pool/TLS settings. No lifecycle coverage, private
memory implementation, team memory, live voice or launch readiness is claimed here.

Graph version `personal-conversation-v1`, state version 1, configuration digest and domain
policy version reject incompatible resumes. Interrupted node names must stay stable. The
owner must review any future policy/schema change against persisted checkpoints before
enabling it. No public graph values/debug streams are exposed.

The pinned SDK can re-enable environment tracing during async iterator setup. Its configure
hooks also inject handlers independently of runnable callbacks or a tracing-enabled RunTree.
The runner therefore refuses any inherited LangChain/LangSmith async context, including an
empty or tracing-disabled context, before compilation or state access. It uses the exported
storage interface and never clears or changes the caller's context. Tracing flags and verbose
mode are also refused. Invoke this private runner outside SDK instrumentation context with
tracing disabled; unrelated concurrent instrumented runs retain their callbacks. Tests block
fetch and cover context-only custom handlers, LangChainTracer and environment handler factories.

Dependencies are exactly pinned: LangGraph 1.4.21, core 1.2.17 and checkpoint 1.1.6.
LangSmith 0.10.11 is also pinned as a test dependency for the inherited-context negative
control (core brings the same version transitively). The graph-input
control-directive advisory is patched in 1.4.21. The serializer pin is newer than the
deserialization fix. See the maintainers' advisories and durable execution/interrupt docs:

- https://github.com/langchain-ai/langgraphjs/security/advisories/GHSA-wp87-994x-j95x
- https://github.com/langchain-ai/langgraphjs/security/advisories/GHSA-j87f-x5h5-gr75
- https://docs.langchain.com/oss/javascript/langgraph/durable-execution
- https://docs.langchain.com/oss/javascript/langgraph/interrupts
