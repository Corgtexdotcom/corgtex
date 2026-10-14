# Finance immutable value revisions

Finance restatement now consumes a typed immutable value revision rather than an
old snapshot of the mutable canonical Fact. The live Fact is locked in stable ID
order and checked for exact version/value parity. Its parent-binding epoch still
advances on a legitimate restatement; historical value proofs are never rebased.

## Publication and review

Migration 189 adds `FinanceReportFactRevision`, candidate comparison revision IDs,
and receipt before/after revision IDs. Every ADD, UPDATE and UNCHANGED publishes
an immutable typed value, exact original recipe/hash, approving writer/time and
candidate version in the same transaction as the Fact and application receipt.
DUPLICATE requires a verified existing revision and creates no new value revision.
Before-value JSON and hashes come from the immutable revision, never mutable Fact
ancestry. The constructor rechecks the exact approved candidate before publication.

Proposal, review and reconciliation all use the revision-derived comparison.
Candidate comparison IDs are fingerprinted semantic content, not live permission
parents; their original consumed revisions remain in preserved snapshot ancestry.
No stored recipe, snapshot, epoch or historical approval is rewritten.

Application retains its Serializable transaction, complete original epoch SHARE
locks, sorted Fact FOR UPDATE parity checks, bounded single conflict retry, and
final lineage checks. Raw PostgreSQL serialization failure 40001 is normalized
alongside Prisma P2034. Under an active complete source plan the helper requires
predeclared Fact UPDATE coverage. The source registry exposes the Fact as a required
control row and permits explicit control-write projections; it never traverses
that mutable Fact as a revision's semantic parent. The application itself has not
been migrated to the dynamic-newborn complete-plan orchestration API.

Owned proposal publication, reconciliation, candidate editing and review use the
same explicit 120-second transaction / 10-second maximum wait as application.
Global transaction defaults, row limits 5000, selected-output limit 1000 and the
4 GiB compiler budget remain unchanged.

## Permission and lifecycle behavior

A revision requires its original Report, Batch, Candidate and native upload
ancestry, current Finance policy and original writer permission epochs. A separate
Fact lifecycle identity advances on deletion/recreation, tenant or kind changes,
not ordinary parent/value/version rebinding. Revisions cannot be updated. They
have only a Workspace cascade FK so deleting/rebinding business parents cannot
erase the immutable evidence; existing Fact reference restrictions remain.

Report ARCHIVED is explicitly denied and advances the Report permission epoch.
Archive, source revocation, membership or feature loss withhold dependent values
and descendants. Restoring a prior state does not revive a saved proof. Original
bytes and immutable revision rows remain retained. Independently permitted older
values can survive revocation of a later upload; dependent newer values cannot
survive revocation of an earlier value they actually consumed.

Revision records are generated-only Finance authority, never public or human
originals. Transfer archives them byte-exact in private staging and does not
publish their historical authority. Purge ownership follows Workspace policy.

## Legacy limit

Legacy Facts without independently issued birth revisions are withheld from
comparison and serving, including hash-matching rows and copied old manifests.
`FINANCE_REPORT_SOURCE_NOT_READY` explains that verified original-source recovery
is required. A fresh upload with the same semantic key cannot restate such a Fact.
A separate authenticated recovery workflow is required; this delta deliberately
adds no fabricated historical revision, before-value or approval, and no new
recovery/grant operation. Existing pending legacy ancestry is not stripped.

## Validation and delivery

The owned synthetic PG17 database is `corgtex_finance_revision_test` on localhost
port 55479, separate from source-planner fixture 55468. Full migrations through 189 applied
with migrate deploy; Prisma generation succeeded. Tests exercise real uploads,
historical peer review, application, reads and PostgreSQL epoch triggers. Evidence
is retained under ignored `.artifacts/finance-*` paths. No customer database,
GitHub publication, merge or deployment was performed. Parent coordinates the
existing PR #1517 integration and independent Astra review.

Validation receipts on this Finance delta:

- Complete PostgreSQL suite: 4/4, 457.19 seconds of tests, covering real native
  uploads and peer review, 123.45 -> 234.56 restatement, immutable original recipes,
  independent source/policy/archive denial, non-revival, unchanged/duplicate,
  complete rollback, concurrent birth/restatement, exact replay and legacy denial.
- Final affected PostgreSQL case: 1/1, 148.77 seconds, additionally proves that the
  losing pending import re-reconciles to the winning revision and clears approval
  without another publication. Every product transaction remains bounded at 120s.
- Focused Finance/lineage/authority/purge/transfer units: 143/143; source-plan,
  epoch coverage and backfill seams: 85/85; typed revision custody: 9/9. Subsequent
  affected Finance units passed 51/51 and 29/29; counts overlap, not additive.
- Final cold TypeScript: exit 0, Node 22.22.1 / TypeScript 5.9.3, nonincremental
  with 4096 MiB V8 heap, 55.89 seconds and 4,009,590,784 bytes maximum RSS.
  Scoped ESLint, Prisma validation and diff whitespace checks passed.

These are synthetic local acceptance receipts, not independent approval, hosted
CI, protected merge or production verification. The raw Serializable application
boundary described above and legacy recovery limitation remain explicit review
items. The disposable fixture and ignored evidence are preserved for QA.
