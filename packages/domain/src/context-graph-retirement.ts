import { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { createHash } from "node:crypto";
import { capturePermissionEpochs } from "./source-permission-epochs";
import { invariant } from "./errors";
import { assertArtifactInputWriteFence, isLineageKind, type LineageKind, type LineageRoot } from "./source-lineage";

export type ContextGraphJobExecution = { attempts: number; expectedLease: { lockedBy: string; lockedAt: Date } };
type Identity = { workspaceId: string; workflowJobId: string; sourceType: string; sourceId: string } & ContextGraphJobExecution;
type ManifestIdentity = { id: string; revision: number; contentHash: string; origin: string };
type RetirementScope = Identity & { jobType: "context-graph.sync" | "context-graph.reconcile"; sourceKind: LineageKind; eventId: string | null };
type RetirementReceipt = Readonly<{ purpose: "GRAPH_SOURCE_RETIREMENT" }>;
const receipts = new WeakMap<RetirementReceipt, RetirementScope>();
const LIMIT = 5000;
const sourceKinds: Record<string, LineageKind> = {
  MEETING: "Meeting", MEMBER: "Member", GOAL: "Goal", AGENT_IDENTITY: "AgentIdentity", BRAIN_ARTICLE: "BrainArticle",
  PROPOSAL: "Proposal", ACTION: "Action", TENSION: "Tension", CIRCLE: "Circle", ROLE: "Role", DOCUMENT: "Document",
};
const sourceEvents: Record<string, readonly string[]> = {
  MEETING: ["meeting.created", "meeting.transcript-uploaded", "meeting.processed-content-updated"],
  MEMBER: ["member.created", "member.updated", "member.deactivated", "member.reactivated", "role.assigned", "role.unassigned"],
  GOAL: ["goal.created", "goal.updated"], AGENT_IDENTITY: ["agent-identity.created", "agent-identity.updated", "agent-identity.deactivated", "agent-identity.circle-assigned", "agent-identity.circle-unassigned"],
  BRAIN_ARTICLE: ["brain-article.created", "brain-article.updated", "brain-article.published"], PROPOSAL: ["proposal.approved", "proposal.opened"],
  ACTION: ["action.created", "action.updated"], TENSION: ["tension.created", "tension.updated"], CIRCLE: ["circle.created", "circle.updated"],
  ROLE: ["role.created", "role.updated"], DOCUMENT: ["document.created", "document.updated"],
};
const manifestSelect = { id: true, revision: true, contentHash: true, origin: true, rootsJson: true } as const;
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function roots(value: unknown): LineageRoot[] | null {
  if (!Array.isArray(value) || value.some(root => !record(root) || !isLineageKind(root.kind)
    || typeof root.id !== "string" || !root.id || typeof root.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(root.fingerprint))) return null;
  return value as LineageRoot[];
}

/** Dependency discovery only: this never grants access to an artifact's content. */
export async function inspectStoredArtifactInputDependencyIdentities(db: Prisma.TransactionClient, workspaceId: string,
  root: { kind: LineageKind; id: string }, expectedManifestId?: string) {
  const hasCapturedEpochs = async (row: { epochProofVersion: number | null; permissionEpochsJson: unknown }) => {
    if (row.epochProofVersion !== 1) return false;
    const { parsePermissionEpochProof } = await import("./source-permission-epochs");
    return Boolean(parsePermissionEpochProof(row.permissionEpochsJson));
  };
  const proofSelect = { ...manifestSelect, epochProofVersion: true, permissionEpochsJson: true } as const;
  const manifest = await db.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: root.kind, artifactId: root.id, ...(expectedManifestId ? { id: expectedManifestId } : {}) },
    orderBy: { revision: "desc" }, select: proofSelect });
  const dependencies = new Map<string, { kind: LineageKind; id: string }>();
  const visited = new Set<string>();
  const visit = async (input: LineageRoot, ancestors: Set<string>, consumedEpochs: unknown): Promise<boolean> => {
    const key = `${input.kind}:${input.id}:${input.fingerprint}`;
    if (ancestors.has(key) || visited.size + ancestors.size >= LIMIT) return false;
    if (visited.has(key)) return true;
    dependencies.set(`${input.kind}:${input.id}`, { kind: input.kind, id: input.id });
    let origin: string; let inputs: LineageRoot[] | null;
    if (input.kind === "ArtifactInputSnapshot") {
      // Immutable snapshot metadata is system-written. Reading it proves ancestry only,
      // never the body, its current permission, or the content fingerprint of a DTO.
      const snapshot = await db.artifactInputSnapshot.findFirst({ where: { id: input.id, workspaceId }, select: {
        sourceKind: true, sourceId: true, sourceFingerprint: true, origin: true, rootsJson: true, epochProofVersion: true, permissionEpochsJson: true,
      } });
      if (!snapshot || !await hasCapturedEpochs(snapshot) || !isLineageKind(snapshot.sourceKind) || snapshot.sourceKind === "ArtifactInputSnapshot"
        || !/^[a-f0-9]{64}$/.test(snapshot.sourceFingerprint)) return false;
      dependencies.set(`${snapshot.sourceKind}:${snapshot.sourceId}`, { kind: snapshot.sourceKind as LineageKind, id: snapshot.sourceId });
      if (["MeetingTranscript", "MeetingAgenda"].includes(snapshot.sourceKind)) dependencies.set(`Meeting:${snapshot.sourceId}`, { kind: "Meeting", id: snapshot.sourceId });
      origin = snapshot.origin; inputs = roots(snapshot.rootsJson);
      if (["KnowledgeChunk", "CommunicationMessage", "GenericDerivedArtifactVariant"].includes(snapshot.sourceKind) && origin !== "DERIVED") return false;
      if (origin === "NATIVE_ORIGINAL" && !["NativeTranscriptInput", "CommunicationMessageNativeInput", "ExternalProviderFetchInput", "FinanceReportUploadInput", "CrmQualificationFormInput", "ConversationIngressInput", "McpToolInput"].includes(snapshot.sourceKind)) return false;
    } else {
      const historical = await db.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: input.kind,
        artifactId: input.id, contentHash: input.fingerprint }, orderBy: { revision: "desc" }, select: proofSelect });
      if (!historical && ["NativeTranscriptInput", "CommunicationMessageNativeInput", "ExternalProviderFetchInput"].includes(input.kind)) {
        // These immutable constructor tables are original input receipts, not
        // native authored-body guesses. The consuming known manifest proves
        // they were captured; discovery grants no current owner/provider access.
        const capturedEpochs = input.permissionEpochs !== undefined ? input.permissionEpochs : consumedEpochs;
        if (!record(capturedEpochs)) return false;
        const native = input.kind === "NativeTranscriptInput"
          ? await db.nativeTranscriptInput.findFirst({ where: { id: input.id, workspaceId } })
          : input.kind === "CommunicationMessageNativeInput"
            ? await db.communicationMessageNativeInput.findFirst({ where: { id: input.id, workspaceId } })
            : await db.externalProviderFetchInput.findFirst({ where: { id: input.id, workspaceId } });
        if (!native || native.workspaceId !== workspaceId || native.id !== input.id) return false;
        if (input.kind === "NativeTranscriptInput") {
          const transcript = native as { mode: string; ownerMemberId: string; submittedByUserId: string; encryptedPayloadJson: string; payloadHash: string };
          if (!["DIRECT_MEMBER_UPLOAD", "AUDIO_UPLOAD"].includes(transcript.mode) || !transcript.ownerMemberId || !transcript.submittedByUserId
            || typeof transcript.encryptedPayloadJson !== "string" || !transcript.encryptedPayloadJson || !/^[a-f0-9]{64}$/.test(transcript.payloadHash)) return false;
        } else if (input.kind === "CommunicationMessageNativeInput") {
          const message = native as { mode: string; provider: string; installationId: string; communicationMessageId: string; encryptedPayloadJson: string; projectionHash: string };
          if (message.mode !== "AUTHENTICATED_FETCH" || message.provider !== "SLACK" || !message.installationId || !message.communicationMessageId
            || typeof message.encryptedPayloadJson !== "string" || !message.encryptedPayloadJson || !/^[a-f0-9]{64}$/.test(message.projectionHash)) return false;
        } else {
          const fetch = native as Record<string, unknown>;
          if (fetch.providerKey !== "box" || fetch.serverUrl !== "https://mcp.box.com"
            || ["externalContentSourceId", "connectionId", "localUserId", "providerAccountId", "externalId", "encryptedResponseJson"].some(field =>
              typeof fetch[field] !== "string" || !fetch[field])
            || typeof fetch.responseHash !== "string" || !/^[a-f0-9]{64}$/.test(fetch.responseHash)
            || typeof fetch.connectionGrantHash !== "string" || !/^[a-f0-9]{64}$/.test(fetch.connectionGrantHash)
            || !record(fetch.requestJson)) return false;
          // This mirrors the constructor's native read binding without loading
          // transport code, decrypting content, or granting current access.
          const request = fetch.requestJson;
          const binding = fetch.sourceKind === "FILE" ? { key: "file_id", tools: ["get_file_details", "get_file_content"] }
            : fetch.sourceKind === "FOLDER" ? { key: "folder_id", tools: ["get_folder_details", "list_folder_content_by_folder_id"] }
              : fetch.sourceKind === "HUB" ? { key: "hub_id", tools: ["get_hub_details", "get_hub_items"] } : null;
          if (!binding || typeof fetch.toolName !== "string" || !binding.tools.includes(fetch.toolName)
            || request[binding.key] !== fetch.externalId || Object.keys(request).some(field => ![binding.key, "fields", "limit"].includes(field))) return false;
        }
        const { parsePermissionEpochProof } = await import("./source-permission-epochs");
        const epochProof = parsePermissionEpochProof(capturedEpochs);
        if (!epochProof || !epochProof.entries.some(entry => entry.kind === input.kind && entry.id === input.id)) return false;
        const { lineageContentFingerprint } = await import("./source-lineage");
        if (lineageContentFingerprint(input.kind, native) !== input.fingerprint) return false;
        visited.add(key); return true;
      }
      if (!historical || historical.origin === "NATIVE_ORIGINAL" || (historical.origin === "DERIVED" && !await hasCapturedEpochs(historical))) return false;
      origin = historical.origin; inputs = roots(historical.rootsJson);
      consumedEpochs = historical.epochProofVersion === 1 ? historical.permissionEpochsJson : null;
    }
    if (!inputs || !["HUMAN_ORIGINAL", "NATIVE_ORIGINAL", "DERIVED"].includes(origin)
      || (origin === "DERIVED" && !inputs.length) || (origin !== "DERIVED" && inputs.length)) return false;
    for (const upstream of inputs) if (!await visit(upstream, new Set(ancestors).add(key), consumedEpochs)) return false;
    visited.add(key); return true;
  };
  const inputs = manifest && roots(manifest.rootsJson);
  let complete = Boolean(manifest && /^[a-f0-9]{64}$/.test(manifest.contentHash) && inputs && manifest.origin === "DERIVED" && inputs.length
    && await hasCapturedEpochs(manifest));
  if (complete) for (const input of inputs!) if (!await visit(input, new Set(), manifest?.epochProofVersion === 1 ? manifest.permissionEpochsJson : null)) { complete = false; break; }
  return { complete, dependencies: [...dependencies.values()], manifestIdentity: manifest ? {
    id: manifest.id, revision: manifest.revision, contentHash: manifest.contentHash, origin: manifest.origin,
  } satisfies ManifestIdentity : null };
}

