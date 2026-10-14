# PUN-68 bounded source commit contract

This is the candidate contract for draft PR1517. It describes the implemented
source plan and the retained Execution COMMENT/existing-target composition.
It is not full PUN-68 acceptance or authorization to activate Bloop's held patch.
Current published baseline:1a844d52f80a45454d6b046ad75318d6c831b8a8.

The shared write fence is extracted to `artifact-input-write-fence.ts`: exactly
one ALS instance, additive nested owners, lifetime rechecks and distinct
ARTIFACT_INPUT_WRITE_FENCE_LOST for source-denial callback failures. A missing
optional fence retains its parent; it does not itself prove durable ownership.
Source-lineage compatibility exports use the same instance. The SQL type/driver
registration prerequisite grants no native input or committed publication receipt.

## Inputs and ownership

`prepareArtifactSourceCommit(actor, workspaceId, originalRoots, options)` runs
outside the interactive transaction. It seals the original actor identity,
native origin/purpose, exact consumed roots and original permission vectors,
typed owner/generation and complete preallocated output set before awaiting.
Native replay finishes before SQL. A retry requires new preparation.

Options contain `writeTargets`, `ownerBinding`, and optionally exact opaque
`structuralAuthorities`. A JSON owner tuple grants no authority. The real owner
callback must query the matching durable control/claim on the caller transaction,
including its tenant, principal, generation, status and terminal receipt.
It must not call source readers, grant loaders, serializers or SDKs before the
source union is held. The wrapper denies provider/model work throughout SQL.

`withArtifactSourceCommit(..., tx, ..., token, assertOwner, work)` binds the
single-use plan to the actual backend PID/transaction ID. Foreign clients,
origins, purposes, roots, outputs, generations and expired scopes are denied.

## Lock order and closure

1. Reserve the entire discovered advisory union in canonical order, using the
   strongest mode once, before the real owner callback locks its control row.
   Source-head aliases share physical identity: Meeting/transcript/agenda,
   tool-link/credential and WorkflowJob/input. Archive keys are included.
2. Lock the bounded physical source/governor/output union in fixed order.
   Existing owner controls already locked by the attested callback retain their
   earlier control position. A target also consumed as an input uses UPDATE.
3. Lock one exact epoch union: immutable original consumption vectors, separate
   fresh structural fences, and tagged current ambient policies. Missing source,
   OAuth, credential or historical keys are denied; they are never initialized
   as replacement proof. Only explicitly permitted current configuration absence
   fences can be initialized before the native commit phase.
4. Rewalk the exact closure before work and after work. Newly observed rows,
   predicates, grants, governors, heads or ancestry require a new plan. There are
   no late lock upgrades or fresh historical vectors.

Native Slack, Box and MCP executors run inside the outer source scope. Their
physical/predicate/epoch checks reuse exact held coverage. Finance also checks
its module, feature, role, circle, membership and support predicates. The original
strict epoch API accepts original evidence only; writer-facing current checks
may use separately tagged ambient/structural fences without changing history.

## Semantic inputs and output identities

A permission-only governor cannot become a semantic input. Actual reads check
exact original `{kind,id,fingerprint}` semantic coverage. Immutable snapshots
can prove their recorded original source equivalent. A verified recorder can
register the exact current output fingerprint for read-after-write within the
active transaction; arbitrary, unregistered, UNKNOWN or detached outputs cannot
use that seam. This internal registration is not a package API or model receipt.

Snapshot write targets carry `snapshotInput` plus projected original source
kind, ID and fingerprint. Allocation is bound to the actual actor, workspace,
transaction, input revision and held output head. Reuse compares the full saved
snapshot fingerprint, original vectors, bytes, envelope and ancestry. It retains
the existing birth timestamp; it does not rewrite a saved row. Postwork validates
snapshot ancestry against original inputs or declared verified conversions.
An immutable receipt UUID does not need a fabricated mutable source epoch.
Previously stored epoch entries remain mandatory and unchanged.

Article history uses a trusted ORM-create constructor with a private, one-shot
birth receipt bound to exact transaction, workspace, source and output hashes.
It seals caller content before awaits and accepts only the preallocated Version
ID under an active source plan. The copied vector retains all original values
and adds only the genuinely newborn Version own epoch. Existing rows, arbitrary
birth flags and JSON receipts cannot acquire this authority. Stale/unproved
derived history is preserved as UNKNOWN without blocking an independently
authorized source regeneration. H0 history retains its original saved envelope;
its creation vector is not required to match a later privacy/restore epoch.

Every Generic graph variant source in `scopeJson.sources` must match original
semantic evidence, independently of target structure. Current structural fences
are restricted to an absent, new owner-private variant. They bind target body
fingerprint, envelope and head, and never admit the old target body/ancestry as
model input or permit canonical mutations. This constructor is tested separately;
legacy Article/graph producers still need actual composition.

## Readers and historical coverage

Derived manifests and snapshots require complete saved permission coverage.
Discovery of current dependencies supplies required identities only. Fresh proof
cannot be harvested through later unpinned same-body manifests to fill an old
hole. Actual saved root vectors and hash-bound immutable snapshot ancestry remain
usable. H0 creation proof is not substitute consumption evidence.

Inside an exact active source plan, each read-only local/serving proof pass reads
the covered epoch union once before traversal and again before a positive return.
Every saved vector still parses, checks exact coverage and compares its original
values. Nested pure validators share only that pass; unused newborn own keys may
be absent, while any referenced absent key denies. Captures stay outside the pass.
The final SQL also detects a concurrent same-transaction epoch mutation. Maps
expire on return/throw; later reads query afresh. Outside-plan reads keep fresh SQL.
Inherited expired source-plan contexts deny before any standalone read/write
fallback, including physical locks, Finance, snapshots and epoch initialization.
These checks grant no serving capability or public cache bypass option.

Typed nested readers share admission heads and propagate provider-await state to
every enclosing read. Final checks use sealed copies and fresh DB-only traversal
of the complete union, preventing stale release while preserving permitted list
survivors and their collector roots.

The explicit Action public note is a separate authenticated historical event,
bound to the exact published completion revision and old Action snapshot. Current
Action readers retain their existing actions:read or brain:read source family.
Reopen and former-assignee departure do not invalidate that event. Current privacy,
membership and original-source revocation still govern. Raw MCP command integrity
is private control evidence, never a public semantic root or editor grant ancestor.

## Current integration and remaining work

Retained Execution COMMENT/existing-target publication uses this source plan in
both snapshot preparation and atomic publication, with actual Request ownership
and preallocated Result/snapshot IDs. Its lifecycle revisions carry complete
original frozen inputs. A restricted submitted source withholds the new current
revision; the independently permitted original Request snapshot is preserved.

Fresh Request birth needs genuine native admission/control authority. Creation
writeback families need complete preallocated child targets. Legacy source writers
must reserve their entire output set before earlier row locks; the central producer
hook asserts an active plan and does not add late locks to unmigrated legacy flows.
Archive/privacy control transitions, global graph publication/reapproval, remaining
native audience/intake paths, actual canonical Bloop lifecycle/HTTP acceptance,
backfill/rollback and latency/concurrency gates remain open. No schema change or
production migration is authorized by this contract. The checkpoint stays draft.
