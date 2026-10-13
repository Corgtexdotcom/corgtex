import { createHash, randomUUID } from "node:crypto";
import { Prisma, type GenericDerivedArtifactVariant } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { getMcpToolInputRoots } from "./mcp-tool-input-context";
import { lockWorkspaceMembership } from "./workspace-support-access";
import { inspectStoredArtifactInputDependencyIdentities } from "./context-graph-retirement";
import { derivationHash, derivationRootSignature, preparePermittedDerivationInputs,
  PERMITTED_DERIVATION_SOURCE_KINDS, type PermittedDerivationSource, type PreparedDerivationInputs } from "./permitted-derivation-inputs";
import { assertArtifactInputWriteFence, captureArtifactInputProof, captureArtifactPermissionEpochs,
  isArtifactInputProofReadable, lineageContentFingerprint,
  readableArtifactIds, recordArtifactInputLineage, type LineageRoot } from "./source-lineage";
import { isArtifactPermissionEpochProofCurrent, type PermissionEpochProof } from "./source-permission-epochs";

export const GRAPH_SOURCE_VARIANT_JOB_TYPE = "agent.graph-source-variant";
export const GRAPH_SOURCE_VARIANT_GENERATOR_VERSION = "1";
export const GRAPH_SOURCE_VARIANT_INSTRUCTION = `Construct a fresh proposed context graph using only the supplied independently permitted sources.
Use fresh local refs to connect objects and relationships. Evidence must cite a supplied source kind and id, and quotes must occur in that source.
Do not infer hidden facts, imitate an older graph, reuse old graph identities or claim approval. Return objects, relationships, evidenceRefs and a concise reason.`;
export const GRAPH_SOURCE_VARIANT_INSTRUCTION_HASH = createHash("sha256").update(GRAPH_SOURCE_VARIANT_INSTRUCTION).digest("hex");
export const GRAPH_VARIANT_OBJECT_TYPES = ["Person", "Team", "Role", "Process", "ProcessStep", "Project", "Goal", "Task", "Decision", "Document", "Meeting", "Customer", "Tool", "Risk", "Metric", "Policy", "Agent", "Question", "Hypothesis", "Evidence"] as const;
export const GRAPH_VARIANT_RELATIONSHIP_TYPES = ["owns", "member_of", "reports_to", "depends_on", "blocks", "uses", "created_in", "decided_in", "supports", "contradicts", "supersedes", "assigned_to", "needs_approval_from", "has_evidence", "part_of", "input_to", "output_of"] as const;
export type GraphTargetKind = "ContextGraphObject" | "ContextGraphRelationship" | "ContextGraphEvidenceRef" | "ContextGraphProposedDiff";
export type GraphVariantScope = { kind: "default"; mapKey: "critical-path" | "org-structure" | "agent-governance" }
  | { kind: "view"; mapViewId: string };
export type GraphVariantMode = "MEMBER_VARIANT" | "CANONICAL_CANDIDATE";
type UserActor = Extract<AppActor, { kind: "user" }>;
type Target = { kind: GraphTargetKind; id: string; fingerprint: string; manifestId: string; recipeManifestId: string };
type Fields = { properties?: Record<string, unknown>; confidence?: number };
export type GraphVariantCandidate = {
  objects: Array<Fields & { ref: string; objectType: typeof GRAPH_VARIANT_OBJECT_TYPES[number]; title: string; summary?: string }>;
  relationships: Array<Fields & { ref: string; sourceRef: string; targetRef: string; relationshipType: typeof GRAPH_VARIANT_RELATIONSHIP_TYPES[number] }>;
  evidenceRefs: Array<{ objectRef?: string; relationshipRef?: string; sourceKind: PermittedDerivationSource["kind"]; sourceId: string;
    quote?: string; relevanceScore?: number; metadata?: Record<string, unknown> }>;
  reason?: string;
};
export type GraphVariantBundle = {
  version: 1;
  objects: Array<Fields & { id: string; objectType: typeof GRAPH_VARIANT_OBJECT_TYPES[number]; title: string; summary: string | null; status: "proposed" }>;
  relationships: Array<Fields & { id: string; sourceObjectId: string; targetObjectId: string; relationshipType: typeof GRAPH_VARIANT_RELATIONSHIP_TYPES[number]; status: "proposed" }>;
  evidenceRefs: Array<{ id: string; objectId: string | null; relationshipId: string | null; sourceType: string; sourceId: string; quote: string | null; relevanceScore: number | null; metadata: Record<string, unknown> }>;
  proposedDiff: { id: string; status: "pending"; reason: string; diffJson: Record<string, unknown> };
};
export type ReadableGraphSourceVariant = {
  id: string; ownerMemberId: string; createdAt: Date; cohortKey: string; targets: Target[]; scope: GraphVariantScope;
  bundle: GraphVariantBundle; roots: LineageRoot[];
};
type Recipe = { version: 1; memberId: string; userId: string; requestRoots: LineageRoot[]; target: { kind: GraphTargetKind; id: string }; targets: Target[];
  scope: GraphVariantScope; mode: GraphVariantMode; deletionEventId: string | null; cohortKey: string;
  targetFingerprint: string; inputSetHash: string; sources: PreparedDerivationInputs["sourceIdentities"];
  sourceState: { archiveStates: Record<string, string>; permissionEpochs: PermissionEpochProof; targetEpochs: PermissionEpochProof };
  generatorVersion: string; instructionHash: string };
