# PUN-85 publication fence dependency

Read-only mapping of draft PR1526 at334083441baf2cbbcb9df19db2abc6354f7a4d12,
independent review5509028632. Connector cursor acceptance is distinct from content
freshness. An old overlapping run can replace newer chunks before losing its
run-end cursor CAS. Matching checkpoint text cannot fence status generations.

## Ownership and current coverage

- PUN-68 owns source publication/proof and the shared Knowledge writer boundary:
  `packages/knowledge/src/chunks.ts` (`syncKnowledgeForSource`), domain source
  lineage and source-plan adapters. The existing `ArtifactInputWriteFence` callback
  runs on the Knowledge transaction; without a trusted durable owner adapter it
  proves no cross-process ownership.
- Bloop retains PUN-85 ownership alongside PUN94/95, including the coordinated
  narrow Knowledge publication integration. Before edits, propose exact shared
  hunks and claim persistence to PUN68/parent. PUN68 source-authority files remain
  reserved. The ingestion orchestrator
  must own durable attempt/configuration identity and serialize or fence source
  ingestion across processes. The parent must assign that integration explicitly;
  a new claim schema or runtime orchestration must be coordinated with its owner.
- Already published in020a8997: `withArtifactInputWriteFence(fence, work)` and
  `assertArtifactInputWriteFence(tx)` in `packages/domain/src/source-lineage.ts`,
  exported by `packages/domain/src/index.ts`. `packages/knowledge/src/chunks.ts`
  checks the callback on the same transaction before replacement and before
  commit. `ArtifactInputWriteFence` is `(tx: Prisma.TransactionClient) =>
  Promise<void>`. The source-scoped durable run claim is proposed, not implemented
  by these APIs; it must reject old generations even when cursor text matches.
- Current source-plan code supplies exact connection/generation attestation and
  whole source/output locking, but has no ExternalDataSource/EXTERNAL_DATABASE
  authority adapter. The current PUN-68 Knowledge writer deliberately admits only
  five authenticated canonical source families and returns0 for EXTERNAL_DATABASE.
  No current code proves safe `byodb` publication or fixes PR1526 freshness.
- Head serialization alone also does not establish that the waiting old run is
  current: after obtaining the lock, publication must reject a stale durable
  generation/configuration. Cursor equality alone is insufficient.

## Required integration before activation

Use genuine cross-process source ownership outside provider/model transactions,
and validate the exact live attempt/configuration generation on the caller's SQL
transaction before destructive chunk replacement and again before commit. Every
competing writer must honor the same ownership protocol. Preallocate the full
output set and hold the complete source/head/permission union before writes.
Chunk replacement, lineage and local cache invalidation commit atomically; an
expired or reclaimed attempt cannot overwrite chunks or terminal status. SDK and
embedding calls remain outside SQL. A durable source-native input is also needed
to prove the EXTERNAL_DATABASE bytes and permitted audience.

Acceptance must race two actual processes/SQL connections in both winner orders,
including same cursor text, lease expiry/reclaim, configuration changes, failure
after embedding, rollback and cache/search delivery. The older attempt must make
no newer-content or status changes. Query count, actual lock duration and bounded
page/output closure are gates. No cursor reset, resync, replay, source rename,
customer mutation or deployment is authorized. No connector files changed here.
