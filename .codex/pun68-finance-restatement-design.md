# Finance restatement: immutable value evidence

## Current defect and boundary

`finance-import-application.ts` captures the current Fact and Report, preserves
their immutable snapshots, then changes Fact `reportId`, `sourceBatchId` and
`sourceCandidateId`. The real `pun68_permission_FinanceReportFact` trigger advances
the Fact own epoch on these parent changes. The old snapshot correctly fails its
saved vector, so publishing the changed Fact aborts SOURCE_CHANGED. The synthetic
unit adapter does not model this trigger; its successful restatement is insufficient.

The actual PostgreSQL safety case uses two genuine native uploads and
two active Finance writers, applies123.45 then attempts234.56 on the same semantic
Fact, and asserts rollback of Fact, candidate, batch, manifest/snapshots, receipt,
Report and audit. The final phase probe passed1/1 in55510ms
(`/tmp/pun68-real-finance-historical-final-pg.log`); domain types and scoped lint passed.
It observes successful real Fact DML/new parent bindings and the actual own epoch
advance on the same transaction before rejection, then compares complete saved
snapshot/manifest/epoch/Event/audit rows after rollback. January2024 exercises the
twelve-month historical peer-approval boundary with Bob distinct from uploader
Alice. Independent GPT-6.1 Sol xhigh cleared this bounded corrected test.
An initial fixture transaction expired before the boundary; its timeout now
matches the existing120s product transaction. This proves safety, not successful
restatement or performance acceptance.

Do not refresh the old Fact epoch, omit a saved dependency, trust a same-body
latest manifest or treat an old snapshot as a new native original.

## Proposed coordinated design

Emit an immutable typed Fact value revision in the SAME transaction as every
new canonical Fact publication. Its stored value includes semantic key, full
value/dimensions/period, original Report/Batch/Candidate identities and exact
version/hash. Its complete lineage comes from the actual independently permitted
inputs used to compute that value. Each revision has a distinct immutable own
identity; mutable canonical Fact parent changes cannot rewrite its source recipe.

Restatement reads the existing immutable value revision and validates exact parity
with the live Fact version/value under the complete source plan. The prior value
used in beforeValueJson comes from that revision. The mutable Fact is held for
current control/optimistic comparison, while the semantic old-value input is the
typed immutable revision. All new upload inputs, old revision inputs and current
Finance policy must remain permitted before publication and serving.

This path must replace mutable Fact+Report ancestry in reconciliation as well as
application: current reconciliation snapshots those values into Candidate and
Batch manifests, which application subsequently inherits. Changing only the final
Fact writer still leaves a stale old-Fact ancestor. Pending pre-migration batches
must be freshly reconciled from independently proven inputs, never have their
ancestors silently removed. ADD, UPDATE and UNCHANGED publish exact new revisions
(UNCHANGED currently also increments/rebinds the Fact); DUPLICATE references the
verified existing revision. Receipt beforeValueJson/hash must match the prior
revision and retain the actual approval input.

Deletion, archive, explicit revocation and tenant movement need a reviewed live
lifecycle governor for revisions. A separate policy/lifecycle epoch may be needed
whose trigger distinguishes removal from an authorized canonical parent rebind.
It must not let restoration reactivate an old revoked proof. Current capability,
feature, membership, role/circle/support permissions still gate every read.
The schema currently has no Fact archive/status field; Report delete cascades
Fact, while application/candidate references constrain deletion. Parent must
resolve FK, tombstone and purge behavior. FinanceReport's uppercase ARCHIVED is
not covered by the current lowercase archive helper or Report permission trigger;
its intended lifecycle effect needs an explicit rule. No active Report archive
domain writer was found in this checkout; this is a design dependency.

Legacy Facts have no birth-time revision. Keep them withheld unless their value
can be independently reconstructed from authenticated original uploads and a
complete preserved recipe. An exact value/hash match is necessary but cannot by
itself create history authority. Preserve original manifests/snapshots unchanged.

## Ownership and acceptance before implementation

Batch coordination assigns PUN68 additive schema/migration, Workspace/purge
relations, lifecycle policy and rollback implementation. PUN68 owns the typed
source constructor, registry/coverage/epochs,
read/write source-plan integration and regressions. No new schema or runtime
activation is made by this proposal. Bloop PUN85/PUN94/PUN95 stays separate.

Required evidence: two actual uploads, old/new values and retained source bytes;
same semantic identity across revision/Fact; historical second-writer approval;
old-source and new-source revocation independently; Finance membership/feature
loss; delete/restore; forged/legacy revision denial; exact retry/replay rollback;
two concurrent restatements; source-lock/owner order and bounded operations.
Successful restatement must preserve the immutable old value and every original
source permission vector, and must not mint a refreshed historical Fact vector.