type Payload = Recipe & { phase: "REQUESTED" | "GENERATING" | "APPLIED" | "STALE"; generationToken?: string; variantId?: string };
type Prepared = { recipe: Recipe; inputs: PreparedDerivationInputs };
export type GraphSourceVariantGenerationResult = { phase: "APPLIED"; variantId: string } | { phase: "STALE" | "SUPERSEDED" };
type GenerationClaim = GraphSourceVariantGenerationResult | { actor: UserActor; prepared: Prepared; token: string };
const TARGET_KINDS: GraphTargetKind[] = ["ContextGraphObject", "ContextGraphRelationship", "ContextGraphEvidenceRef", "ContextGraphProposedDiff"];
const LIMIT = 5000;
const TX_OPTIONS = { maxWait: 5_000, timeout: 120_000 };
const json = (value: unknown) => value as Prisma.InputJsonValue;
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
export function graphVariantScopeKey(scope: GraphVariantScope): string {
  invariant(record(scope) && ((scope.kind === "default" && ["critical-path", "org-structure", "agent-governance"].includes(scope.mapKey))
    || (scope.kind === "view" && typeof scope.mapViewId === "string" && scope.mapViewId.length > 0 && scope.mapViewId.length <= 200)),
  400, "INVALID_INPUT", "Graph variant scope is invalid.");
  return JSON.stringify(scope.kind === "default" ? [scope.kind, scope.mapKey] : [scope.kind, scope.mapViewId]);
}
function targetKind(value: unknown): value is GraphTargetKind { return typeof value === "string" && TARGET_KINDS.includes(value as GraphTargetKind); }
async function targetRow(tx: Prisma.TransactionClient, workspaceId: string, target: { kind: GraphTargetKind; id: string }) {
  const where = { workspaceId, id: target.id };
  switch (target.kind) {
    case "ContextGraphObject": return tx.contextGraphObject.findFirst({ where });
    case "ContextGraphRelationship": return tx.contextGraphRelationship.findFirst({ where });
    case "ContextGraphEvidenceRef": return tx.contextGraphEvidenceRef.findFirst({ where });
    case "ContextGraphProposedDiff": return tx.contextGraphProposedDiff.findFirst({ where });
  }
}
function stale(error: unknown) { return error instanceof AppError && ["SOURCE_CHANGED", "PERMISSION_CHANGED", "UNKNOWN_LINEAGE", "SOURCE_RESTRICTED", "NOT_A_MEMBER", "FORBIDDEN", "SUPPORT_CONTENT_RESTRICTED", "SUPPORT_AUTHORIZATION_REVOKED", "WORKSPACE_SCOPE_MISMATCH"].includes(error.code); }
function payload(value: unknown): Payload {
  invariant(record(value) && value.version === 1 && typeof value.memberId === "string" && typeof value.userId === "string"
    && Array.isArray(value.requestRoots) && value.requestRoots.length <= LIMIT && value.requestRoots.every(root => record(root)
      && typeof root.kind === "string" && typeof root.id === "string" && typeof root.fingerprint === "string")
    && record(value.target) && targetKind(value.target.kind) && typeof value.target.id === "string" && Array.isArray(value.targets)
    && value.targets.length > 0 && value.targets.length <= LIMIT && value.targets.every(input => record(input) && targetKind(input.kind)
      && typeof input.id === "string" && typeof input.fingerprint === "string" && typeof input.manifestId === "string" && typeof input.recipeManifestId === "string")
    && record(value.scope) && ["MEMBER_VARIANT", "CANONICAL_CANDIDATE"].includes(String(value.mode))
    && typeof value.cohortKey === "string" && typeof value.targetFingerprint === "string" && typeof value.inputSetHash === "string"
    && Array.isArray(value.sources) && value.sources.length > 0 && record(value.sourceState)
    && value.generatorVersion === GRAPH_SOURCE_VARIANT_GENERATOR_VERSION && value.instructionHash === GRAPH_SOURCE_VARIANT_INSTRUCTION_HASH
    && ["REQUESTED", "GENERATING", "APPLIED", "STALE"].includes(String(value.phase)), 409, "INVALID_VARIANT_REQUEST", "Graph variant recipe is invalid.");
  graphVariantScopeKey(value.scope as GraphVariantScope);
  return value as unknown as Payload;
}
function sameRecipe(a: Recipe, b: Recipe) { return derivationHash(a) === derivationHash({ ...b, phase: undefined, generationToken: undefined, variantId: undefined }); }