/** Append a denial marker, preserving every historical manifest and body. */
async function invalidateStoredArtifactInputLineage(tx: Prisma.TransactionClient, workspaceId: string,
  kind: LineageKind, id: string, expected: ManifestIdentity) {
  await assertArtifactInputWriteFence(tx);
  const current = await tx.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: kind, artifactId: id }, orderBy: { revision: "desc" }, select: manifestSelect });
  invariant(current && current.id === expected.id && current.revision === expected.revision && current.origin === "DERIVED",
    409, "SOURCE_CHANGED", "Graph provenance changed before retirement.");
  await tx.artifactInputLineage.create({ data: { workspaceId, artifactType: kind, artifactId: id,
    revision: current.revision + 1, origin: "UNKNOWN", contentHash: current.contentHash, inputsJson: [], rootsJson: [] } });
}

export async function assertContextGraphJobLease(tx: Prisma.TransactionClient, params: {
  workspaceId: string; workflowJobId: string; type: "context-graph.sync" | "context-graph.reconcile";
} & ContextGraphJobExecution) {
  const lease = params.expectedLease;
  invariant(lease?.lockedBy && lease.lockedAt instanceof Date && Number.isFinite(lease.lockedAt.valueOf()),
    409, "GRAPH_JOB_LEASE_REQUIRED", "The graph worker lease is unavailable.");
  await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${params.workflowJobId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
  const job = await tx.workflowJob.findFirst({ where: { id: params.workflowJobId, workspaceId: params.workspaceId } });
  invariant(job && job.type === params.type && job.status === "RUNNING" && job.attempts === params.attempts
    && job.lockedBy === lease.lockedBy && job.lockedAt?.valueOf() === lease.lockedAt.valueOf(),
  409, "GRAPH_JOB_LEASE_CHANGED", "The graph worker lease changed.");
  return job;
}

async function assertRetirementScope(tx: Prisma.TransactionClient, identity: Identity) {
  const job = await assertContextGraphJobLease(tx, { ...identity, type: "context-graph.sync" });
  invariant(sourceKinds[identity.sourceType] && record(job.payload) && job.payload.sourceType === identity.sourceType
    && job.payload.sourceId === identity.sourceId, 409, "GRAPH_RETIREMENT_SCOPE_CHANGED", "Graph job source scope changed.");
  if (job.dependsOnJobId) {
    const parent = await tx.workflowJob.findFirst({ where: { id: job.dependsOnJobId, workspaceId: identity.workspaceId },
      select: { id: true, type: true, status: true, eventId: true, payload: true, dedupeKey: true } });
    if (parent?.type === "context-graph.reconcile") {
      invariant(parent.status === "COMPLETED" && parent.eventId === job.eventId && record(parent.payload)
        && typeof parent.payload.dateISO === "string" && job.dedupeKey === `${identity.workspaceId}:context-graph-reconcile:${identity.sourceType}:${identity.sourceId}:${parent.payload.dateISO}`,
      409, "GRAPH_RETIREMENT_SCOPE_CHANGED", "Graph reconciliation scope changed.");
      return job;
    }
  }
  const event = job.eventId && await tx.event.findFirst({ where: { id: job.eventId, workspaceId: identity.workspaceId },
    select: { id: true, type: true, aggregateType: true, aggregateId: true, payload: true } });
  const key = identity.sourceType === "BRAIN_ARTICLE" ? "articleId" : identity.sourceType === "AGENT_IDENTITY" ? "agentIdentityId" : `${sourceKinds[identity.sourceType].charAt(0).toLowerCase()}${sourceKinds[identity.sourceType].slice(1)}Id`;
  invariant(event && sourceEvents[identity.sourceType]?.includes(event.type) && record(event.payload)
    && (event.payload[key] === identity.sourceId || (identity.sourceType === "PROPOSAL" && event.payload.subjectId === identity.sourceId))
    && job.dedupeKey === `${event.id}:context-graph-sync:${identity.sourceType}:${identity.sourceId}`,
  409, "GRAPH_RETIREMENT_SCOPE_CHANGED", "Graph event source scope changed.");
  return job;
}

async function retireWithReceipt(receipt: RetirementReceipt): Promise<void> {
  await prisma.$transaction(async tx => {
    const scope = receipts.get(receipt);
    invariant(scope, 409, "GRAPH_RETIREMENT_SCOPE_CHANGED", "Graph retirement authority is unavailable.");
    if (scope.jobType === "context-graph.sync") await assertRetirementScope(tx, scope);
    else {
      const current = await reconcileRetirementScope(tx, scope);
      invariant(current && current.sourceKind === scope.sourceKind && current.sourceId === scope.sourceId
        && current.eventId === scope.eventId, 409, "GRAPH_RETIREMENT_SCOPE_CHANGED", "Graph source event changed.");
    }
    const families = [
      { kind: "ContextGraphObject" as const, table: "ContextGraphObject", list: () => tx.contextGraphObject.findMany({ where: { workspaceId: scope.workspaceId }, select: { id: true }, take: LIMIT + 1 }) },
      { kind: "ContextGraphRelationship" as const, table: "ContextGraphRelationship", list: () => tx.contextGraphRelationship.findMany({ where: { workspaceId: scope.workspaceId }, select: { id: true }, take: LIMIT + 1 }) },
      { kind: "ContextGraphEvidenceRef" as const, table: "ContextGraphEvidenceRef", list: () => tx.contextGraphEvidenceRef.findMany({ where: { workspaceId: scope.workspaceId }, select: { id: true }, take: LIMIT + 1 }) },
      { kind: "ContextGraphProposedDiff" as const, table: "ContextGraphProposedDiff", list: () => tx.contextGraphProposedDiff.findMany({ where: { workspaceId: scope.workspaceId }, select: { id: true }, take: LIMIT + 1 }) },
    ];
    for (const family of families) {
      const rows = await family.list();
      invariant(rows.length <= LIMIT, 409, "SOURCE_READ_SCAN_LIMIT", "Graph retirement requires a bounded reconciliation.");
      for (const row of rows) {
        // Table names are fixed in the family allowlist, never caller-controlled.
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM ${Prisma.raw(`"${family.table}"`)} WHERE id = ${row.id} AND "workspaceId" = ${scope.workspaceId} FOR UPDATE`);
        if (locked.length !== 1) continue;
        const proof = await inspectStoredArtifactInputDependencyIdentities(tx, scope.workspaceId, { kind: family.kind, id: row.id });
        if (!proof.complete || !proof.manifestIdentity || !proof.dependencies.some(input => input.kind === scope.sourceKind && input.id === scope.sourceId)) continue;
        // No current body/status/approval is read or overwritten. UNKNOWN is a denial
        // marker for this consumed revision, not a receipt attesting the current row.
        const permissionEpochs = await capturePermissionEpochs(tx, scope.workspaceId,
          [{ kind: "Workspace", id: scope.workspaceId }, ...proof.dependencies.filter(input => input.kind !== "ArtifactInputSnapshot")]);
        const generationKey = createHash("sha256").update(JSON.stringify([scope.workspaceId, family.kind, row.id,
          proof.manifestIdentity.id, scope.eventId, permissionEpochs])).digest("hex");
        await tx.derivedArtifactRebuildState.upsert({ where: { workspaceId_targetKind_targetId_targetManifestId: {
          workspaceId: scope.workspaceId, targetKind: family.kind, targetId: row.id, targetManifestId: proof.manifestIdentity.id,
        } }, create: { workspaceId: scope.workspaceId, targetKind: family.kind, targetId: row.id,
          targetManifestId: proof.manifestIdentity.id, targetFingerprint: proof.manifestIdentity.contentHash,
          sourceStateJson: { permissionEpochs } as unknown as Prisma.InputJsonValue, generationKey,
          state: "REBUILD_REQUIRED", eventId: scope.eventId,
        }, update: {} });
        await invalidateStoredArtifactInputLineage(tx, scope.workspaceId, family.kind, row.id, proof.manifestIdentity);
      }
    }
  }, { maxWait: 5_000, timeout: 120_000 });
}

/** Only a live source-bound worker can retire unreadable DERIVED facts. No content is returned. */
export async function retireContextGraphSourceDescendants(identity: Identity): Promise<void> {
  const receipt: RetirementReceipt = Object.freeze({ purpose: "GRAPH_SOURCE_RETIREMENT" });
  const job = await prisma.$transaction(tx => assertRetirementScope(tx, identity));
  receipts.set(receipt, { ...identity, sourceKind: sourceKinds[identity.sourceType], jobType: "context-graph.sync", eventId: job?.eventId ?? null,
    expectedLease: { ...identity.expectedLease, lockedAt: new Date(identity.expectedLease.lockedAt) } });
  await retireWithReceipt(receipt);
}

type ReconcileIdentity = { workspaceId: string; workflowJobId: string } & ContextGraphJobExecution;
async function reconcileRetirementScope(tx: Prisma.TransactionClient, identity: ReconcileIdentity): Promise<RetirementScope | null> {
  const job = await assertContextGraphJobLease(tx, { ...identity, type: "context-graph.reconcile" });
  if (!job.eventId) return null;
  const event = await tx.event.findFirst({ where: { id: job.eventId, workspaceId: identity.workspaceId },
    select: { id: true, type: true, aggregateType: true, aggregateId: true, payload: true } });
  if (!event || event.type !== "source-lineage.changed") return null;
  const kinds = ["BrainSource", "BrainArticle", "Document", "Meeting", "MeetingInsight", "Action", "Tension", "Proposal", "Goal", "Member", "Role", "Circle", "AgentIdentity"];
  invariant(event.aggregateType && kinds.includes(event.aggregateType) && event.aggregateId && record(event.payload)
    && ((event.payload.kind === event.aggregateType && event.payload.id === event.aggregateId)
      || (event.payload.entityType === event.aggregateType && event.payload.entityId === event.aggregateId))
    && record(job.payload) && job.payload.dateISO === `rebuild:${event.id}`
    && job.dedupeKey === `${identity.workspaceId}:source-lineage-rebuild:${event.id}:native-graph`,
  409, "GRAPH_RETIREMENT_SCOPE_CHANGED", "Graph source event scope changed.");
  return { ...identity, sourceType: event.aggregateType, sourceKind: event.aggregateType as LineageKind,
    sourceId: event.aggregateId, jobType: "context-graph.reconcile", eventId: event.id };
}

/** Event-bound retirement also reaches sources no longer present in native tables. */
export async function retireContextGraphChangedSourceDescendants(identity: ReconcileIdentity): Promise<void> {
  const scope = await prisma.$transaction(tx => reconcileRetirementScope(tx, identity));
  if (!scope) return;
  const receipt: RetirementReceipt = Object.freeze({ purpose: "GRAPH_SOURCE_RETIREMENT" });
  receipts.set(receipt, { ...scope, expectedLease: { ...scope.expectedLease, lockedAt: new Date(scope.expectedLease.lockedAt) } });
  await retireWithReceipt(receipt);
}
