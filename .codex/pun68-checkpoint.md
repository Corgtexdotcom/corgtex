# PUN-68 implementation checkpoint

This is a dependency-complete snapshot of the code written so far on
`codex/pun-68-source-permissions`, based on `37f9ba00` (main after PR1516).
It is an unfinished draft, not release approval or a claim of full acceptance.
No production migration, deployment, customer mutation or data purge was performed.

## Frozen integration seams

Preserve these four diffs while integrating the separate conversation-job path:

- `packages/agents/src/index.ts`: variant and conversation receipt/input/tool exports.
- `packages/workflows/src/handlers/index.ts`: source-lineage rebuild export.
- `packages/workflows/src/outbox.ts`: proof-aware notifications, rebuild dispatch,
  digest regeneration flags, and existing lease/attempt dispatch for article variants.
- `packages/workflows/src/outbox.test.ts`: real notification receipt/current-text fixtures.

The other requested manifest, lockfile, workflow index, shared environment and worker
entrypoint files have no changes in this checkpoint. The owner has frozen the four
seams above until coordinated integration.

## Architecture and current implementation

The design uses complete actual-input manifests and immutable snapshots to connect generated artifacts
to contributing sources. The required read contract gates current membership, artifact
envelopes and every ancestor before content, counts, ranks, paths or context. Remaining
reader/producer gaps are listed below; full acceptance is unverified. Original records
are preserved. Incomplete historical evidence is withheld individually, never inferred
from model citations or audit creation events. Separate permitted-source article
variants preserve the canonical article. Caches carry full local ranking input proof;
Azure result ordering and snippets do not determine the returned authorized ranking.

Conversation input capabilities are process-local and payload/actor/workspace bound.
Trusted persisted roots are checked again in write transactions. The worker-facing
write fence runs inside that same transaction; a precheck cannot replace the atomic
lease/checkpoint/effect/final-write assertion. Disabled admission must not fall back to
legacy chat for pending runs.

## Validation evidence and limits

Checkpoint `npm run typecheck` passed. Focused suites were run on successive local
revisions, not as one aggregate check:

- Retrieval/ranking/cache: 68 tests passed before the Slack wrapper expansion.
- Conversation receipt/memory/input/backfill helpers: 103 tests passed.
- Runtime/proposal/constitution receipt sector: 66 units and 4 disposable DB tests passed
  before the new exact-feedback-snapshot binding was fully integrated.
- Actions/Tensions/CRM packet sector: 252 tests passed across seven suites.
- Brain discussions/identity: 58 tests passed.
- Notification/outbox integration: 116 tests passed.
- Separate article variants: 38 units and 6 disposable DB tests passed earlier.

Migrations through `20261013003000_feedback_snapshot_binding` were generated and
applied only to the disposable local test database. Full schema-diff and registry
validation still need an integrated rerun. The chat orchestration suite currently
fails because its old mocks do not implement the new receipt/fence/input contracts;
this checkpoint does not claim that suite passed. New standalone helper tests do
not replace end-to-end chat verification. Final aggregate checks, independent full
review and exact-head CI are outstanding.

## Remaining implementation and acceptance

- Complete and test chat orchestration, ephemeral MCP chat requests and agent-credential
  permission envelopes; existing MCP pseudo sessions currently do not satisfy the
  newly persisted user-session prompt contract.
- Finish exact feedback snapshot binding, pending CRM operation execution/replay
  capabilities, recursive immutable input capture and stale-owner transaction tests.
- Finish Slack signed ingress request receipts, persisted remote-thread inputs and
  atomic Brain-note lineage. The generated Brain-note path is withheld until its
  atomic input receipt exists. Stored-only thread context is temporary.
- Complete remaining CRM model/outbound producers and other delegated runtime logs.
- Extend loop-safe rebuild events to mutable Document/Meeting source changes, and
  provide safe rebuild paths for the remaining legacy generated kinds. Unsupported
  backfill recipes remain explicit blockers; originals are not overwritten.
- Verify counts, edges, evidence, proposals, caches, search, MCP, chat, membership/
  privacy revocation, removal/restoration, retry and rollback across two users/workspaces.
- Resolve the product decision for publishing chat-derived output: whether the exact
  requester-private prompt may be contributed as a shared source, or whether publishing
  must regenerate from shared inputs. The prompt root must never be silently dropped.

Do not merge or deploy this checkpoint. Keep draft metadata and test claims accurate
as the remaining implementation proceeds.
