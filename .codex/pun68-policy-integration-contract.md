# Company source policy: coordinated additive interfaces

Jan's clarified policy: company-wide is within the current workspace; explicit
category/role/circle restrictions bind every input. Private prompts default
private. Brain export selects no chat metadata, a partial transcript or the full
transcript with explicit consent; this does not waive other source restrictions.
New meeting transcripts default company-wide unless topic/circle restrictions
apply. Graph approvals carry forward unless a material change makes validity
uncertain. Preserve existing private records/originals; no mass-publication backfill.

This document proposes exact shared interfaces before edits. Existing policy only
has KnowledgeAccessDomain WORKSPACE/FINANCE; Meeting has no category/circle policy
binding. NativeTranscriptInput has mandatory human owner fields. Those facts do
not implement the clarified company policy.

## Category and binding schema proposal

Use a tenant-owned SourceAccessCategory with stable id/key and mode WORKSPACE or
RESTRICTED. RESTRICTED has explicit allowed Role and Circle relations; empty
allowlists deny. SourceAccessBinding assigns zero or more categories to an exact
typed `{workspaceId, artifactType, artifactId}`. Multiple restrictions intersect;
no binding uses the company default. Explicit source privacy and existing Finance
module/access restrictions remain binding. Do not rewrite existing grants.

Every absence-sensitive binding set has a durable epoch keyed by artifact kind/id;
adding the first restriction invalidates an earlier default-public proof. Every
category/allowlist mutation advances its stable policy epoch. Deletion/recreation
retains tombstones. Current active membership, nonexpired RoleAssignment and live
Role/Circle membership must be checked on each read. PUN68 owns additive FKs,
Workspace/purge implementation and migration order; PUN68 implements trusted policy
loaders, source-governor/epoch/lock coverage and tests. No schema is edited here.

## Recorder receipt and intake seam

Add a distinct recorder-native mode/receipt carrying no fabricated human owner.
Its durable envelope binds exact workspace/provider account/credential config,
recording/bot identity, verified origin/recovery request, raw provider artifact,
payload hash, target Meeting and category/circle bindings. A trusted adapter owns
actual verification and fetch; model strings and copied provider metadata cannot
mint it. Immutable record fields are enforced by the database.

Creation and retained recovery need durable source-attempt/generation ownership,
not a process-local system label. Preparation and model/provider work finish
outside SQL. A caller-owned transaction publishes native input, Meeting changes,
complete manifests, recording/provider event terminal state and outbox atomically
under complete source/output locks and current owner/configuration fences. Empty
artifact, duplicate delivery, delayed callback and reclaimed generation are
distinct outcomes. Never skip intake merely because raw text matches an existing
unproved Meeting transcript. Existing uploaded/private native modes stay private.

Reader permission for this NEW company audience is active workspace membership
plus current source/category/topic/circle permissions; it does not borrow a past
recording worker lease as a reader grant. Credential/config/source revocation and
delete/restore leave old derivatives withheld until independent authenticated
regeneration. Legacy unreceipted recordings need authenticated provider recovery;
raw stored transcript does not qualify as a new original.

## Brain export consent seam with PR1523

Parent owns harness/admission/approval/UI lifecycle. PUN68 owns an authenticated
output-specific consent constructor and serving proof. The user selection must
bind exact export output fingerprint, frozen generation, selected metadata mode
NONE/PARTIAL/FULL, exact selected turn ids/fingerprints and destination. PARTIAL
requires the explicit selected subset; FULL requires the exact admitted transcript
revision. Model arguments, session labels, or a prior approval for different bytes
cannot stand in for consent.

Full actual consumed-input lineage stays recorded even when metadata is omitted.
Any sharing authority for the user's private prompt must be bound only to this
exact derived export/purpose; it does not make the raw prompt/session globally
readable or waive any company/third-party source restriction. Do not implement
metadata omission by deleting raw prompt ancestry. All other input permissions,
current workspace membership and consent revocation still gate content/counts/
context. Preserve the originals and keep consent selection out of model control.

## Graph approval carry-forward

Carry the existing approval identity when the rebuilt statement/diff preserves
its reviewed meaning, target and applicable authority. Bind it to the new exact
revision and record comparison evidence. Material changed meaning/targets or an
uncertain validity requires a fresh review; source removal alone is not a reason
for routine reapproval. Removed/private evidence and old paths/counts are withheld
immediately. No prior approval supplies access to a restricted contributor.

## Required integration evidence

Two users/two workspaces with company default and intersecting category/Role/
Circle restrictions; privacy/role/membership/config changes; absent→restricted
policy, delete/recreate/restore, legacy unknown, counts/ranks/paths/context/cache.
Actual recorder webhook/recovery races and owner rollback; no SDK/model in SQL.
NONE/PARTIAL/FULL export consent for exact selected bytes, forged/reused selection
denial, private raw prompt still private, restricted external input still denied.
Graph unchanged approval retained and material/uncertain regeneration held for
review. New behavior, schema and endpoints require integrated independent Astra
QA and exact-head CI before the protected batch may be delivered.