/** No prior title, body, status, layout, approval or evidence quote enters this input recipe. */
async function prepare(tx: Prisma.TransactionClient, actor: UserActor, workspaceId: string,
  params: { target: { kind: GraphTargetKind; id: string }; scope: GraphVariantScope; mode?: GraphVariantMode; deletionEventId?: string; requestRoots?: readonly LineageRoot[] }): Promise<Prepared | "ORIGINAL" | null> {
  graphVariantScopeKey(params.scope);
  invariant(targetKind(params.target.kind) && typeof params.target.id === "string", 400, "INVALID_INPUT", "Graph target is invalid.");
  const member = await requireWorkspaceMembership({ actor, workspaceId, tx });
  invariant(member?.isActive, 403, "NOT_A_MEMBER", "Active membership is required.");
  const requestRoots = [...(params.requestRoots ?? [])];
  invariant(requestRoots.length <= LIMIT && (!requestRoots.length || await isArtifactInputProofReadable(actor, workspaceId, requestRoots, tx)),
    409, "SOURCE_CHANGED", "The original requesting input proof changed.");
  const mode = params.mode ?? "MEMBER_VARIANT";
  invariant(mode === "MEMBER_VARIANT" || mode === "CANONICAL_CANDIDATE", 400, "INVALID_INPUT", "Graph variant mode is invalid.");
  // Caller cannot manufacture a source deletion request with a free-form event id.
  if (mode === "CANONICAL_CANDIDATE") {
    const event = params.deletionEventId && await tx.event.findFirst({ where: { id: params.deletionEventId, workspaceId, type: "source-lineage.changed" }, select: { id: true } });
    invariant(event, 409, "INVALID_INPUT", "A current source change event is required.");
  }
  const row = await targetRow(tx, workspaceId, params.target);
  if (!row) return null;
  const fingerprint = lineageContentFingerprint(params.target.kind, row);
  const current = await tx.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: params.target.kind, artifactId: params.target.id }, orderBy: { revision: "desc" } });
  if (!current || current.contentHash !== fingerprint || !Array.isArray(current.rootsJson)) return null;
  if (current.origin === "HUMAN_ORIGINAL" && !current.rootsJson.length) return "ORIGINAL";
  let recipeManifestId = current.id;
  if (current.origin === "UNKNOWN") {
    const state = await tx.derivedArtifactRebuildState.findFirst({ where: { workspaceId, targetKind: params.target.kind, targetId: params.target.id,
      targetFingerprint: fingerprint, state: { in: ["REBUILD_REQUIRED", "CANDIDATE_READY"] } }, orderBy: { updatedAt: "desc" } });
    if (!state) return null;
    recipeManifestId = state.targetManifestId;
  } else if (current.origin !== "DERIVED" || !current.rootsJson.length) return null;
  const discovery = await inspectStoredArtifactInputDependencyIdentities(tx, workspaceId, params.target, recipeManifestId);
  if (!discovery.complete || discovery.manifestIdentity?.contentHash !== fingerprint) return null;
  if ((await readableArtifactIds(actor, workspaceId, params.target.kind, [row], tx)).has(row.id)) return "ORIGINAL";
  const dependencyKey = (dependencies: Array<{ kind: string; id: string }>) => derivationHash(dependencies
    .filter(input => (PERMITTED_DERIVATION_SOURCE_KINDS as readonly string[]).includes(input.kind))
    .map(input => [input.kind, input.id]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const cohortKey = dependencyKey(discovery.dependencies);
  // Cohorts use historical field-bearing source identities, never old graph semantic text.
  const targets: Target[] = [{ ...params.target, fingerprint, manifestId: current.id, recipeManifestId }];
  const manifests = await tx.artifactInputLineage.findMany({ where: { workspaceId, artifactType: { in: TARGET_KINDS } },
    orderBy: { revision: "desc" }, take: LIMIT + 1, select: { id: true, artifactType: true, artifactId: true, contentHash: true, origin: true } });
  invariant(manifests.length <= LIMIT, 503, "INPUT_SCAN_LIMIT", "Graph cohort dependency collection is too large.");
  const visited = new Set<string>([JSON.stringify([params.target.kind, params.target.id])]);
  for (const manifest of manifests) {
    if (!targetKind(manifest.artifactType)) continue;
    const key = JSON.stringify([manifest.artifactType, manifest.artifactId]);
    if (visited.has(key)) continue; visited.add(key);
    let originalId = manifest.id;
    if (manifest.origin === "UNKNOWN") {
      const state = await tx.derivedArtifactRebuildState.findFirst({ where: { workspaceId, targetKind: manifest.artifactType,
        targetId: manifest.artifactId, targetFingerprint: manifest.contentHash, state: { in: ["REBUILD_REQUIRED", "CANDIDATE_READY"] } }, orderBy: { updatedAt: "desc" } });
      if (!state) continue; originalId = state.targetManifestId;
    } else if (manifest.origin !== "DERIVED") continue;
    const other = { kind: manifest.artifactType, id: manifest.artifactId };
    const ancestry = await inspectStoredArtifactInputDependencyIdentities(tx, workspaceId, other, originalId);
    if (!ancestry.complete || dependencyKey(ancestry.dependencies) !== cohortKey) continue;
    const otherRow = await targetRow(tx, workspaceId, other);
    if (!otherRow || lineageContentFingerprint(other.kind, otherRow) !== manifest.contentHash) continue;
    targets.push({ ...other, fingerprint: manifest.contentHash, manifestId: manifest.id, recipeManifestId: originalId });
  }
  targets.sort((a, b) => JSON.stringify([a.kind, a.id]).localeCompare(JSON.stringify([b.kind, b.id])));
  const additional = [{ kind: "Workspace" as const, id: workspaceId }, { kind: "Member" as const, id: member.id }, { kind: "User" as const, id: actor.user.id },
    ...(params.scope.kind === "view" ? [{ kind: "ContextMapView" as const, id: params.scope.mapViewId }] : []),
    ...requestRoots.map(({ kind, id }) => ({ kind, id }))];
  const inputs = await preparePermittedDerivationInputs(tx, actor, workspaceId, discovery.dependencies, targets, additional);
  if (!inputs) return null;
  for (const target of targets) {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(`"${target.kind}"`)} WHERE id = ${target.id} AND "workspaceId" = ${workspaceId} FOR UPDATE`);
  }
  await assertArtifactInputWriteFence(tx);
  for (const target of targets) {
    const locked = await targetRow(tx, workspaceId, target);
    const lockedManifest = await tx.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: target.kind, artifactId: target.id }, orderBy: { revision: "desc" } });
    invariant(locked && lineageContentFingerprint(target.kind, locked) === target.fingerprint && lockedManifest?.id === target.manifestId,
      409, "SOURCE_CHANGED", "Graph target changed while preparing inputs.");
  }
  const targetEpochs = await captureArtifactPermissionEpochs(actor, workspaceId, targets.map(target => ({ kind: target.kind, id: target.id, fingerprint: target.fingerprint })), tx);
  const sourceState = { archiveStates: inputs.archiveStates, permissionEpochs: inputs.permissionEpochs, targetEpochs };
  const inputSetHash = derivationHash([1, derivationRootSignature(inputs.roots), inputs.sourceIdentities, sourceState, targets, cohortKey,
    graphVariantScopeKey(params.scope), mode, GRAPH_SOURCE_VARIANT_GENERATOR_VERSION, GRAPH_SOURCE_VARIANT_INSTRUCTION_HASH]);
  return { inputs, recipe: { version: 1, memberId: member.id, userId: actor.user.id, requestRoots, target: params.target, targets, scope: params.scope,
    mode, deletionEventId: params.deletionEventId ?? null, cohortKey, targetFingerprint: fingerprint, inputSetHash,
    sources: inputs.sourceIdentities, sourceState, generatorVersion: GRAPH_SOURCE_VARIANT_GENERATOR_VERSION, instructionHash: GRAPH_SOURCE_VARIANT_INSTRUCTION_HASH } };
}

/** Validate against the actual captured prompt sources; all graph identities are fresh. */
export function createGraphVariantBundle(value: unknown, sources: readonly PermittedDerivationSource[]): GraphVariantBundle {
  invariant(record(value) && Array.isArray(value.objects) && value.objects.length > 0 && value.objects.length <= 200
    && Array.isArray(value.relationships) && value.relationships.length <= 300 && Array.isArray(value.evidenceRefs) && value.evidenceRefs.length <= 500,
  422, "INVALID_CANDIDATE", "Graph candidate is invalid.");
  const candidate = value as unknown as GraphVariantCandidate;
  const refs = new Map<string, string>();
  const relationRefs = new Map<string, string>();
  const exactKeys = (item: unknown, allowed: string[]) => record(item) && Object.keys(item).every(key => allowed.includes(key));
  const ref = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
  const bounded = (value: unknown, max: number) => typeof value === "string" && value.length <= max;
  const fields = (item: Fields) => {
    invariant((item.properties === undefined || (record(item.properties) && JSON.stringify(item.properties).length <= 20000))
      && (item.confidence === undefined || (typeof item.confidence === "number" && Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1)),
    422, "INVALID_CANDIDATE", "Graph properties are invalid.");
    return { ...(item.properties ? { properties: item.properties } : {}), ...(item.confidence !== undefined ? { confidence: item.confidence } : {}) };
  };
  const objects = candidate.objects.map(item => {
    invariant(exactKeys(item, ["ref", "objectType", "title", "summary", "properties", "confidence"]) && ref(item.ref) && !refs.has(item.ref)
      && GRAPH_VARIANT_OBJECT_TYPES.includes(item.objectType) && bounded(item.title, 300) && item.title.trim().length > 0
      && (item.summary === undefined || bounded(item.summary, 20000)), 422, "INVALID_CANDIDATE", "Graph object is invalid.");
    const id = randomUUID(); refs.set(item.ref, id);
    return { id, objectType: item.objectType, title: item.title.trim(), summary: item.summary ?? null, status: "proposed" as const, ...fields(item) };
  });
  const relationships = candidate.relationships.map(item => {
    invariant(exactKeys(item, ["ref", "sourceRef", "targetRef", "relationshipType", "properties", "confidence"]) && ref(item.ref)
      && !relationRefs.has(item.ref) && refs.has(item.sourceRef) && refs.has(item.targetRef)
      && GRAPH_VARIANT_RELATIONSHIP_TYPES.includes(item.relationshipType), 422, "INVALID_CANDIDATE", "Graph relationship is invalid.");
    const id = randomUUID(); relationRefs.set(item.ref, id);
    return { id, sourceObjectId: refs.get(item.sourceRef)!, targetObjectId: refs.get(item.targetRef)!, relationshipType: item.relationshipType,
      status: "proposed" as const, ...fields(item) };
  });
  const evidenceRefs = candidate.evidenceRefs.map(item => {
    const source = sources.find(source => source.kind === item.sourceKind && source.id === item.sourceId);
    invariant(exactKeys(item, ["objectRef", "relationshipRef", "sourceKind", "sourceId", "quote", "relevanceScore", "metadata"])
      && Boolean(item.objectRef) !== Boolean(item.relationshipRef) && (!item.objectRef || refs.has(item.objectRef))
      && (!item.relationshipRef || relationRefs.has(item.relationshipRef)) && source
      && (item.quote === undefined || (bounded(item.quote, 12000) && source.content.includes(item.quote)))
      && (item.relevanceScore === undefined || (Number.isFinite(item.relevanceScore) && item.relevanceScore >= 0 && item.relevanceScore <= 1))
      && (item.metadata === undefined || (record(item.metadata) && JSON.stringify(item.metadata).length <= 20000)),
    422, "INVALID_CANDIDATE", "Graph evidence is invalid.");
    return { id: randomUUID(), objectId: item.objectRef ? refs.get(item.objectRef)! : null,
      relationshipId: item.relationshipRef ? relationRefs.get(item.relationshipRef)! : null,
      sourceType: item.sourceKind, sourceId: item.sourceId, quote: item.quote ?? null, relevanceScore: item.relevanceScore ?? null, metadata: item.metadata ?? {} };
  });
  invariant(exactKeys(candidate, ["objects", "relationships", "evidenceRefs", "reason"]) && (candidate.reason === undefined || bounded(candidate.reason, 10000)),
    422, "INVALID_CANDIDATE", "Graph candidate contains unsupported operations.");
  return { version: 1, objects, relationships, evidenceRefs, proposedDiff: { id: randomUUID(), status: "pending",
    reason: candidate.reason?.trim() || "Fresh graph proposal from currently permitted sources.", diffJson: { objects, relationships, evidenceRefs } } };
}

async function variantReadable(tx: Prisma.TransactionClient, actor: UserActor, workspaceId: string, variant: GenericDerivedArtifactVariant, current?: Prepared) {
  const stored = payload(variant.scopeJson);
  if (variant.recipeVersion !== stored.version || variant.generatorVersion !== stored.generatorVersion
    || variant.instructionHash !== stored.instructionHash || variant.targetKind !== stored.target.kind || variant.targetId !== stored.target.id
    || derivationHash(variant.targetsJson) !== derivationHash(stored.targets) || derivationHash(variant.sourceStateJson) !== derivationHash(stored.sourceState)) return null;
  const prepared = current && current.recipe.target.kind === stored.target.kind && current.recipe.target.id === stored.target.id
    ? current : await prepare(tx, actor, workspaceId, { target: stored.target, scope: stored.scope, mode: stored.mode,
    ...(stored.deletionEventId ? { deletionEventId: stored.deletionEventId } : {}), requestRoots: stored.requestRoots });
  if (!prepared || typeof prepared === "string" || variant.ownerMemberId !== prepared.recipe.memberId || variant.inputSetHash !== prepared.recipe.inputSetHash
    || variant.targetFingerprint !== prepared.recipe.targetFingerprint || !sameRecipe(prepared.recipe, stored)) return null;
  const roots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "GenericDerivedArtifactVariant", id: variant.id, snapshot: variant }], tx);
  return { id: variant.id, ownerMemberId: variant.ownerMemberId, createdAt: variant.createdAt, cohortKey: prepared.recipe.cohortKey,
    targets: prepared.recipe.targets, scope: prepared.recipe.scope, bundle: variant.payloadJson as unknown as GraphVariantBundle, roots };
}
async function ownerActor(tx: Prisma.TransactionClient, workspaceId: string, recipe: Recipe): Promise<UserActor> {
  const member = await tx.member.findFirst({ where: { id: recipe.memberId, workspaceId, userId: recipe.userId, isActive: true }, include: { user: true } });
  invariant(member?.user, 403, "NOT_A_MEMBER", "Variant owner is no longer active.");
  return { kind: "user", user: member.user };
}
async function prior(tx: Prisma.TransactionClient, workspaceId: string, recipe: Recipe) {
  return tx.genericDerivedArtifactVariant.findFirst({ where: { workspaceId, generatorKey: GRAPH_SOURCE_VARIANT_JOB_TYPE,
    ownerMemberId: recipe.memberId, inputSetHash: recipe.inputSetHash } });
}

export async function requestGraphSourceVariant(actor: AppActor, params: { workspaceId: string; target: { kind: GraphTargetKind; id: string };
  scope: GraphVariantScope; mode?: GraphVariantMode; deletionEventId?: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  if (actor.kind !== "user") return { status: "UNAVAILABLE" as const, reason: "REBUILD_INPUTS_UNPROVEN" as const };
  return prisma.$transaction(async tx => {
    await lockWorkspaceMembership(tx, params.workspaceId);
    try {
      const prepared = await prepare(tx, actor, params.workspaceId, { ...params, requestRoots: getMcpToolInputRoots(actor, params.workspaceId) });
      if (!prepared) return { status: "UNAVAILABLE" as const, reason: "REBUILD_INPUTS_UNPROVEN" as const };
      if (prepared === "ORIGINAL") return { status: "NOT_NEEDED" as const };
      const existing = await prior(tx, params.workspaceId, prepared.recipe);
      if (existing) return await variantReadable(tx, actor, params.workspaceId, existing, prepared)
        ? { status: "READY" as const, variantId: existing.id } : { status: "UNAVAILABLE" as const, reason: "REBUILD_INPUTS_UNPROVEN" as const };
      const dedupeKey = `graph-source-variant:v1:${params.workspaceId}:${prepared.recipe.memberId}:${prepared.recipe.cohortKey}:${prepared.recipe.inputSetHash}`;
      const previous = await tx.workflowJob.findUnique({ where: { dedupeKey } });
      if (previous) {
        if (["FAILED", "COMPLETED"].includes(previous.status) || payload(previous.payload).phase === "STALE") {
          await tx.workflowJob.update({ where: { id: previous.id }, data: { status: "PENDING", payload: json({ ...prepared.recipe, phase: "REQUESTED" }),
            lockedAt: null, lockedBy: null, completedAt: null, error: null, runAfter: new Date() } });
        }
        return { status: "QUEUED" as const, jobId: previous.id };
      }
      const job = await tx.workflowJob.create({ data: { workspaceId: params.workspaceId, type: GRAPH_SOURCE_VARIANT_JOB_TYPE,
        dedupeKey, payload: json({ ...prepared.recipe, phase: "REQUESTED" }) } });
      return { status: "QUEUED" as const, jobId: job.id };
    } catch (error) { if (stale(error)) return { status: "UNAVAILABLE" as const, reason: "REBUILD_INPUTS_UNPROVEN" as const }; throw error; }
  }, TX_OPTIONS);
}

/** Internal DTO only. Targets/cohort metadata must never be emitted to clients. */
export async function getReadableGraphSourceVariants(actor: AppActor, params: { workspaceId: string; scope: GraphVariantScope }): Promise<ReadableGraphSourceVariant[]> {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  if (actor.kind !== "user") return [];
  graphVariantScopeKey(params.scope);
  return prisma.$transaction(async tx => {
    await lockWorkspaceMembership(tx, params.workspaceId);
    const member = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, tx });
    if (!member?.isActive) return [];
    const rows = await tx.genericDerivedArtifactVariant.findMany({ where: { workspaceId: params.workspaceId, ownerMemberId: member.id,
      generatorKey: GRAPH_SOURCE_VARIANT_JOB_TYPE }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: LIMIT + 1 });
    invariant(rows.length <= LIMIT, 503, "SOURCE_READ_SCAN_LIMIT", "Graph variant collection is too large.");
    const output: ReadableGraphSourceVariant[] = []; const cohorts = new Set<string>();
    for (const row of rows) {
      try {
        const scope = (row.scopeJson as unknown as Recipe).scope;
        if (graphVariantScopeKey(scope) !== graphVariantScopeKey(params.scope)) continue;
        const admitted = await variantReadable(tx, actor, params.workspaceId, row);
        if (!admitted || cohorts.has(admitted.cohortKey)) continue;
        cohorts.add(admitted.cohortKey); output.push(admitted);
      } catch (error) { if (!stale(error)) throw error; }
    }
    return output;
  }, TX_OPTIONS);
}
export async function revalidateGraphSourceVariants(actor: AppActor, params: { workspaceId: string; variantIds: string[] }): Promise<boolean> {
  if (actor.kind !== "user" || params.variantIds.length > LIMIT) return false;
  return prisma.$transaction(async tx => {
    await lockWorkspaceMembership(tx, params.workspaceId);
    try {
      for (const id of new Set(params.variantIds)) {
        const row = await tx.genericDerivedArtifactVariant.findFirst({ where: { id, workspaceId: params.workspaceId, generatorKey: GRAPH_SOURCE_VARIANT_JOB_TYPE } });
        if (!row || !await variantReadable(tx, actor, params.workspaceId, row)) return false;
      }
      return true;
    } catch (error) { if (stale(error)) return false; throw error; }
  }, TX_OPTIONS);
}

export async function generateGraphSourceVariant(params: { workspaceId: string; jobId: string; expectedAttempt: number; expectedOwner: string;
  generate: (sources: PermittedDerivationSource[], anchors: readonly never[], scope: GraphVariantScope) => Promise<GraphVariantCandidate> }): Promise<GraphSourceVariantGenerationResult> {
  invariant(Number.isInteger(params.expectedAttempt) && params.expectedAttempt > 0 && params.expectedOwner?.trim(), 400, "INVALID_INPUT", "An actual worker lease is required.");
  const claim: GenerationClaim = await prisma.$transaction(async tx => {
    await lockWorkspaceMembership(tx, params.workspaceId);
    await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${params.jobId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const job = await tx.workflowJob.findFirst({ where: { id: params.jobId, workspaceId: params.workspaceId, type: GRAPH_SOURCE_VARIANT_JOB_TYPE } });
    invariant(job, 404, "NOT_FOUND", "Graph variant job not found.");
    if (job.status !== "RUNNING" || job.attempts !== params.expectedAttempt || job.lockedBy !== params.expectedOwner) return { phase: "SUPERSEDED" as const };
    const recipe = payload(job.payload);
    const invalidate = async () => { await tx.workflowJob.update({ where: { id: job.id }, data: { payload: json({ ...recipe, phase: "STALE" }) } }); return { phase: "STALE" as const }; };
    if (recipe.phase === "STALE") return { phase: "STALE" as const };
    try {
      const actor = await ownerActor(tx, params.workspaceId, recipe);
      const prepared = await prepare(tx, actor, params.workspaceId, { target: recipe.target, scope: recipe.scope, mode: recipe.mode,
        ...(recipe.deletionEventId ? { deletionEventId: recipe.deletionEventId } : {}), requestRoots: recipe.requestRoots });
      if (!prepared || typeof prepared === "string" || !sameRecipe(prepared.recipe, recipe)) return invalidate();
      const existing = await prior(tx, params.workspaceId, recipe);
      if (existing) return await variantReadable(tx, actor, params.workspaceId, existing, prepared)
        ? { phase: "APPLIED" as const, variantId: existing.id } : invalidate();
      if (recipe.phase === "APPLIED") return invalidate();
      const token = randomUUID();
      await tx.workflowJob.update({ where: { id: job.id }, data: { payload: json({ ...recipe, phase: "GENERATING", generationToken: token }) } });
      return { actor, prepared, token };
    } catch (error) { if (stale(error)) return invalidate(); throw error; }
  }, TX_OPTIONS);
  if ("phase" in claim) return claim;
  const current = await isArtifactInputProofReadable(claim.actor, params.workspaceId, claim.prepared.inputs.roots)
    && await isArtifactPermissionEpochProofCurrent(params.workspaceId, claim.prepared.recipe.sourceState.permissionEpochs)
    && await isArtifactPermissionEpochProofCurrent(params.workspaceId, claim.prepared.recipe.sourceState.targetEpochs);
  const candidate = current ? await params.generate(claim.prepared.inputs.sources, [], claim.prepared.recipe.scope) : null;
  const bundle = candidate ? createGraphVariantBundle(candidate, claim.prepared.inputs.sources) : null;
  return prisma.$transaction(async tx => {
    await lockWorkspaceMembership(tx, params.workspaceId);
    await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${params.jobId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const job = await tx.workflowJob.findFirst({ where: { id: params.jobId, workspaceId: params.workspaceId, type: GRAPH_SOURCE_VARIANT_JOB_TYPE } });
    invariant(job, 404, "NOT_FOUND", "Graph variant job not found.");
    const recipe = payload(job.payload);
    if (job.status !== "RUNNING" || job.attempts !== params.expectedAttempt || job.lockedBy !== params.expectedOwner
      || recipe.phase !== "GENERATING" || recipe.generationToken !== claim.token) return { phase: "SUPERSEDED" as const };
    const invalidate = async () => { await tx.workflowJob.update({ where: { id: job.id }, data: { payload: json({ ...recipe, phase: "STALE" }) } }); return { phase: "STALE" as const }; };
    let contentWriteStarted = false;
    try {
      if (!bundle) return invalidate();
      const actor = await ownerActor(tx, params.workspaceId, recipe);
      const prepared = await prepare(tx, actor, params.workspaceId, { target: recipe.target, scope: recipe.scope, mode: recipe.mode,
        ...(recipe.deletionEventId ? { deletionEventId: recipe.deletionEventId } : {}), requestRoots: recipe.requestRoots });
      if (!prepared || typeof prepared === "string" || !sameRecipe(prepared.recipe, recipe)
        || !sameRecipe(prepared.recipe, claim.prepared.recipe) || !await isArtifactInputProofReadable(actor, params.workspaceId, claim.prepared.inputs.roots, tx)) return invalidate();
      const existing = await prior(tx, params.workspaceId, recipe);
      if (existing) return await variantReadable(tx, actor, params.workspaceId, existing, prepared)
        ? { phase: "APPLIED" as const, variantId: existing.id } : invalidate();
      // From the first content write onward, any failure aborts the entire transaction.
      contentWriteStarted = true;
      const variant = await tx.genericDerivedArtifactVariant.create({ data: { workspaceId: params.workspaceId,
        targetKind: recipe.target.kind, targetId: recipe.target.id, ownerMemberId: recipe.memberId,
        recipeVersion: 1, generatorKey: GRAPH_SOURCE_VARIANT_JOB_TYPE, generatorVersion: recipe.generatorVersion,
        instructionHash: recipe.instructionHash, targetFingerprint: recipe.targetFingerprint, inputSetHash: recipe.inputSetHash,
        sourceStateJson: json(recipe.sourceState), targetsJson: json(recipe.targets),
        scopeJson: json({ ...recipe, phase: "APPLIED" }), payloadJson: json(bundle), generationJobId: job.id } });
      await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId, artifact: { kind: "GenericDerivedArtifactVariant", id: variant.id },
        content: variant, origin: "DERIVED", inputs: [], inheritedRoots: prepared.inputs.roots });
      if (recipe.mode === "CANONICAL_CANDIDATE") {
        await tx.derivedArtifactRebuildState.upsert({ where: { workspaceId_targetKind_targetId_targetManifestId: {
          workspaceId: params.workspaceId, targetKind: recipe.target.kind, targetId: recipe.target.id, targetManifestId: recipe.targets.find(target => target.kind === recipe.target.kind && target.id === recipe.target.id)!.recipeManifestId } },
        create: { workspaceId: params.workspaceId, targetKind: recipe.target.kind, targetId: recipe.target.id,
          targetManifestId: recipe.targets.find(target => target.kind === recipe.target.kind && target.id === recipe.target.id)!.recipeManifestId, targetFingerprint: recipe.targetFingerprint,
          sourceStateJson: json(recipe.sourceState), generationKey: recipe.inputSetHash, state: "CANDIDATE_READY", replacementVariantId: variant.id, eventId: recipe.deletionEventId },
        update: { replacementVariantId: variant.id, state: "CANDIDATE_READY", generationKey: recipe.inputSetHash } });
      }
      await tx.workflowJob.update({ where: { id: job.id }, data: { payload: json({ ...recipe, phase: "APPLIED", variantId: variant.id }) } });
      return { phase: "APPLIED" as const, variantId: variant.id };
    } catch (error) { if (!contentWriteStarted && stale(error)) return invalidate(); throw error; }
  }, TX_OPTIONS);
}
