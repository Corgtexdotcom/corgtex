import { createHash } from "node:crypto";
import { DigestReadRelease } from "./digest-lineage";
import { Prisma, type ContextGraphObject, type ContextGraphRelationship, type ContextGraphEvidenceRef, type ContextGraphProposedDiff } from "@prisma/client";
import { GRAPH_SOURCE_VARIANT_JOB_TYPE, captureGraphReviewApproval, getReadableGraphSourceVariants, requestGraphSourceVariant, revalidateGraphSourceVariants, type GraphTargetKind, type GraphVariantScope } from "./derived-artifact-variants";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireAgentScope } from "./agent-auth";
import { requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { invariant } from "./errors";
import { getMcpToolInputRoots } from "./mcp-tool-input-context";
import { prepareArtifactCommitPreflight, withArtifactCommitPreflight } from "./artifact-commit-preflight";
import {
  currentArtifactInputRoots,
  currentArtifactInputRootsBatch,
  captureArtifactInputProof,
  captureImmutableArtifactInputProof,
  advanceHumanArtifactInputLineage,
  isArtifactInputProofReadable,
  preserveUnknownArtifactInputSnapshot,
  invalidateArtifactInputLineage,
  lineageContentFingerprint,
  readableArtifactIds,
  recordArtifactInputLineage,
  type LineageInput,
} from "./source-lineage";

/** Callers must capture every prompt input, including context that is not cited. */
type GraphLineageCapture = {
  lineageInputs?: LineageInput[];
  lineageRoots?: NonNullable<Awaited<ReturnType<typeof currentArtifactInputRoots>>>;
  humanOriginal?: boolean;
};
// A native apply freezes the complete proposal once. Reusing that exact private
// array in the same transaction avoids recursively freezing it for every child;
// each child's normal lineage writer still checks all current source permissions.
const frozenGraphInputs = new WeakMap<object, { tx: Prisma.TransactionClient; actor: AppActor; workspaceId: string }>();

async function readableGraphRecords<T extends { id: string }>(actor: AppActor, workspaceId: string,
  kind: LineageInput["kind"], records: T[], db: Prisma.TransactionClient | typeof prisma = prisma): Promise<T[]> {
  const ids = await readableArtifactIds(actor, workspaceId, kind, records, db);
  return records.filter((record) => ids.has(record.id));
}

function graphSubmissionCapture(actor: AppActor, workspaceId: string, capture: GraphLineageCapture): GraphLineageCapture {
  const submissionRoots = getMcpToolInputRoots(actor, workspaceId);
  return submissionRoots.length ? { ...capture, lineageInputs: capture.lineageInputs ?? [],
    lineageRoots: [...(capture.lineageRoots ?? []), ...submissionRoots] } : capture;
}

async function captureGraphLineage(tx: Prisma.TransactionClient, actor: AppActor, workspaceId: string,
  artifact: LineageInput, content: unknown, capture: GraphLineageCapture,
  previous: unknown | null = null, requiredInputs: LineageInput[] = [], replacesContent = false) {
  capture = graphSubmissionCapture(actor, workspaceId, capture);
  // Absence of an explicit complete input set is unknown, never an empty proof.
  if (capture.lineageInputs === undefined && !capture.humanOriginal) {
    await invalidateArtifactInputLineage({ tx, workspaceId, artifact, content });
    return;
  }
  // Full upserts replace every permission-bearing field. Partial updates must keep
  // prior roots; they cannot turn an unknown legacy record into a clean proof.
  const priorRoots = previous && !replacesContent
    ? await currentArtifactInputRoots(tx, workspaceId, artifact, previous) : [];
  invariant(priorRoots, 409, "UNKNOWN_LINEAGE", "The previous graph content has incomplete lineage.");
  const inputs = [...(capture.lineageInputs ?? []), ...requiredInputs];
  const inheritedRoots = [...priorRoots, ...(capture.lineageRoots ?? [])];
  await recordArtifactInputLineage({ tx, actor, workspaceId, artifact, content,
    origin: capture.humanOriginal && actor.kind === "user" && !inputs.length && !inheritedRoots.length
      ? "HUMAN_ORIGINAL" : "DERIVED", inputs, inheritedRoots,
    transitiveOnlyKinds: artifact.kind !== "ContextGraphProposedDiff" || (isJsonRecord(content) && content.status === "applied")
      ? ["ContextGraphObject", "ContextGraphRelationship", "ContextGraphProposedDiff"] : [],
  });
}

async function preserveGraphHistory(tx: Prisma.TransactionClient, actor: AppActor, workspaceId: string,
  artifact: LineageInput, previous: { id: string }) {
  if ((await readableGraphRecords(actor, workspaceId, artifact.kind, [previous], tx)).length) {
    const roots = await captureArtifactInputProof(actor, workspaceId, [{ ...artifact, snapshot: previous }], tx);
    await captureImmutableArtifactInputProof(actor, workspaceId, roots, tx);
  } else await preserveUnknownArtifactInputSnapshot(tx, workspaceId, artifact, previous);
}

/** Freeze consumed revisions before a graph mutation, then attest the actual saved row. */
async function prepareGraphLineage(tx: Prisma.TransactionClient, actor: AppActor, workspaceId: string,
  capture: GraphLineageCapture, previous?: LineageInput, requiredInputs: LineageInput[] = []) {
  capture = graphSubmissionCapture(actor, workspaceId, capture);
  if (capture.lineageInputs === undefined && !capture.humanOriginal) return capture;
  const roots = await captureArtifactInputProof(actor, workspaceId,
    [...(capture.lineageInputs ?? []), ...requiredInputs, ...(previous ? [previous] : [])], tx);
  const inherited = capture.lineageRoots ?? [];
  const frozen = frozenGraphInputs.get(inherited);
  const reusable = frozen?.tx === tx && frozen.actor === actor && frozen.workspaceId === workspaceId;
  const immutable = reusable
    ? roots.length ? [...inherited, ...await captureImmutableArtifactInputProof(actor, workspaceId, roots, tx)] : inherited
    : await captureImmutableArtifactInputProof(actor, workspaceId, [...roots, ...inherited], tx);
  frozenGraphInputs.set(immutable, { tx, actor, workspaceId });
  return { lineageInputs: [], lineageRoots: immutable, humanOriginal: capture.humanOriginal } satisfies GraphLineageCapture;
}

function graphEvidenceSource(input: ContextGraphEvidenceInput): LineageInput | null {
  const supported = ["BrainSource", "BrainArticle", "Document", "Meeting", "Proposal", "Goal", "CheckIn", "ContextGraphObject", "ContextGraphRelationship"] as const;
  const legacyNames: Record<string, typeof supported[number]> = {
    BRAIN_SOURCE: "BrainSource",
    BRAIN_ARTICLE: "BrainArticle",
    DOCUMENT: "Document",
    MEETING: "Meeting",
    PROPOSAL: "Proposal",
    GOAL: "Goal",
    CHECK_IN: "CheckIn",
  };
  const kind = supported.find((candidate) => candidate === input.sourceType) ?? legacyNames[input.sourceType];
  return kind ? { kind, id: input.sourceId } : null;
}

function graphDiffInputs(diff: ContextGraphDiffInput): LineageInput[] | null {
  const inputs: LineageInput[] = [];
  for (const update of diff.objectUpdates ?? []) inputs.push({ kind: "ContextGraphObject", id: update.id });
  for (const update of diff.relationshipUpdates ?? []) inputs.push({ kind: "ContextGraphRelationship", id: update.id });
  for (const relationship of [...(diff.relationships ?? []), ...(diff.relationshipUpdates ?? [])]) {
    for (const id of [relationship.sourceObjectId, relationship.targetObjectId]) {
      if (id) inputs.push({ kind: "ContextGraphObject", id });
    }
  }
  for (const evidence of diff.evidenceRefs ?? []) {
    const source = graphEvidenceSource(evidence);
    if (!source || evidence.knowledgeChunkId) return null;
    inputs.push(source);
    if (evidence.objectId) inputs.push({ kind: "ContextGraphObject", id: evidence.objectId });
    if (evidence.relationshipId) inputs.push({ kind: "ContextGraphRelationship", id: evidence.relationshipId });
  }
  for (const layout of diff.mapLayoutUpdates ?? []) {
    inputs.push({ kind: "ContextMapView", id: layout.mapViewId });
    for (const item of layout.items) if (item.objectId) inputs.push({ kind: "ContextGraphObject", id: item.objectId });
  }
  return [...new Map(inputs.map((input) => [`${input.kind}:${input.id}`, input])).values()];
}

export const CONTEXT_GRAPH_OBJECT_TYPES = [
  "Person",
  "Team",
  "Role",
  "Process",
  "ProcessStep",
  "Project",
  "Goal",
  "Task",
  "Decision",
  "Document",
  "Meeting",
  "Customer",
  "Tool",
  "Risk",
  "Metric",
  "Policy",
  "Agent",
  "Question",
  "Hypothesis",
  "Evidence",
] as const;

export const CONTEXT_GRAPH_RELATIONSHIP_TYPES = [
  "owns",
  "member_of",
  "reports_to",
  "depends_on",
  "blocks",
  "uses",
  "created_in",
  "decided_in",
  "supports",
  "contradicts",
  "supersedes",
  "assigned_to",
  "needs_approval_from",
  "has_evidence",
  "part_of",
  "input_to",
  "output_of",
] as const;

export const CONTEXT_GRAPH_STATUSES = ["draft", "proposed", "approved", "disputed", "stale", "archived"] as const;
export const CONTEXT_MAP_VIEW_TYPES = ["process", "org", "project", "customer", "agent", "risk", "knowledge", "workshop"] as const;
export const CONTEXT_GRAPH_DIFF_STATUSES = ["pending", "approved", "rejected", "applied"] as const;

export type ContextGraphObjectType = typeof CONTEXT_GRAPH_OBJECT_TYPES[number];
export type ContextGraphRelationshipType = typeof CONTEXT_GRAPH_RELATIONSHIP_TYPES[number];
export type ContextGraphStatus = typeof CONTEXT_GRAPH_STATUSES[number];
export type ContextMapViewType = typeof CONTEXT_MAP_VIEW_TYPES[number];
export type ContextGraphDiffStatus = typeof CONTEXT_GRAPH_DIFF_STATUSES[number];

type JsonRecord = Record<string, unknown>;

type ContextGraphObjectInput = GraphLineageCapture & {
  ref?: string;
  objectType: string;
  title: string;
  summary?: string | null;
  properties?: JsonRecord;
  confidence?: number | null;
  status?: string;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  dedupeKey?: string | null;
  validFrom?: Date | string | null;
  validTo?: Date | string | null;
  lastVerifiedAt?: Date | string | null;
};

type ContextGraphObjectUpdateInput = {
  id: string;
  title?: string;
  summary?: string | null;
  properties?: JsonRecord;
  confidence?: number | null;
  status?: string;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  dedupeKey?: string | null;
  validFrom?: Date | string | null;
  validTo?: Date | string | null;
  lastVerifiedAt?: Date | string | null;
};

type ContextGraphRelationshipInput = GraphLineageCapture & {
  ref?: string;
  sourceObjectId?: string;
  sourceRef?: string;
  targetObjectId?: string;
  targetRef?: string;
  relationshipType: string;
  properties?: JsonRecord;
  confidence?: number | null;
  status?: string;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  dedupeKey?: string | null;
  validFrom?: Date | string | null;
  validTo?: Date | string | null;
  lastVerifiedAt?: Date | string | null;
};

type ContextGraphRelationshipUpdateInput = {
  id: string;
  sourceObjectId?: string;
  targetObjectId?: string;
  relationshipType?: string;
  properties?: JsonRecord;
  confidence?: number | null;
  status?: string;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  dedupeKey?: string | null;
  validFrom?: Date | string | null;
  validTo?: Date | string | null;
  lastVerifiedAt?: Date | string | null;
};

type ContextGraphEvidenceInput = GraphLineageCapture & {
  objectId?: string;
  objectRef?: string;
  relationshipId?: string;
  relationshipRef?: string;
  sourceType: string;
  sourceId: string;
  knowledgeChunkId?: string | null;
  quote?: string | null;
  relevanceScore?: number | null;
  metadata?: JsonRecord;
};

type ContextMapLayoutItemInput = {
  objectId: string;
  x: number;
  y: number;
  width?: number | null;
  height?: number | null;
  visualState?: JsonRecord;
};

type ContextMapProposedLayoutItemInput = {
  objectId?: string;
  objectRef?: string;
  x: number;
  y: number;
  width?: number | null;
  height?: number | null;
  visualState?: JsonRecord;
};

type ContextMapLayoutUpdateInput = {
  mapViewId: string;
  items: ContextMapProposedLayoutItemInput[];
};

type ContextMapImportLayoutItemInput = {
  objectId?: string;
  objectRef?: string;
  x: number;
  y: number;
  width?: number | null;
  height?: number | null;
  visualState?: JsonRecord;
};

const DEFAULT_CONTEXT_MAP_VIEW_CONFIGS: Array<{
  key: "critical-path" | "org-structure" | "agent-governance";
  name: string;
  viewType: ContextMapViewType;
  description: string;
  missingEvidencePrompt: string;
  query: Prisma.InputJsonObject;
}> = [
  {
    key: "critical-path",
    name: "Critical path process map",
    viewType: "process",
    description: "Evidence-backed process, decision, blocker, and ownership facts that explain the current critical path.",
    missingEvidencePrompt: "Upload or answer evidence about current goals, decisions, owners, blockers, handoffs, and process steps before CORGTEX proposes critical-path nodes.",
    query: {
      mode: "criticalPath",
      defaultMapKey: "critical-path",
      evidenceBacked: true,
      objectTypes: ["Goal", "Process", "ProcessStep", "Decision", "Task", "Risk", "Metric", "Question", "Hypothesis", "Tool", "Team", "Role", "Meeting"],
      relationshipTypes: ["part_of", "depends_on", "blocks", "owns", "assigned_to", "supports", "uses", "created_in", "decided_in", "needs_approval_from"],
    },
  },
  {
    key: "org-structure",
    name: "Organization map",
    viewType: "org",
    description: "Evidence-backed teams, roles, people, and reporting or ownership relationships.",
    missingEvidencePrompt: "Upload or answer evidence about teams, roles, people, reporting lines, and ownership before CORGTEX proposes organization nodes.",
    query: {
      mode: "organization",
      defaultMapKey: "org-structure",
      evidenceBacked: true,
      objectTypes: ["Team", "Role", "Person"],
      relationshipTypes: ["part_of", "member_of", "reports_to", "owns", "assigned_to"],
    },
  },
  {
    key: "agent-governance",
    name: "Agent governance map",
    viewType: "agent",
    description: "Evidence-backed agents, tools, policies, risks, approvals, and evidence flows.",
    missingEvidencePrompt: "Connect or upload evidence about active agents, tools, policies, approvals, risks, and evidence flows before CORGTEX proposes agent-governance nodes.",
    query: {
      mode: "agentGovernance",
      defaultMapKey: "agent-governance",
      evidenceBacked: true,
      objectTypes: ["Agent", "Policy", "Tool", "Team", "Role", "Meeting", "Document", "Task", "Decision", "Risk", "Evidence"],
      relationshipTypes: ["input_to", "output_of", "uses", "supports", "needs_approval_from", "created_in", "has_evidence", "blocks", "member_of", "assigned_to"],
    },
  },
];

export type ContextGraphDiffInput = {
  objects?: ContextGraphObjectInput[];
  objectUpdates?: ContextGraphObjectUpdateInput[];
  relationships?: ContextGraphRelationshipInput[];
  relationshipUpdates?: ContextGraphRelationshipUpdateInput[];
  evidenceRefs?: ContextGraphEvidenceInput[];
  mapLayoutUpdates?: ContextMapLayoutUpdateInput[];
};

export type ContextMapChangeProposalResult = {
  mode: "needs_clarification";
  message: string;
} | {
  mode: "proposed";
  proposedDiffId: string;
  reason: string | null;
  status: string;
  createdAt: Date;
  diffJson: unknown;
};

export type ContextMapManualCardKind = "standard" | "alert";
export type ContextMapManualRelationIntent = "enables" | "blocks" | "supports" | "needs_approval_from";

export type ContextMapManualEditInput = {
  action: "add-card";
  cardKind: ContextMapManualCardKind;
  title: string;
  position: { x: number; y: number };
  sourceObjectId?: string | null;
  relationIntent?: ContextMapManualRelationIntent | null;
} | {
  action: "add-connection";
  sourceObjectId: string;
  targetObjectId: string;
  relationIntent: ContextMapManualRelationIntent;
} | {
  action: "update-connection";
  relationshipId: string;
  relationIntent?: ContextMapManualRelationIntent | null;
  archive?: boolean;
} | {
  action: "archive-card";
  objectId: string;
};

export type ContextGraphMapImportInput = {
  name: string;
  viewType?: string | null;
  query?: JsonRecord;
  objects: ContextGraphObjectInput[];
  relationships?: ContextGraphRelationshipInput[];
  evidenceRefs?: ContextGraphEvidenceInput[];
  layoutItems?: ContextMapImportLayoutItemInput[];
  agentRunId?: string | null;
};

export type ContextGraphMapImportResult = {
  mapViewId: string;
  objectCount: number;
  relationshipCount: number;
  evidenceCount: number;
  layoutItemCount: number;
};

export function getContextGraphMapSchema() {
  return {
    objectTypes: [...CONTEXT_GRAPH_OBJECT_TYPES],
    relationshipTypes: [...CONTEXT_GRAPH_RELATIONSHIP_TYPES],
    objectStatuses: [...CONTEXT_GRAPH_STATUSES],
    mapViewTypes: [...CONTEXT_MAP_VIEW_TYPES],
    diffStatuses: [...CONTEXT_GRAPH_DIFF_STATUSES],
    defaultMaps: DEFAULT_CONTEXT_MAP_VIEW_CONFIGS.map((config) => ({
      key: config.key,
      name: config.name,
      viewType: config.viewType,
      description: config.description,
      query: config.query,
      missingEvidencePrompt: config.missingEvidencePrompt,
    })),
    objectFormat: {
      ref: "stable-object-ref-used-by-relationships-layout-and-evidence",
      objectType: "one of objectTypes",
      title: "human-readable title",
      summary: "optional short summary",
      confidence: "optional number from 0 to 1",
      status: "draft|proposed|approved|disputed|stale|archived",
      sourceEntityType: "optional source type such as BrainSource or BrainArticle",
      sourceEntityId: "optional source id",
      properties: "optional JSON object",
    },
    relationshipFormat: {
      ref: "stable-relationship-ref-used-by-evidence",
      sourceRef: "object ref from objects[]",
      targetRef: "object ref from objects[]",
      relationshipType: "one of relationshipTypes",
      confidence: "optional number from 0 to 1",
      status: "draft|proposed|approved|disputed|stale|archived",
      properties: "optional JSON object",
    },
    evidenceRefFormat: {
      objectRef: "object ref, required unless relationshipRef is provided",
      relationshipRef: "relationship ref, required unless objectRef is provided",
      sourceType: "source system or entity type, for example BrainSource, BrainArticle, DOCUMENT, MEETING",
      sourceId: "id in the source system",
      quote: "optional short supporting excerpt",
      relevanceScore: "optional number from 0 to 1",
      metadata: "optional JSON object",
    },
    layoutItemFormat: {
      objectRef: "object ref from objects[]",
      x: "finite number",
      y: "finite number",
      width: "optional finite number",
      height: "optional finite number",
      visualState: "optional JSON object",
    },
    exampleImportPayloads: [
      {
        name: "Critical path process map",
        viewType: "process",
        query: DEFAULT_CONTEXT_MAP_VIEW_CONFIGS[0].query,
        objects: [
          { ref: "process-onboarding", objectType: "Process", title: "Customer onboarding", status: "approved", confidence: 0.9 },
          { ref: "decision-launch", objectType: "Decision", title: "Launch readiness decision", status: "approved", confidence: 0.86 },
        ],
        relationships: [
          { ref: "decision-supports-process", sourceRef: "decision-launch", targetRef: "process-onboarding", relationshipType: "supports", status: "approved", confidence: 0.86 },
        ],
        evidenceRefs: [
          { objectRef: "decision-launch", sourceType: "BrainSource", sourceId: "brain-source-id", quote: "Launch readiness is the blocker.", relevanceScore: 0.86 },
        ],
        layoutItems: [
          { objectRef: "process-onboarding", x: 80, y: 80 },
          { objectRef: "decision-launch", x: 360, y: 80 },
        ],
      },
    ],
    writePath: {
      proposalTool: "create_context_graph_proposed_diff",
      auditedImportTool: "import_context_graph_map",
      rule: "Use proposed diffs for uncertain or review-needed facts. Use import_context_graph_map only for approved, evidence-backed maps.",
    },
  };
}

function requireKnownValue<T extends readonly string[]>(value: string, allowed: T, label: string): asserts value is T[number] {
  invariant((allowed as readonly string[]).includes(value), 400, "INVALID_INPUT", `Unknown ${label}: ${value}.`);
}

function normalizeStatus(status: string | undefined): ContextGraphStatus {
  const value = status ?? "draft";
  requireKnownValue(value, CONTEXT_GRAPH_STATUSES, "context graph status");
  return value;
}

function normalizeDate(value: Date | string | null | undefined) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

function jsonObject(value: JsonRecord | undefined): Prisma.InputJsonObject {
  return (value ?? {}) as Prisma.InputJsonObject;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStringField(value: unknown, message: string) {
  invariant(typeof value === "string", 400, "INVALID_INPUT", message);
  return value;
}

function requireOptionalArray(value: unknown, message: string) {
  invariant(value === undefined || Array.isArray(value), 400, "INVALID_INPUT", message);
}

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function isReadableStatus(status: string, includeStale = false) {
  if (status === "archived") return false;
  if (!includeStale && status === "stale") return false;
  return true;
}

function creatorData(actor: AppActor, agentRunId?: string | null) {
  return {
    createdByType: actor.kind === "agent" ? "agent" : "human",
    createdByUserId: actor.kind === "user" ? actor.user.id : null,
    createdByAgentRunId: agentRunId ?? null,
  };
}

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

function canApproveContextGraph(actor: AppActor, membership: Awaited<ReturnType<typeof requireWorkspaceMembership>>) {
  if (actor.kind === "agent") return Boolean(actor.scopes?.includes("context-graph:approve"));
  return membership?.role === "ADMIN" || membership?.role === "FACILITATOR";
}

async function requireGraphRead(actor: AppActor, workspaceId: string) {
  requireAgentScope(actor, "context-graph:read");
  return requireWorkspaceMembership({ actor, workspaceId });
}

async function requireGraphPropose(actor: AppActor, workspaceId: string) {
  requireAgentScope(actor, "context-graph:propose");
  return requireWorkspaceMembership({ actor, workspaceId });
}

async function requireGraphApprove(actor: AppActor, workspaceId: string) {
  if (actor.kind === "agent") {
    requireAgentScope(actor, "context-graph:approve");
    return requireWorkspaceMembership({ actor, workspaceId });
  }
  return requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN", "FACILITATOR"] });
}

function normalizeObjectInput(input: ContextGraphObjectInput) {
  const objectType = requireStringField(input.objectType, "Context graph object type is required.").trim();
  const title = requireStringField(input.title, "Context graph object title is required.").trim();
  requireKnownValue(objectType, CONTEXT_GRAPH_OBJECT_TYPES, "context graph object type");
  invariant(title.length > 0, 400, "INVALID_INPUT", "Context graph object title is required.");
  return {
    objectType,
    title,
    summary: input.summary?.trim() || null,
    properties: jsonObject(input.properties),
    confidence: input.confidence ?? null,
    status: normalizeStatus(input.status),
    sourceEntityType: input.sourceEntityType?.trim() || null,
    sourceEntityId: input.sourceEntityId?.trim() || null,
    dedupeKey: input.dedupeKey?.trim() || null,
    validFrom: normalizeDate(input.validFrom),
    validTo: normalizeDate(input.validTo),
    lastVerifiedAt: normalizeDate(input.lastVerifiedAt),
  };
}

function normalizeRelationshipInput(input: ContextGraphRelationshipInput) {
  const relationshipType = requireStringField(input.relationshipType, "Context graph relationship type is required.").trim();
  requireKnownValue(relationshipType, CONTEXT_GRAPH_RELATIONSHIP_TYPES, "context graph relationship type");
  return {
    relationshipType,
    properties: jsonObject(input.properties),
    confidence: input.confidence ?? null,
    status: normalizeStatus(input.status),
    sourceEntityType: input.sourceEntityType?.trim() || null,
    sourceEntityId: input.sourceEntityId?.trim() || null,
    dedupeKey: input.dedupeKey?.trim() || null,
    validFrom: normalizeDate(input.validFrom),
    validTo: normalizeDate(input.validTo),
    lastVerifiedAt: normalizeDate(input.lastVerifiedAt),
  };
}

function normalizeObjectUpdateInput(input: ContextGraphObjectUpdateInput) {
  const id = requireStringField(input.id, "Context graph object id is required.").trim();
  invariant(id.length > 0, 400, "INVALID_INPUT", "Context graph object id is required.");
  const data: Prisma.ContextGraphObjectUpdateInput = {};

  if (input.title !== undefined) {
    const title = requireStringField(input.title, "Context graph object title is required.").trim();
    invariant(title.length > 0, 400, "INVALID_INPUT", "Context graph object title is required.");
    data.title = title;
  }
  if (input.summary !== undefined) data.summary = input.summary?.trim() || null;
  if (input.properties !== undefined) data.properties = jsonObject(input.properties);
  if (input.confidence !== undefined) data.confidence = input.confidence;
  if (input.status !== undefined) data.status = normalizeStatus(input.status);
  if (input.sourceEntityType !== undefined) data.sourceEntityType = input.sourceEntityType?.trim() || null;
  if (input.sourceEntityId !== undefined) data.sourceEntityId = input.sourceEntityId?.trim() || null;
  if (input.dedupeKey !== undefined) data.dedupeKey = input.dedupeKey?.trim() || null;
  if (input.validFrom !== undefined) data.validFrom = normalizeDate(input.validFrom);
  if (input.validTo !== undefined) data.validTo = normalizeDate(input.validTo);
  if (input.lastVerifiedAt !== undefined) data.lastVerifiedAt = normalizeDate(input.lastVerifiedAt);

  invariant(Object.keys(data).length > 0, 400, "INVALID_INPUT", "Context graph object update must include at least one changed field.");
  return { id, data };
}

function normalizeRelationshipUpdateInput(input: ContextGraphRelationshipUpdateInput) {
  const id = requireStringField(input.id, "Context graph relationship id is required.").trim();
  invariant(id.length > 0, 400, "INVALID_INPUT", "Context graph relationship id is required.");
  const data: Prisma.ContextGraphRelationshipUpdateInput = {};

  if (input.sourceObjectId !== undefined) {
    const sourceObjectId = requireStringField(input.sourceObjectId, "Relationship source object is required.").trim();
    invariant(sourceObjectId.length > 0, 400, "INVALID_INPUT", "Relationship source object is required.");
    data.sourceObject = { connect: { id: sourceObjectId } };
  }
  if (input.targetObjectId !== undefined) {
    const targetObjectId = requireStringField(input.targetObjectId, "Relationship target object is required.").trim();
    invariant(targetObjectId.length > 0, 400, "INVALID_INPUT", "Relationship target object is required.");
    data.targetObject = { connect: { id: targetObjectId } };
  }
  if (input.relationshipType !== undefined) {
    const relationshipType = requireStringField(input.relationshipType, "Context graph relationship type is required.").trim();
    requireKnownValue(relationshipType, CONTEXT_GRAPH_RELATIONSHIP_TYPES, "context graph relationship type");
    data.relationshipType = relationshipType;
  }
  if (input.properties !== undefined) data.properties = jsonObject(input.properties);
  if (input.confidence !== undefined) data.confidence = input.confidence;
  if (input.status !== undefined) data.status = normalizeStatus(input.status);
  if (input.sourceEntityType !== undefined) data.sourceEntityType = input.sourceEntityType?.trim() || null;
  if (input.sourceEntityId !== undefined) data.sourceEntityId = input.sourceEntityId?.trim() || null;
  if (input.dedupeKey !== undefined) data.dedupeKey = input.dedupeKey?.trim() || null;
  if (input.validFrom !== undefined) data.validFrom = normalizeDate(input.validFrom);
  if (input.validTo !== undefined) data.validTo = normalizeDate(input.validTo);
  if (input.lastVerifiedAt !== undefined) data.lastVerifiedAt = normalizeDate(input.lastVerifiedAt);

  invariant(Object.keys(data).length > 0, 400, "INVALID_INPUT", "Context graph relationship update must include at least one changed field.");
  return { id, data };
}

function relationshipDedupeKey(params: {
  workspaceId: string;
  sourceObjectId: string;
  targetObjectId: string;
  relationshipType: string;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
}) {
  return `${params.workspaceId}:${params.sourceObjectId}:${params.relationshipType}:${params.targetObjectId}:${params.sourceEntityType ?? "manual"}:${params.sourceEntityId ?? "manual"}`;
}

function objectDedupeKey(workspaceId: string, sourceEntityType: string | null | undefined, sourceEntityId: string | null | undefined) {
  return sourceEntityType && sourceEntityId ? `${workspaceId}:${sourceEntityType}:${sourceEntityId}` : null;
}

async function upsertObjectWithTx(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  workspaceId: string,
  input: ContextGraphObjectInput,
  agentRunId?: string | null,
) {
  const data = normalizeObjectInput(input);
  const writeData = {
    ...data,
    ...creatorData(actor, agentRunId),
    recordedAt: new Date(),
    supersededByObjectId: null,
  };

  const dedupeKey = data.dedupeKey ?? objectDedupeKey(workspaceId, data.sourceEntityType, data.sourceEntityId);

  if (dedupeKey) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`context-graph-object:${dedupeKey}`}, 0))`;
  let previous = dedupeKey ? await tx.contextGraphObject.findFirst({ where: { dedupeKey } }) : null;
  invariant(!previous || previous.workspaceId === workspaceId, 404, "NOT_FOUND", "Context graph object not found.");
  if (previous) {
    await tx.$queryRaw`SELECT id FROM "ContextGraphObject" WHERE id = ${previous.id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    previous = await tx.contextGraphObject.findFirst({ where: { id: previous.id, workspaceId } });
    invariant(previous, 409, "SOURCE_CHANGED", "Context graph object changed.");
    await preserveGraphHistory(tx, actor, workspaceId, { kind: "ContextGraphObject", id: previous.id }, previous);
  }
  const prepared = await prepareGraphLineage(tx, actor, workspaceId, input);
  const object = dedupeKey ? await tx.contextGraphObject.upsert({
    where: { dedupeKey },
    update: { ...writeData, dedupeKey },
    create: {
      workspaceId,
      ...writeData,
      createdAt: writeData.recordedAt,
      dedupeKey,
    },
  }) : await tx.contextGraphObject.create({
    data: { workspaceId, ...writeData, createdAt: writeData.recordedAt },
  });
  await captureGraphLineage(tx, actor, workspaceId, { kind: "ContextGraphObject", id: object.id }, object, prepared);
  return object;
}

async function resolveObjectId(tx: Prisma.TransactionClient, workspaceId: string, objectId: string) {
  const object = await tx.contextGraphObject.findFirst({
    where: { id: objectId, workspaceId },
    select: { id: true },
  });
  invariant(object, 404, "NOT_FOUND", "Context graph object not found.");
  return object.id;
}

async function updateObjectWithTx(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  workspaceId: string,
  input: ContextGraphObjectUpdateInput,
  capture: GraphLineageCapture,
) {
  const update = normalizeObjectUpdateInput(input);
  await tx.$queryRaw`SELECT id FROM "ContextGraphObject" WHERE id = ${update.id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  const object = await tx.contextGraphObject.findFirst({
    where: { id: update.id, workspaceId },
  });
  invariant(object, 404, "NOT_FOUND", "Context graph object not found.");
  if (
    input.dedupeKey === undefined
    && (input.sourceEntityType !== undefined || input.sourceEntityId !== undefined)
  ) {
    update.data.dedupeKey = objectDedupeKey(
      workspaceId,
      input.sourceEntityType !== undefined ? input.sourceEntityType?.trim() || null : object.sourceEntityType,
      input.sourceEntityId !== undefined ? input.sourceEntityId?.trim() || null : object.sourceEntityId,
    );
  }
  const prepared = await prepareGraphLineage(tx, actor, workspaceId, capture, { kind: "ContextGraphObject", id: object.id });
  const updated = await tx.contextGraphObject.update({
    where: { id: update.id },
    data: update.data,
  });
  await captureGraphLineage(tx, actor, workspaceId, { kind: "ContextGraphObject", id: updated.id }, updated, prepared);
  return updated;
}

async function upsertRelationshipWithTx(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  workspaceId: string,
  input: ContextGraphRelationshipInput,
  refToObjectId: Map<string, string>,
  agentRunId?: string | null,
) {
  const sourceObjectId = input.sourceObjectId !== undefined
    ? input.sourceObjectId.trim()
    : (input.sourceRef ? refToObjectId.get(input.sourceRef) : undefined);
  const targetObjectId = input.targetObjectId !== undefined
    ? input.targetObjectId.trim()
    : (input.targetRef ? refToObjectId.get(input.targetRef) : undefined);
  invariant(sourceObjectId, 400, "INVALID_INPUT", "Relationship source object is required.");
  invariant(targetObjectId, 400, "INVALID_INPUT", "Relationship target object is required.");

  await resolveObjectId(tx, workspaceId, sourceObjectId);
  await resolveObjectId(tx, workspaceId, targetObjectId);

  const data = normalizeRelationshipInput(input);
  const dedupeKey = data.dedupeKey ?? relationshipDedupeKey({
    workspaceId,
    sourceObjectId,
    targetObjectId,
    relationshipType: data.relationshipType,
    sourceEntityType: data.sourceEntityType,
    sourceEntityId: data.sourceEntityId,
  });
  const writeData = {
    ...data,
    dedupeKey,
    sourceObjectId,
    targetObjectId,
    ...creatorData(actor, agentRunId),
    recordedAt: new Date(),
    supersededByRelationshipId: null,
  };

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`context-graph-relationship:${dedupeKey}`}, 0))`;
  let previous = await tx.contextGraphRelationship.findFirst({ where: { dedupeKey } });
  invariant(!previous || previous.workspaceId === workspaceId, 404, "NOT_FOUND", "Context graph relationship not found.");
  if (previous) {
    await tx.$queryRaw`SELECT id FROM "ContextGraphRelationship" WHERE id = ${previous.id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    previous = await tx.contextGraphRelationship.findFirst({ where: { id: previous.id, workspaceId } });
    invariant(previous, 409, "SOURCE_CHANGED", "Context graph relationship changed.");
    await preserveGraphHistory(tx, actor, workspaceId, { kind: "ContextGraphRelationship", id: previous.id }, previous);
  }
  const endpoints: LineageInput[] = [{ kind: "ContextGraphObject", id: sourceObjectId }, { kind: "ContextGraphObject", id: targetObjectId }];
  const prepared = await prepareGraphLineage(tx, actor, workspaceId, input, undefined, endpoints);
  const relationship = await tx.contextGraphRelationship.upsert({
    where: { dedupeKey },
    update: writeData,
    create: {
      workspaceId,
      ...writeData,
      createdAt: writeData.recordedAt,
    },
  });
  await captureGraphLineage(tx, actor, workspaceId, { kind: "ContextGraphRelationship", id: relationship.id }, relationship, prepared);
  return relationship;
}

async function updateRelationshipWithTx(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  workspaceId: string,
  input: ContextGraphRelationshipUpdateInput,
  capture: GraphLineageCapture,
) {
  const update = normalizeRelationshipUpdateInput(input);
  await tx.$queryRaw`SELECT id FROM "ContextGraphRelationship" WHERE id = ${update.id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  const relationship = await tx.contextGraphRelationship.findFirst({
    where: { id: update.id, workspaceId },
  });
  invariant(relationship, 404, "NOT_FOUND", "Context graph relationship not found.");
  const normalizedSourceObjectId = input.sourceObjectId !== undefined
    ? requireStringField(input.sourceObjectId, "Relationship source object is required.").trim()
    : undefined;
  const normalizedTargetObjectId = input.targetObjectId !== undefined
    ? requireStringField(input.targetObjectId, "Relationship target object is required.").trim()
    : undefined;
  const normalizedRelationshipType = input.relationshipType !== undefined
    ? requireStringField(input.relationshipType, "Context graph relationship type is required.").trim()
    : undefined;
  if (normalizedSourceObjectId) await resolveObjectId(tx, workspaceId, normalizedSourceObjectId);
  if (normalizedTargetObjectId) await resolveObjectId(tx, workspaceId, normalizedTargetObjectId);
  if (
    input.dedupeKey === undefined
    && (
      input.sourceObjectId !== undefined
      || input.targetObjectId !== undefined
      || input.relationshipType !== undefined
      || input.sourceEntityType !== undefined
      || input.sourceEntityId !== undefined
    )
  ) {
    update.data.dedupeKey = relationshipDedupeKey({
      workspaceId,
      sourceObjectId: normalizedSourceObjectId ?? relationship.sourceObjectId,
      targetObjectId: normalizedTargetObjectId ?? relationship.targetObjectId,
      relationshipType: normalizedRelationshipType ?? relationship.relationshipType,
      sourceEntityType: input.sourceEntityType !== undefined ? input.sourceEntityType?.trim() || null : relationship.sourceEntityType,
      sourceEntityId: input.sourceEntityId !== undefined ? input.sourceEntityId?.trim() || null : relationship.sourceEntityId,
    });
  }
  const prepared = await prepareGraphLineage(tx, actor, workspaceId, capture,
    { kind: "ContextGraphRelationship", id: relationship.id }, [
      { kind: "ContextGraphObject", id: normalizedSourceObjectId ?? relationship.sourceObjectId },
      { kind: "ContextGraphObject", id: normalizedTargetObjectId ?? relationship.targetObjectId },
    ]);
  const updated = await tx.contextGraphRelationship.update({
    where: { id: update.id },
    data: update.data,
  });
  await captureGraphLineage(tx, actor, workspaceId, { kind: "ContextGraphRelationship", id: relationship.id }, updated, prepared);
  return updated;
}

async function attachEvidenceWithTx(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  workspaceId: string,
  input: ContextGraphEvidenceInput,
  refToObjectId: Map<string, string>,
  refToRelationshipId: Map<string, string>,
) {
  const objectId = input.objectId ?? (input.objectRef ? refToObjectId.get(input.objectRef) : undefined);
  const relationshipId = input.relationshipId ?? (input.relationshipRef ? refToRelationshipId.get(input.relationshipRef) : undefined);
  invariant(Boolean(objectId) !== Boolean(relationshipId), 400, "INVALID_INPUT", "Evidence must point to exactly one object or relationship.");
  invariant(input.sourceType.trim().length > 0, 400, "INVALID_INPUT", "Evidence source type is required.");
  invariant(input.sourceId.trim().length > 0, 400, "INVALID_INPUT", "Evidence source id is required.");

  const existing = await tx.contextGraphEvidenceRef.findFirst({
    where: {
      workspaceId,
      objectId: objectId ?? null,
      relationshipId: relationshipId ?? null,
      sourceType: input.sourceType.trim(),
      sourceId: input.sourceId.trim(),
      knowledgeChunkId: input.knowledgeChunkId ?? null,
    },
  });

  const data = {
    workspaceId,
    objectId: objectId ?? null,
    relationshipId: relationshipId ?? null,
    sourceType: input.sourceType.trim(),
    sourceId: input.sourceId.trim(),
    knowledgeChunkId: input.knowledgeChunkId ?? null,
    quote: input.quote?.trim() || null,
    relevanceScore: input.relevanceScore ?? null,
    metadata: jsonObject(input.metadata),
  };

  const source = graphEvidenceSource(input);
  const prepared = source && !input.knowledgeChunkId ? await prepareGraphLineage(tx, actor, workspaceId, input, undefined, [
    source, objectId ? { kind: "ContextGraphObject", id: objectId } : { kind: "ContextGraphRelationship", id: relationshipId! },
  ]) : null;
  const evidence = existing
    ? await tx.contextGraphEvidenceRef.update({ where: { id: existing.id }, data })
    : await tx.contextGraphEvidenceRef.create({ data });
  if (prepared) await captureGraphLineage(tx, actor, workspaceId, { kind: "ContextGraphEvidenceRef", id: evidence.id }, evidence, prepared);
  else await invalidateArtifactInputLineage({ tx, workspaceId, artifact: { kind: "ContextGraphEvidenceRef", id: evidence.id }, content: evidence });
  return evidence;
}

function stringArrayFromQuery(query: Prisma.JsonValue, key: string) {
  if (!query || typeof query !== "object" || Array.isArray(query)) return [];
  const value = (query as JsonRecord)[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function jsonValueRecord(value: Prisma.JsonValue | null | undefined): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function stringProperty(value: Prisma.JsonValue | null | undefined, key: string) {
  const record = jsonValueRecord(value);
  const property = record[key];
  return typeof property === "string" && property.trim().length > 0 ? property.trim() : null;
}

function visibleMapViewWhere(workspaceId: string, userId: string | null) {
  return {
    workspaceId,
    OR: [
      { createdByUserId: null },
      ...(userId ? [{ createdByUserId: userId }] : []),
    ],
  };
}

function objectWhereForMapView(workspaceId: string, mapView: { query: Prisma.JsonValue }, includeStale = false): Prisma.ContextGraphObjectWhereInput {
  const objectTypes = stringArrayFromQuery(mapView.query, "objectTypes");
  const objectIds = stringArrayFromQuery(mapView.query, "objectIds");
  return {
    workspaceId,
    status: includeStale ? { not: "archived" } : { notIn: ["archived", "stale"] },
    ...(objectTypes.length ? { objectType: { in: objectTypes } } : {}),
    ...(objectIds.length ? { id: { in: objectIds } } : {}),
  };
}

function rebuildScopeForMap(mapView?: { id: string; query: Prisma.JsonValue; createdByUserId?: string | null } | null): GraphVariantScope {
  const key = mapView && stringProperty(mapView.query, "defaultMapKey");
  if (!mapView) return { kind: "default", mapKey: "critical-path" };
  return key && mapView.createdByUserId === null && ["critical-path", "org-structure", "agent-governance"].includes(key)
    ? { kind: "default", mapKey: key as "critical-path" | "org-structure" | "agent-governance" }
    : { kind: "view", mapViewId: mapView.id };
}

/** Queue only fresh recipes for denied server-discovered identities; no denied fields are forwarded. */
function graphReadWithRebuild(actor: AppActor, workspaceId: string,
  mapView?: { id: string; query: Prisma.JsonValue; createdByUserId?: string | null } | null,
  release?: DigestReadRelease) {
  const attempted = new Set<string>();
  const kinds = new Set<LineageInput["kind"]>(["ContextGraphObject", "ContextGraphRelationship", "ContextGraphEvidenceRef", "ContextGraphProposedDiff"]);
  const scope = rebuildScopeForMap(mapView);
  return async <T extends { id: string }>(kind: LineageInput["kind"], candidates: T[]): Promise<T[]> => {
    const heads = release && kinds.has(kind) && candidates.length
      ? await currentArtifactInputRootsBatch(prisma, workspaceId, kind, candidates) : null;
    const readable = release ? (await release.capture(kind, heads ? candidates.filter(row => heads.get(row.id) != null) : candidates)).records
      : await readableGraphRecords(actor, workspaceId, kind, candidates);
    if (actor.kind !== "user" || !kinds.has(kind)) return readable;
    const ids = new Set(readable.map(row => row.id));
    const denied = candidates.filter(row => !ids.has(row.id));
    invariant(denied.length <= 5000, 409, "SOURCE_READ_SCAN_LIMIT", "Graph rebuild discovery exceeds its scan limit.");
    for (const row of denied) {
      if (ids.has(row.id) || attempted.has(`${kind}:${row.id}`)) continue;
      if (attempted.size >= 8) break;
      const manifest = await prisma.artifactInputLineage.findFirst({
        where: { workspaceId, artifactType: kind, artifactId: row.id }, orderBy: { revision: "desc" },
        select: { id: true, origin: true },
      });
      if (manifest?.origin !== "DERIVED") {
        if (manifest?.origin !== "UNKNOWN" || !await prisma.derivedArtifactRebuildState.findFirst({
          where: { workspaceId, targetKind: kind, targetId: row.id, state: { in: ["REBUILD_REQUIRED", "CANDIDATE_READY"] } }, select: { id: true },
        })) continue;
      }
      attempted.add(`${kind}:${row.id}`);
      // The request API discovers complete stored ancestry and current independent
      // inputs itself. Originals and unclassified legacy records cannot queue.
      await requestGraphSourceVariant(actor, { workspaceId, target: { kind: kind as GraphTargetKind, id: row.id }, scope, mode: "MEMBER_VARIANT" });
    }
    return readable;
  };
}

/** Whole owner-private bundles use their own receipt, never a fabricated native child receipt. */
async function effectiveGraphVariantProjection(actor: AppActor, workspaceId: string,
  mapView?: { id: string; query: Prisma.JsonValue; createdByUserId?: string | null } | null, asOf?: Date | null) {
  const key = mapView && stringProperty(mapView.query, "defaultMapKey");
  const scopes: GraphVariantScope[] = mapView
    ? key && mapView.createdByUserId === null && ["critical-path", "org-structure", "agent-governance"].includes(key)
      ? [{ kind: "default", mapKey: key as "critical-path" | "org-structure" | "agent-governance" }]
      : [{ kind: "view", mapViewId: mapView.id }]
    : ["critical-path", "org-structure", "agent-governance"].map(mapKey => ({ kind: "default", mapKey } as GraphVariantScope));
  if (!mapView) {
    const views = await readableMapViews(actor, workspaceId, await prisma.contextMapView.findMany({
      where: visibleMapViewWhere(workspaceId, actorUserId(actor)),
    }));
    for (const view of views) if (view.createdByUserId !== null || !stringProperty(view.query, "defaultMapKey")) scopes.push({ kind: "view", mapViewId: view.id });
  }
  const variants = [...new Map((await Promise.all(scopes.map(scope => getReadableGraphSourceVariants(actor, { workspaceId, scope }))))
    .flat().map(variant => [variant.id, variant])).values()];
  const objects: ContextGraphObject[] = []; const relationships: ContextGraphRelationship[] = [];
  const evidenceRefs: ContextGraphEvidenceRef[] = []; const proposedDiffs: ContextGraphProposedDiff[] = [];
  const lineageRoots: NonNullable<GraphLineageCapture["lineageRoots"]> = [];
  const variantIds: string[] = []; const virtualIds = new Set<string>();
  const bundles = new Map<string, { childIds: Set<string>; roots: NonNullable<GraphLineageCapture["lineageRoots"]> }>();
  const objectTypes = mapView ? stringArrayFromQuery(mapView.query, "objectTypes") : [];
  const relationshipTypes = mapView ? stringArrayFromQuery(mapView.query, "relationshipTypes") : [];
  for (const variant of variants) {
    if (asOf && variant.createdAt > asOf) continue;
    const bundle = variant.bundle;
    const nativeProposal = await prisma.contextGraphProposedDiff.findFirst({ where: { id: bundle.proposedDiff.id, workspaceId } });
    // Applied native rows carry the immutable private variant's proof. Do not
    // render a second virtual copy, or resurrect a rejected proposal.
    if (nativeProposal && ["applied", "rejected"].includes(nativeProposal.status)) continue;
    const childIds = [...bundle.objects, ...bundle.relationships, ...bundle.evidenceRefs, bundle.proposedDiff].map(row => row.id);
    // Reject collisions as a whole; do not silently substitute an old or other-bundle endpoint.
    if (new Set(childIds).size !== childIds.length || childIds.some(id => virtualIds.has(id) || variant.targets.some(target => target.id === id))) continue;
    const ownObjects = bundle.objects.filter(row => !objectTypes.length || objectTypes.includes(row.objectType));
    const ownIds = new Set(ownObjects.map(row => row.id));
    const ownRelationships = bundle.relationships.filter(row => ownIds.has(row.sourceObjectId) && ownIds.has(row.targetObjectId)
      && (!relationshipTypes.length || relationshipTypes.includes(row.relationshipType)));
    const ownRelationshipIds = new Set(ownRelationships.map(row => row.id));
    if (!ownObjects.length || ownObjects.length !== bundle.objects.length || ownRelationships.length !== bundle.relationships.length
      || bundle.evidenceRefs.some(row => (row.objectId !== null && !ownIds.has(row.objectId))
        || (row.relationshipId !== null && !ownRelationshipIds.has(row.relationshipId)))) continue;
    const common = { workspaceId, createdByType: "agent", createdByUserId: null, createdByAgentRunId: null,
      sourceEntityType: null, sourceEntityId: null, dedupeKey: null, validFrom: null, validTo: null,
      recordedAt: variant.createdAt, lastVerifiedAt: null, createdAt: variant.createdAt, updatedAt: variant.createdAt };
    objects.push(...ownObjects.map(row => ({ ...common, ...row, ...(nativeProposal?.status === "approved" ? { status: "approved" } : {}), properties: (row.properties ?? {}) as Prisma.JsonValue,
      confidence: row.confidence ?? null, supersededByObjectId: null })));
    relationships.push(...ownRelationships.map(row => ({ ...common, ...row, ...(nativeProposal?.status === "approved" ? { status: "approved" } : {}), properties: (row.properties ?? {}) as Prisma.JsonValue,
      confidence: row.confidence ?? null, supersededByRelationshipId: null })));
    evidenceRefs.push(...bundle.evidenceRefs.filter(row => (row.objectId ? ownIds.has(row.objectId) : false)
      || (row.relationshipId ? ownRelationshipIds.has(row.relationshipId) : false)).map(row => ({ ...row, workspaceId,
      knowledgeChunkId: null, metadata: row.metadata as Prisma.JsonValue, createdAt: variant.createdAt })));
    if (!nativeProposal) proposedDiffs.push({ ...bundle.proposedDiff, workspaceId, proposedByType: "agent", proposedByUserId: null,
      proposedByAgentRunId: null, diffJson: bundle.proposedDiff.diffJson as Prisma.JsonValue, evidenceJson: null,
      reviewedByUserId: null, reviewedAt: null, appliedAt: null, createdAt: variant.createdAt, updatedAt: variant.createdAt });
    childIds.forEach(id => virtualIds.add(id)); variantIds.push(variant.id); lineageRoots.push(...variant.roots);
    bundles.set(variant.id, { childIds: new Set(childIds), roots: variant.roots });
  }
  invariant(objects.length + relationships.length + evidenceRefs.length <= 5000, 409, "SOURCE_READ_SCAN_LIMIT", "The effective graph requires a bounded rebuild.");
  return { objects, relationships, evidenceRefs, proposedDiffs, lineageRoots, variantIds, virtualIds, bundles };
}
async function assertEffectiveGraphVariantProjection(actor: AppActor, workspaceId: string,
  projection: Awaited<ReturnType<typeof effectiveGraphVariantProjection>>) {
  invariant(!projection.variantIds.length || await revalidateGraphSourceVariants(actor, { workspaceId, variantIds: projection.variantIds }),
    409, "SOURCE_CHANGED", "Graph variants changed before release.");
}

function contextMapGuidance(mapView: { name: string; viewType: string; query: Prisma.JsonValue }, counts: {
  objectCount: number;
  proposedDiffCount: number;
}) {
  const key = stringProperty(mapView.query, "defaultMapKey");
  const config = DEFAULT_CONTEXT_MAP_VIEW_CONFIGS.find((item) => item.key === key || item.viewType === mapView.viewType);
  const description = config?.description ?? "Evidence-backed company context for this map view.";
  const missingEvidencePrompt = config?.missingEvidencePrompt ?? "Add evidence before CORGTEX proposes new context-map facts.";
  return {
    evidenceBacked: true,
    defaultMapKey: config?.key ?? null,
    description,
    missingEvidencePrompt,
    emptyTitle: `${mapView.name} needs evidence`,
    emptyDescription: counts.proposedDiffCount > 0
      ? "Review pending evidence-backed proposals in the inspector before applying map facts."
      : missingEvidencePrompt,
  };
}

function normalizeLayoutItem(item: ContextMapLayoutItemInput) {
  const objectId = requireStringField(item.objectId, "Layout object id is required.").trim();
  invariant(objectId.length > 0, 400, "INVALID_INPUT", "Layout object id is required.");
  invariant(Number.isFinite(item.x) && Number.isFinite(item.y), 400, "INVALID_INPUT", "Layout coordinates must be finite numbers.");
  return {
    objectId,
    x: item.x,
    y: item.y,
    width: item.width ?? null,
    height: item.height ?? null,
    visualState: jsonObject(item.visualState),
  };
}

function validateProposedLayoutItem(input: ContextMapProposedLayoutItemInput) {
  invariant(Boolean(input.objectId) !== Boolean(input.objectRef), 400, "INVALID_INPUT", "Map layout items must point to exactly one object id or object ref.");
  invariant(Number.isFinite(input.x) && Number.isFinite(input.y), 400, "INVALID_INPUT", "Layout coordinates must be finite numbers.");
}

function layoutItemFromProposed(item: ContextMapProposedLayoutItemInput, refToObjectId: Map<string, string>) {
  validateProposedLayoutItem(item);
  const objectId = item.objectId?.trim() || (item.objectRef ? refToObjectId.get(item.objectRef) : undefined);
  invariant(objectId, 400, "INVALID_INPUT", "Map layout item object ref was not found.");
  return normalizeLayoutItem({
    objectId,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    visualState: item.visualState,
  });
}

async function applyMapLayoutUpdateWithTx(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  update: ContextMapLayoutUpdateInput,
  options?: { actor?: AppActor; requireMasterOrOwner?: boolean; refToObjectId?: Map<string, string>; capture?: GraphLineageCapture },
) {
  invariant(update.mapViewId.trim().length > 0, 400, "INVALID_INPUT", "Map view id is required.");
  invariant(update.items.length > 0, 400, "INVALID_INPUT", "At least one layout item is required.");
  const mapView = await tx.contextMapView.findFirst({
    where: { id: update.mapViewId, workspaceId },
    select: { id: true, createdByUserId: true },
  });
  invariant(mapView, 404, "NOT_FOUND", "Context map not found.");
  if (options?.requireMasterOrOwner) {
    const userId = options.actor ? actorUserId(options.actor) : null;
    invariant(
      mapView.createdByUserId === null || (userId !== null && mapView.createdByUserId === userId),
      403,
      "FORBIDDEN",
      "Proposed map layout updates can only target shared master views or your personal map view.",
    );
  }

  for (const rawItem of update.items) {
    const item = layoutItemFromProposed(rawItem, options?.refToObjectId ?? new Map());
    await resolveObjectId(tx, workspaceId, item.objectId);
    const prepared = options?.actor ? await prepareGraphLineage(tx, options.actor, workspaceId,
      options.capture ?? { humanOriginal: options.actor.kind === "user", lineageInputs: options.actor.kind === "user" ? [] : undefined },
      undefined, [{ kind: "ContextMapView", id: update.mapViewId }, { kind: "ContextGraphObject", id: item.objectId }]) : null;
    const saved = await tx.contextMapLayoutItem.upsert({
      where: {
        mapViewId_objectId: {
          mapViewId: update.mapViewId,
          objectId: item.objectId,
        },
      },
      update: {
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        visualState: item.visualState,
      },
      create: {
        mapViewId: update.mapViewId,
        objectId: item.objectId,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        visualState: item.visualState,
      },
    });
    if (options?.actor) {
      await captureGraphLineage(tx, options.actor, workspaceId,
        { kind: "ContextMapLayoutItem", id: saved.id }, saved,
        prepared!);
    } else {
      await invalidateArtifactInputLineage({ tx, workspaceId,
        artifact: { kind: "ContextMapLayoutItem", id: saved.id }, content: saved });
    }
  }

  return { mapViewId: update.mapViewId, updated: update.items.length };
}

function validateEvidenceInput(input: ContextGraphEvidenceInput) {
  const sourceType = requireStringField(input.sourceType, "Evidence source type is required.").trim();
  const sourceId = requireStringField(input.sourceId, "Evidence source id is required.").trim();
  invariant(sourceType.length > 0, 400, "INVALID_INPUT", "Evidence source type is required.");
  invariant(sourceId.length > 0, 400, "INVALID_INPUT", "Evidence source id is required.");
}

function validateImportLayoutItem(input: ContextMapImportLayoutItemInput) {
  invariant(Boolean(input.objectId) !== Boolean(input.objectRef), 400, "INVALID_INPUT", "Map import layout items must point to exactly one object id or object ref.");
  invariant(Number.isFinite(input.x) && Number.isFinite(input.y), 400, "INVALID_INPUT", "Layout coordinates must be finite numbers.");
}

function normalizeMapImportInput(input: ContextGraphMapImportInput) {
  const name = requireStringField(input.name, "Context map name is required.").trim();
  invariant(name.length > 0, 400, "INVALID_INPUT", "Context map name is required.");
  const viewType = (input.viewType?.trim() || "process");
  requireKnownValue(viewType, CONTEXT_MAP_VIEW_TYPES, "context map view type");
  invariant(Array.isArray(input.objects), 400, "INVALID_INPUT", "Context map import objects must be an array.");
  invariant(input.objects.length > 0, 400, "INVALID_INPUT", "Context map import requires at least one object.");
  requireOptionalArray(input.relationships, "Context map import relationships must be an array.");
  requireOptionalArray(input.evidenceRefs, "Context map import evidence refs must be an array.");
  requireOptionalArray(input.layoutItems, "Context map import layout items must be an array.");

  const objectTypes = new Set<string>();
  const relationshipTypes = new Set<string>();
  for (const object of input.objects) {
    const normalized = normalizeObjectInput(object);
    objectTypes.add(normalized.objectType);
  }
  for (const relationship of input.relationships ?? []) {
    const normalized = normalizeRelationshipInput(relationship);
    relationshipTypes.add(normalized.relationshipType);
  }
  for (const evidence of input.evidenceRefs ?? []) validateEvidenceInput(evidence);
  for (const item of input.layoutItems ?? []) validateImportLayoutItem(item);

  return {
    name,
    viewType,
    query: input.query
      ? jsonObject(input.query)
      : {
        mode: "imported",
        objectTypes: [...objectTypes].sort(),
        relationshipTypes: [...relationshipTypes].sort(),
      } satisfies Prisma.InputJsonObject,
  };
}

function layoutItemFromImport(item: ContextMapImportLayoutItemInput, refToObjectId: Map<string, string>) {
  const objectId = item.objectId ?? (item.objectRef ? refToObjectId.get(item.objectRef) : undefined);
  invariant(objectId, 400, "INVALID_INPUT", "Map import layout item object ref was not found.");
  return normalizeLayoutItem({
    objectId,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    visualState: item.visualState,
  });
}

export async function importContextGraphMap(actor: AppActor, params: ContextGraphMapImportInput & GraphLineageCapture & {
  workspaceId: string;
}): Promise<ContextGraphMapImportResult> {
  await requireGraphApprove(actor, params.workspaceId);
  const mapInput = normalizeMapImportInput(params);

  return prisma.$transaction(async (tx) => {
    const existingMapView = await tx.contextMapView.findFirst({
      where: { workspaceId: params.workspaceId, name: mapInput.name, createdByUserId: null },
      orderBy: { createdAt: "asc" },
    });
    if (existingMapView) invariant((await readableMapViews(actor, params.workspaceId, [existingMapView], tx)).length,
      404, "NOT_FOUND", "Context map not found.");
    const mapCapture = await prepareGraphLineage(tx, actor, params.workspaceId, params,
      existingMapView ? { kind: "ContextMapView", id: existingMapView.id } : undefined);
    const mapView = existingMapView
      ? await tx.contextMapView.update({
        where: { id: existingMapView.id },
        data: {
          viewType: mapInput.viewType,
          query: mapInput.query,
        },
      })
      : await tx.contextMapView.create({
        data: {
          workspaceId: params.workspaceId,
          name: mapInput.name,
          viewType: mapInput.viewType,
          query: mapInput.query,
          createdByUserId: null,
        },
      });
    await captureGraphLineage(tx, actor, params.workspaceId,
      { kind: "ContextMapView", id: mapView.id }, mapView, mapCapture);

    const refToObjectId = new Map<string, string>();
    const refToRelationshipId = new Map<string, string>();
    const objectIds: string[] = [];
    const relationshipIds: string[] = [];

    for (const objectInput of params.objects) {
      const object = await upsertObjectWithTx(tx, actor, params.workspaceId, {
        lineageInputs: params.lineageInputs,
        lineageRoots: params.lineageRoots,
        humanOriginal: params.humanOriginal,
        ...objectInput,
        status: objectInput.status ?? "approved",
      }, params.agentRunId);
      objectIds.push(object.id);
      if (objectInput.ref) refToObjectId.set(objectInput.ref, object.id);
    }

    for (const relationshipInput of params.relationships ?? []) {
      const relationship = await upsertRelationshipWithTx(tx, actor, params.workspaceId, {
        lineageInputs: params.lineageInputs,
        lineageRoots: params.lineageRoots,
        humanOriginal: params.humanOriginal,
        ...relationshipInput,
        status: relationshipInput.status ?? "approved",
      }, refToObjectId, params.agentRunId);
      relationshipIds.push(relationship.id);
      if (relationshipInput.ref) refToRelationshipId.set(relationshipInput.ref, relationship.id);
    }

    for (const evidenceInput of params.evidenceRefs ?? []) {
      await attachEvidenceWithTx(tx, actor, params.workspaceId, { lineageInputs: params.lineageInputs, lineageRoots: params.lineageRoots,
        humanOriginal: params.humanOriginal, ...evidenceInput }, refToObjectId, refToRelationshipId);
    }

    const layoutItems = (params.layoutItems ?? []).map((item) => layoutItemFromImport(item, refToObjectId));
    if (layoutItems.length) {
      await applyMapLayoutUpdateWithTx(tx, params.workspaceId, {
        mapViewId: mapView.id,
        items: layoutItems,
      }, {
        actor,
        requireMasterOrOwner: true,
        capture: params,
      });
    }

    const result = {
      mapViewId: mapView.id,
      objectCount: objectIds.length,
      relationshipCount: relationshipIds.length,
      evidenceCount: params.evidenceRefs?.length ?? 0,
      layoutItemCount: layoutItems.length,
    };

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "context-graph.map.imported",
      entityType: "ContextMapView",
      entityId: mapView.id,
      meta: {
        name: mapView.name,
        viewType: mapView.viewType,
        ...result,
      },
    });
    await appendEvents(tx, [{
      workspaceId: params.workspaceId,
      type: "context-graph.map.imported",
      aggregateType: "ContextMapView",
      aggregateId: mapView.id,
      payload: {
        name: mapView.name,
        ...result,
      },
    }]);

    return result;
  });
}

export async function upsertContextGraphObject(actor: AppActor, params: ContextGraphObjectInput & {
  workspaceId: string;
  agentRunId?: string | null;
}) {
  await requireGraphApprove(actor, params.workspaceId);
  return prisma.$transaction(async (tx) => {
    const object = await upsertObjectWithTx(tx, actor, params.workspaceId, params, params.agentRunId);
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "context-graph.object.upserted",
      entityType: "ContextGraphObject",
      entityId: object.id,
      meta: { objectType: object.objectType, title: object.title, status: object.status },
    });
    return object;
  });
}

export async function upsertContextGraphRelationship(actor: AppActor, params: ContextGraphRelationshipInput & {
  workspaceId: string;
  agentRunId?: string | null;
}) {
  await requireGraphApprove(actor, params.workspaceId);
  return prisma.$transaction(async (tx) => {
    const relationship = await upsertRelationshipWithTx(tx, actor, params.workspaceId, params, new Map(), params.agentRunId);
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "context-graph.relationship.upserted",
      entityType: "ContextGraphRelationship",
      entityId: relationship.id,
      meta: { relationshipType: relationship.relationshipType, status: relationship.status },
    });
    return relationship;
  });
}

export async function attachContextGraphEvidence(actor: AppActor, params: ContextGraphEvidenceInput & {
  workspaceId: string;
}) {
  await requireGraphApprove(actor, params.workspaceId);
  return prisma.$transaction(async (tx) => attachEvidenceWithTx(tx, actor, params.workspaceId, params, new Map(), new Map()));
}

function sameStringArrays(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function ensureDefaultContextMapViewsForWorkspace(actor: AppActor, workspaceId: string) {
  return prisma.$transaction(async (tx) => {
    const views = [];
    for (const config of DEFAULT_CONTEXT_MAP_VIEW_CONFIGS) {
      const existing = await tx.contextMapView.findFirst({
        where: { workspaceId, viewType: config.viewType, createdByUserId: null }, orderBy: { createdAt: "asc" },
      });
      if (existing) {
        // Matching constants are not historical provenance. Unknown maps stay untouched.
        if (!(await readableMapViews(actor, workspaceId, [existing], tx)).length) continue;
        const configQuery = config.query as Prisma.JsonValue;
        const queryDrifted = stringProperty(existing.query, "defaultMapKey") === config.key && (
          !sameStringArrays(stringArrayFromQuery(existing.query, "objectTypes"), stringArrayFromQuery(configQuery, "objectTypes"))
          || !sameStringArrays(stringArrayFromQuery(existing.query, "relationshipTypes"), stringArrayFromQuery(configQuery, "relationshipTypes"))
        );
        if (queryDrifted) {
          const capture = await prepareGraphLineage(tx, actor, workspaceId,
            { lineageInputs: [{ kind: "Workspace", id: workspaceId }] }, { kind: "ContextMapView", id: existing.id });
          const updated = await tx.contextMapView.update({ where: { id: existing.id }, data: { query: config.query } });
          await captureGraphLineage(tx, actor, workspaceId, { kind: "ContextMapView", id: updated.id }, updated, capture);
          views.push(updated);
        } else views.push(existing);
        continue;
      }
      const capture = await prepareGraphLineage(tx, actor, workspaceId, { lineageInputs: [{ kind: "Workspace", id: workspaceId }] });
      const created = await tx.contextMapView.create({ data: {
        workspaceId, name: config.name, viewType: config.viewType, query: config.query, createdByUserId: null,
      } });
      await captureGraphLineage(tx, actor, workspaceId, { kind: "ContextMapView", id: created.id }, created, capture);
      views.push(created);
    }
    return views;
  });
}

async function readableMapViews<T extends { id: string }>(
  actor: AppActor, workspaceId: string, views: T[], db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return readableGraphRecords(actor, workspaceId, "ContextMapView", views, db);
}

export async function ensureDefaultContextMapView(actor: AppActor, workspaceId: string) {
  await requireGraphRead(actor, workspaceId);
  const views = await readableMapViews(actor, workspaceId, await ensureDefaultContextMapViewsForWorkspace(actor, workspaceId));
  return views.find((view) => view.viewType === "process") ?? views[0];
}

export async function listContextMapViews(actor: AppActor, workspaceId: string) {
  await requireGraphRead(actor, workspaceId);
  const userId = actorUserId(actor);
  await ensureDefaultContextMapViewsForWorkspace(actor, workspaceId);
  const views = await prisma.contextMapView.findMany({
    where: visibleMapViewWhere(workspaceId, userId),
    orderBy: [{ createdByUserId: "asc" }, { viewType: "asc" }, { createdAt: "asc" }],
  });
  return readableMapViews(actor, workspaceId, views);
}

export const DEFAULT_CONTEXT_GRAPH_STALE_AFTER_DAYS = 45;

export async function markStaleContextGraphFacts(actor: AppActor, params: {
  workspaceId: string;
  staleAfterDays?: number;
  now?: Date;
}) {
  await requireGraphApprove(actor, params.workspaceId);
  const staleAfterDays = Math.max(1, Math.floor(params.staleAfterDays ?? DEFAULT_CONTEXT_GRAPH_STALE_AFTER_DAYS));
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - staleAfterDays * 24 * 60 * 60 * 1000);
  const staleWhere = {
    workspaceId: params.workspaceId,
    status: "approved",
    OR: [
      { lastVerifiedAt: { lt: cutoff } },
      { lastVerifiedAt: null, updatedAt: { lt: cutoff } },
    ],
  };

  let staleObjects = 0, staleRelationships = 0;
  for (const kind of ["ContextGraphObject", "ContextGraphRelationship"] as const) {
    let afterId: string | undefined;
    for (;;) {
      const where = {...staleWhere, ...(afterId ? {id: {gt: afterId}} : {})};
      const page = kind === "ContextGraphObject"
        ? await prisma.contextGraphObject.findMany({where, orderBy: {id: "asc"}, take: 100})
        : await prisma.contextGraphRelationship.findMany({where, orderBy: {id: "asc"}, take: 100});
      invariant(page.length <= 100 && page.every(row => !afterId || row.id > afterId), 409, "SOURCE_CHANGED", "Graph maintenance discovery changed.");
      // Missing/stale heads are negative discovery, never permission to write.
      const heads = await currentArtifactInputRootsBatch(prisma, params.workspaceId, kind, page);
      for (const candidate of page) {
        if (heads.get(candidate.id) == null) continue;
        const changed = await prisma.$transaction(async tx => {
          requireAgentScope(actor, "context-graph:approve");
          await requireWorkspaceMembership({actor, workspaceId: params.workspaceId, tx,
            ...(actor.kind === "user" ? {allowedRoles: ["ADMIN", "FACILITATOR"] as Array<"ADMIN" | "FACILITATOR">} : {})});
          if (kind === "ContextGraphObject") {
            await tx.$queryRaw`SELECT id FROM "ContextGraphObject" WHERE id = ${candidate.id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
            const before = await tx.contextGraphObject.findFirst({where: {...staleWhere, id: candidate.id}});
            if (!before || !(await readableGraphRecords(actor, params.workspaceId, kind, [before], tx)).length) return false;
            await captureArtifactInputProof(actor, params.workspaceId, [{kind, id: before.id, snapshot: before}], tx);
            const after = await tx.contextGraphObject.update({where: {id: before.id}, data: {status: "stale"}});
            await advanceHumanArtifactInputLineage({tx, actor, workspaceId: params.workspaceId, artifact: {kind, id: before.id}, before, after, allowSystemTransition: true});
          } else {
            await tx.$queryRaw`SELECT id FROM "ContextGraphRelationship" WHERE id = ${candidate.id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
            const before = await tx.contextGraphRelationship.findFirst({where: {...staleWhere, id: candidate.id}});
            if (!before || !(await readableGraphRecords(actor, params.workspaceId, kind, [before], tx)).length) return false;
            await captureArtifactInputProof(actor, params.workspaceId, [{kind, id: before.id, snapshot: before}], tx);
            const after = await tx.contextGraphRelationship.update({where: {id: before.id}, data: {status: "stale"}});
            await advanceHumanArtifactInputLineage({tx, actor, workspaceId: params.workspaceId, artifact: {kind, id: before.id}, before, after, allowSystemTransition: true});
          }
          return true;
        });
        if (changed) { if (kind === "ContextGraphObject") staleObjects++; else staleRelationships++; }
      }
      if (page.length < 100) break;
      afterId = page.at(-1)!.id;
    }
  }
  return {staleObjects, staleRelationships, cutoff};
}

/** Retire obsolete projections without re-certifying their historical bodies. */
export async function retireContextGraphFacts(actor: AppActor, params: {
  workspaceId: string;
  objectWhere?: Prisma.ContextGraphObjectWhereInput;
  relationshipWhere?: Prisma.ContextGraphRelationshipWhereInput;
}) {
  await requireGraphApprove(actor, params.workspaceId);
  await prisma.$transaction(async (tx) => {
    if (params.objectWhere) {
      const rows = await tx.contextGraphObject.findMany({ where: { AND: [params.objectWhere, { workspaceId: params.workspaceId, status: { not: "archived" } }] }, take: 5001 });
      invariant(rows.length <= 5000, 409, "SOURCE_READ_SCAN_LIMIT", "Graph retirement exceeds its scan limit.");
      for (const row of await readableGraphRecords(actor, params.workspaceId, "ContextGraphObject", rows, tx)) {
        await tx.$queryRaw`SELECT id FROM "ContextGraphObject" WHERE id = ${row.id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
        await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "ContextGraphObject", id: row.id, snapshot: row }], tx);
        const updated = await tx.contextGraphObject.update({ where: { id: row.id }, data: { status: "archived" } });
        await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId, artifact: { kind: "ContextGraphObject", id: row.id }, content: updated });
      }
    }
    if (params.relationshipWhere) {
      const rows = await tx.contextGraphRelationship.findMany({ where: { AND: [params.relationshipWhere, { workspaceId: params.workspaceId, status: { not: "archived" } }] }, take: 5001 });
      invariant(rows.length <= 5000, 409, "SOURCE_READ_SCAN_LIMIT", "Graph retirement exceeds its scan limit.");
      for (const row of await readableGraphRecords(actor, params.workspaceId, "ContextGraphRelationship", rows, tx)) {
        await tx.$queryRaw`SELECT id FROM "ContextGraphRelationship" WHERE id = ${row.id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
        await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "ContextGraphRelationship", id: row.id, snapshot: row }], tx);
        const updated = await tx.contextGraphRelationship.update({ where: { id: row.id }, data: { status: "archived" } });
        await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId, artifact: { kind: "ContextGraphRelationship", id: row.id }, content: updated });
      }
    }
  });
}

export async function getContextMapData(actor: AppActor, params: {
  workspaceId: string;
  mapViewId?: string | null;
  includeStale?: boolean;
}) {
  const membership = await requireGraphRead(actor, params.workspaceId);
  const release = new DigestReadRelease(actor, params.workspaceId);
  const userId = actorUserId(actor);
  const defaultViews = await ensureDefaultContextMapViewsForWorkspace(actor, params.workspaceId);
  const mapView = params.mapViewId
    ? await prisma.contextMapView.findFirst({ where: { id: params.mapViewId, ...visibleMapViewWhere(params.workspaceId, userId) } })
    : (await readableMapViews(actor, params.workspaceId, defaultViews)).find((view) => view.viewType === "process")
      ?? (await readableMapViews(actor, params.workspaceId, defaultViews))[0];
  invariant(mapView, 404, "NOT_FOUND", "Context map not found.");
  invariant((await release.capture("ContextMapView", [mapView])).records.length,
    404, "NOT_FOUND", "Context map not found.");

  const readGraph = graphReadWithRebuild(actor, params.workspaceId, mapView, release);
  const completeness = {objectsComplete: true, relationshipsComplete: true, evidenceComplete: true,
    proposedDiffsComplete: true, variantsComplete: true};
  // A parent cap alone would still allow thousands of denied evidence pages.
  // This shared budget bounds discovery across every displayed object and edge.
  const evidenceBudget = {remaining: 2500};
  async function window<R extends {id: string}>(kind: LineageInput["kind"], limit: number,
    load: (after: R | undefined, take: number) => Promise<R[]>,
    options?: {maxCandidates: number; shared: {remaining: number}}) {
    const result: R[] = [];
    let after: R | undefined;
    let examined = 0, complete = false;
    const maxCandidates = options?.maxCandidates ?? Math.max(200, limit);
    while (result.length < limit && examined < maxCandidates && (options?.shared.remaining ?? 1) > 0) {
      const take = Math.min(100, limit - result.length, maxCandidates - examined, options?.shared.remaining ?? Infinity);
      const rows = await load(after, take);
      invariant(rows.length <= take && (!rows.length || rows.at(-1)!.id !== after?.id), 409, "SOURCE_CHANGED", "Graph window changed during pagination.");
      examined += rows.length;
      if (options) options.shared.remaining -= rows.length;
      // Keep the originally admitted proofs through all later map/evidence awaits.
      result.push(...await readGraph(kind, rows));
      if (rows.length < take) { complete = true; break; }
      after = rows.at(-1);
    }
    if (kind === "ContextGraphObject") completeness.objectsComplete = complete;
    else if (kind === "ContextGraphRelationship") completeness.relationshipsComplete = complete;
    else if (kind === "ContextGraphEvidenceRef") completeness.evidenceComplete &&= complete;
    else if (kind === "ContextGraphProposedDiff") completeness.proposedDiffsComplete = complete;
    return result;
  }
  const nativeObjects = await window("ContextGraphObject", 200, (after: ContextGraphObject | undefined, take) => prisma.contextGraphObject.findMany({
    where: {AND: [objectWhereForMapView(params.workspaceId, mapView, params.includeStale), ...(after ? [{OR: [
      {objectType: {gt: after.objectType}}, {objectType: after.objectType, updatedAt: {lt: after.updatedAt}},
      {objectType: after.objectType, updatedAt: after.updatedAt, id: {lt: after.id}},
    ]}] : [])]}, orderBy: [{objectType: "asc"}, {updatedAt: "desc"}, {id: "desc"}], take,
  }));
  async function evidenceFor(objectId?: string, relationshipId?: string) {
    return window("ContextGraphEvidenceRef", 5, (after: ContextGraphEvidenceRef | undefined, take) => prisma.contextGraphEvidenceRef.findMany({
      where: {workspaceId: params.workspaceId, ...(objectId ? {objectId} : {relationshipId}), knowledgeChunkId: null,
        ...(after ? {OR: [{createdAt: {lt: after.createdAt}}, {createdAt: after.createdAt, id: {lt: after.id}}]} : {})},
      orderBy: [{createdAt: "desc"}, {id: "desc"}], take,
    }), {maxCandidates: 20, shared: evidenceBudget});
  }
  const readableObjects = [];
  for (const object of nativeObjects) readableObjects.push({...object, evidenceRefs: await evidenceFor(object.id)});
  const variantProjection = await effectiveGraphVariantProjection(actor, params.workspaceId, mapView);
  // A display window can omit a bundle, but must never split its object dictionary.
  let remainingVariantSlots = Math.max(0, 200 - readableObjects.length);
  const admittedVariantObjectIds = new Set<string>();
  for (const bundle of variantProjection.bundles.values()) {
    const ids = variantProjection.objects.filter(object => bundle.childIds.has(object.id)).map(object => object.id);
    if (ids.length > remainingVariantSlots) { completeness.variantsComplete = false; continue; }
    ids.forEach(id => admittedVariantObjectIds.add(id)); remainingVariantSlots -= ids.length;
  }
  const variantObjects = variantProjection.objects.filter(object => admittedVariantObjectIds.has(object.id)).map(object => ({ ...object,
    evidenceRefs: variantProjection.evidenceRefs.filter(ref => ref.objectId === object.id),
  }));
  if ([...readableObjects, ...variantObjects].some(object => object.evidenceRefs.length > 5)) completeness.evidenceComplete = false;
  const objects = [...readableObjects, ...variantObjects].slice(0, 200).map((object) => ({ ...object,
    evidenceRefs: object.evidenceRefs.slice(0, 5),
  }));
  const objectIds = objects.map((object) => object.id);
  const relationshipTypes = stringArrayFromQuery(mapView.query, "relationshipTypes");
  const nativeRelationships = await window("ContextGraphRelationship", 300, (after: ContextGraphRelationship | undefined, take) => prisma.contextGraphRelationship.findMany({
    where: {workspaceId: params.workspaceId, status: params.includeStale ? {not: "archived"} : {notIn: ["archived", "stale"]},
      sourceObjectId: {in: objectIds}, targetObjectId: {in: objectIds}, ...(relationshipTypes.length ? {relationshipType: {in: relationshipTypes}} : {}),
      ...(after ? {id: {gt: after.id}} : {})}, orderBy: {id: "asc"}, take,
  }));
  const readableRelationships = [];
  for (const relationship of nativeRelationships) readableRelationships.push({...relationship, evidenceRefs: await evidenceFor(undefined, relationship.id)});
  const [mapViews, candidateLayoutItems] = await Promise.all([
    prisma.contextMapView.findMany({where: visibleMapViewWhere(params.workspaceId, userId), orderBy: [{createdByUserId: "asc"}, {viewType: "asc"}, {createdAt: "asc"}]}),
    prisma.contextMapLayoutItem.findMany({where: {mapViewId: mapView.id, objectId: {in: objectIds}}}),
  ]);
  const candidateDiffs = await window("ContextGraphProposedDiff", 20, (after: ContextGraphProposedDiff | undefined, take) => prisma.contextGraphProposedDiff.findMany({
    where: {workspaceId: params.workspaceId, status: {in: ["pending", "approved"]}, ...(after ? {OR: [
      {createdAt: {lt: after.createdAt}}, {createdAt: after.createdAt, id: {lt: after.id}},
    ]} : {})}, orderBy: [{createdAt: "desc"}, {id: "desc"}], take,
  }));
  const visibleObjectIds = new Set(objectIds);
  const variantRelationships = variantProjection.relationships.map(relationship => ({ ...relationship,
    evidenceRefs: variantProjection.evidenceRefs.filter(ref => ref.relationshipId === relationship.id),
  }));
  const eligibleRelationships = [...readableRelationships, ...variantRelationships].filter(relationship => visibleObjectIds.has(relationship.sourceObjectId)
    && visibleObjectIds.has(relationship.targetObjectId));
  if (eligibleRelationships.length > 300) completeness.relationshipsComplete = false;
  if (variantRelationships.some(relationship => !visibleObjectIds.has(relationship.sourceObjectId) || !visibleObjectIds.has(relationship.targetObjectId))) completeness.variantsComplete = false;
  if (eligibleRelationships.some(relationship => relationship.evidenceRefs.length > 5)) completeness.evidenceComplete = false;
  const relationships = eligibleRelationships.slice(0, 300).map((relationship) => ({ ...relationship,
    evidenceRefs: relationship.evidenceRefs.slice(0, 5),
  }));
  const layoutItems = (await readGraph("ContextMapLayoutItem",
    candidateLayoutItems.filter((item) => visibleObjectIds.has(item.objectId))));
  if (candidateDiffs.length + variantProjection.proposedDiffs.length > 20) completeness.proposedDiffsComplete = false;
  const proposedDiffs = [...candidateDiffs, ...variantProjection.proposedDiffs].slice(0, 20);
  const readWindow = {scope: "WINDOW" as const, complete: Object.values(completeness).every(Boolean), ...completeness};
  const visibleMapViews = (await release.capture("ContextMapView", mapViews)).records;
  release.add(variantProjection.lineageRoots);
  await assertEffectiveGraphVariantProjection(actor, params.workspaceId, variantProjection);
  return release.finish({
    mapView,
    mapViews: visibleMapViews,
    objects,
    relationships,
    layoutItems,
    proposedDiffs,
    readWindow,
    guidance: {...contextMapGuidance(mapView, {
      objectCount: objects.length,
      proposedDiffCount: proposedDiffs.length,
    }), ...(!readWindow.complete && objects.length === 0 ? {
      emptyTitle: "No visible facts in this window",
      emptyDescription: "This limited window does not establish that the map is empty. Choose another view to inspect a different scope.",
    } : {})},
    permissions: {
      canSavePersonalView: actor.kind === "user",
      canUpdateMasterView: canApproveContextGraph(actor, membership),
      canRequestMasterUpdate: actor.kind === "user",
    },
  });
}

export async function updateContextMapLayout(actor: AppActor, params: {
  workspaceId: string;
  mapViewId: string;
  items: Array<{ objectId: string; x: number; y: number; width?: number | null; height?: number | null; visualState?: JsonRecord }>;
}) {
  const membership = await requireGraphPropose(actor, params.workspaceId);
  const userId = actorUserId(actor);
  const mapView = await prisma.contextMapView.findFirst({
    where: { id: params.mapViewId, ...visibleMapViewWhere(params.workspaceId, userId) },
  });
  invariant(mapView, 404, "NOT_FOUND", "Context map not found.");
  invariant((await readableMapViews(actor, params.workspaceId, [mapView])).length,
    404, "NOT_FOUND", "Context map not found.");

  const isPersonalOwner = Boolean(userId && mapView.createdByUserId === userId);
  const isMaster = mapView.createdByUserId === null;
  const canUpdateMaster = isMaster && canApproveContextGraph(actor, membership);
  invariant(isPersonalOwner || isMaster, 403, "FORBIDDEN", "You cannot update another user's context map view.");

  if (!isPersonalOwner && !canUpdateMaster) {
    const proposedDiff = await createContextGraphProposedDiff(actor, {
      workspaceId: params.workspaceId,
      lineageInputs: [{ kind: "ContextMapView", id: mapView.id }],
      lineageRoots: await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "ContextMapView", id: mapView.id, snapshot: mapView }]),
      reason: `Request to update master map layout: ${mapView.name}`,
      evidence: {
        kind: "context-map-layout-update",
        mapViewId: params.mapViewId,
        itemCount: params.items.length,
      },
      diff: {
        mapLayoutUpdates: [{
          mapViewId: params.mapViewId,
          items: params.items,
        }],
      },
    });
    return { mode: "proposed" as const, proposedDiffId: proposedDiff.id, updated: 0 };
  }

  await prisma.$transaction(async (tx) => {
    await applyMapLayoutUpdateWithTx(tx, params.workspaceId, {
      mapViewId: params.mapViewId,
      items: params.items,
    }, { actor, capture: { humanOriginal: actor.kind === "user", lineageInputs: actor.kind === "user" ? [] : undefined } });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "context-map.layout.updated",
      entityType: "ContextMapView",
      entityId: params.mapViewId,
      meta: { count: params.items.length },
    });
  });

  return { mode: "updated" as const, updated: params.items.length };
}

export async function createPersonalContextMapView(actor: AppActor, params: {
  workspaceId: string;
  sourceMapViewId: string;
  name?: string | null;
  items?: ContextMapLayoutItemInput[];
}) {
  const membership = await requireGraphPropose(actor, params.workspaceId);
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only workspace members can save personal map views.");
  invariant(membership?.isActive, 403, "NOT_A_MEMBER", "You are not an active member of this workspace.");

  const sourceMapView = await prisma.contextMapView.findFirst({
    where: { id: params.sourceMapViewId, ...visibleMapViewWhere(params.workspaceId, actor.user.id) },
  });
  invariant(sourceMapView, 404, "NOT_FOUND", "Context map not found.");
  invariant((await readableMapViews(actor, params.workspaceId, [sourceMapView])).length,
    404, "NOT_FOUND", "Context map not found.");
  const sourceRoots = await captureArtifactInputProof(actor, params.workspaceId,
    [{ kind: "ContextMapView", id: sourceMapView.id, snapshot: sourceMapView }]);
  invariant(sourceRoots, 404, "NOT_FOUND", "Context map not found.");

  const query = (sourceMapView.query && typeof sourceMapView.query === "object" && !Array.isArray(sourceMapView.query))
    ? { ...(sourceMapView.query as JsonRecord) }
    : {};
  const name = params.name?.trim() || `${sourceMapView.name} - personal`;
  const sourceLayoutRows = params.items?.length ? [] : await prisma.contextMapLayoutItem.findMany({
    where: { mapViewId: sourceMapView.id },
  });
  const readableSourceLayoutIds = await readableArtifactIds(actor, params.workspaceId,
    "ContextMapLayoutItem", sourceLayoutRows);
  const layoutRoots = new Map<string, NonNullable<GraphLineageCapture["lineageRoots"]>>();
  for (const row of sourceLayoutRows.filter(row => readableSourceLayoutIds.has(row.id))) {
    layoutRoots.set(row.id, await captureArtifactInputProof(actor, params.workspaceId,
      [{ kind: "ContextMapLayoutItem", id: row.id, snapshot: row }]));
  }
  const sourceLayoutItems = params.items?.length
    ? params.items.map((item) => ({ item: normalizeLayoutItem(item), sourceId: null }))
    : sourceLayoutRows.filter((item) => readableSourceLayoutIds.has(item.id)).map((item) => ({
      sourceId: item.id, item: normalizeLayoutItem({
      objectId: item.objectId,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      visualState: item.visualState && typeof item.visualState === "object" && !Array.isArray(item.visualState)
        ? item.visualState as JsonRecord
        : undefined,
    }) }));

  return prisma.$transaction(async (tx) => {
    for (const { item: normalized } of sourceLayoutItems) {
      await resolveObjectId(tx, params.workspaceId, normalized.objectId);
    }

    const mapView = await tx.contextMapView.create({
      data: {
        workspaceId: params.workspaceId,
        name: name.slice(0, 120),
        viewType: sourceMapView.viewType,
        query: {
          ...query,
          scope: "personal",
          sourceMapViewId: sourceMapView.id,
          savedFromName: sourceMapView.name,
          savedAt: new Date().toISOString(),
        },
        createdByUserId: actor.user.id,
      },
    });
    await captureGraphLineage(tx, actor, params.workspaceId,
      { kind: "ContextMapView", id: mapView.id }, mapView,
      { humanOriginal: true, lineageInputs: [], lineageRoots: sourceRoots });

    for (const { item: normalized, sourceId } of sourceLayoutItems) {
      const saved = await tx.contextMapLayoutItem.create({
        data: {
          mapViewId: mapView.id,
          objectId: normalized.objectId,
          x: normalized.x,
          y: normalized.y,
          width: normalized.width,
          height: normalized.height,
          visualState: normalized.visualState,
        },
      });
      await captureGraphLineage(tx, actor, params.workspaceId,
        { kind: "ContextMapLayoutItem", id: saved.id }, saved,
        { humanOriginal: true, lineageInputs: [], lineageRoots: sourceId ? layoutRoots.get(sourceId) : [] },
        null, [{ kind: "ContextGraphObject", id: saved.objectId }]);
    }

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "context-map.view.personal.created",
      entityType: "ContextMapView",
      entityId: mapView.id,
      meta: { sourceMapViewId: sourceMapView.id, name: mapView.name, count: sourceLayoutItems.length },
    });

    return mapView;
  });
}

function validateDiff(diff: unknown): asserts diff is ContextGraphDiffInput {
  invariant(isJsonRecord(diff), 400, "INVALID_INPUT", "Context graph diff must be an object.");
  requireOptionalArray(diff.objects, "Context graph diff objects must be an array.");
  requireOptionalArray(diff.objectUpdates, "Context graph diff objectUpdates must be an array.");
  requireOptionalArray(diff.relationships, "Context graph diff relationships must be an array.");
  requireOptionalArray(diff.relationshipUpdates, "Context graph diff relationshipUpdates must be an array.");
  requireOptionalArray(diff.evidenceRefs, "Context graph diff evidence refs must be an array.");
  requireOptionalArray(diff.mapLayoutUpdates, "Context graph diff map layout updates must be an array.");

  const objects = diff.objects as unknown[] | undefined;
  const objectUpdates = diff.objectUpdates as unknown[] | undefined;
  const relationships = diff.relationships as unknown[] | undefined;
  const relationshipUpdates = diff.relationshipUpdates as unknown[] | undefined;
  const evidenceRefs = diff.evidenceRefs as unknown[] | undefined;
  const mapLayoutUpdates = diff.mapLayoutUpdates as unknown[] | undefined;

  for (const object of objects ?? []) {
    invariant(isJsonRecord(object), 400, "INVALID_INPUT", "Context graph diff objects must be objects.");
    normalizeObjectInput(object as ContextGraphObjectInput);
  }
  for (const objectUpdate of objectUpdates ?? []) {
    invariant(isJsonRecord(objectUpdate), 400, "INVALID_INPUT", "Context graph diff objectUpdates must be objects.");
    normalizeObjectUpdateInput(objectUpdate as ContextGraphObjectUpdateInput);
  }
  for (const relationship of relationships ?? []) {
    invariant(isJsonRecord(relationship), 400, "INVALID_INPUT", "Context graph diff relationships must be objects.");
    normalizeRelationshipInput(relationship as ContextGraphRelationshipInput);
  }
  for (const relationshipUpdate of relationshipUpdates ?? []) {
    invariant(isJsonRecord(relationshipUpdate), 400, "INVALID_INPUT", "Context graph diff relationshipUpdates must be objects.");
    normalizeRelationshipUpdateInput(relationshipUpdate as ContextGraphRelationshipUpdateInput);
  }
  for (const evidence of evidenceRefs ?? []) {
    invariant(isJsonRecord(evidence), 400, "INVALID_INPUT", "Context graph diff evidence refs must be objects.");
    validateEvidenceInput(evidence as ContextGraphEvidenceInput);
  }
  for (const layoutUpdate of mapLayoutUpdates ?? []) {
    invariant(isJsonRecord(layoutUpdate), 400, "INVALID_INPUT", "Context graph diff map layout updates must be objects.");
    const mapViewId = requireStringField(layoutUpdate.mapViewId, "Map view id is required.").trim();
    invariant(mapViewId.length > 0, 400, "INVALID_INPUT", "Map view id is required.");
    invariant(Array.isArray(layoutUpdate.items), 400, "INVALID_INPUT", "Map layout update items must be an array.");
    invariant(layoutUpdate.items.length > 0, 400, "INVALID_INPUT", "At least one layout item is required.");
    for (const item of layoutUpdate.items) {
      invariant(isJsonRecord(item), 400, "INVALID_INPUT", "Map layout update items must be objects.");
      validateProposedLayoutItem(item as ContextMapProposedLayoutItemInput);
    }
  }
}

export async function createContextGraphProposedDiff(actor: AppActor, params: GraphLineageCapture & {
  workspaceId: string;
  diff: ContextGraphDiffInput;
  reason?: string | null;
  evidence?: JsonRecord | null;
  agentRunId?: string | null;
}) {
  await requireGraphPropose(actor, params.workspaceId);
  validateDiff(params.diff);

  return prisma.$transaction(async (tx) => {
    const proposedDiff = await tx.contextGraphProposedDiff.create({
      data: {
        workspaceId: params.workspaceId,
        proposedByType: actor.kind === "agent" ? "agent" : "human",
        proposedByUserId: actor.kind === "user" ? actor.user.id : null,
        proposedByAgentRunId: params.agentRunId ?? null,
        diffJson: params.diff as Prisma.InputJsonObject,
        reason: params.reason?.trim() || null,
        evidenceJson: params.evidence ? (params.evidence as Prisma.InputJsonObject) : Prisma.JsonNull,
        status: "pending",
      },
    });
    const referencedInputs = graphDiffInputs(params.diff);
    if (referencedInputs) await captureGraphLineage(tx, actor, params.workspaceId,
      { kind: "ContextGraphProposedDiff", id: proposedDiff.id }, proposedDiff, params, null, referencedInputs);
    else await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId, artifact: { kind: "ContextGraphProposedDiff", id: proposedDiff.id }, content: proposedDiff });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "context-graph.diff.proposed",
      entityType: "ContextGraphProposedDiff",
      entityId: proposedDiff.id,
      meta: {
        reason: proposedDiff.reason,
        objectCount: params.diff.objects?.length ?? 0,
        objectUpdateCount: params.diff.objectUpdates?.length ?? 0,
        relationshipCount: params.diff.relationships?.length ?? 0,
        relationshipUpdateCount: params.diff.relationshipUpdates?.length ?? 0,
        mapLayoutUpdateCount: params.diff.mapLayoutUpdates?.length ?? 0,
      },
    });
    return proposedDiff;
  });
}

export async function listContextGraphProposedDiffs(actor: AppActor, params: {
  workspaceId: string;
  status?: string[];
  take?: number;
}) {
  await requireGraphRead(actor, params.workspaceId);
  const readGraph = graphReadWithRebuild(actor, params.workspaceId);
  const candidates = await prisma.contextGraphProposedDiff.findMany({
    where: {
      workspaceId: params.workspaceId,
      ...(params.status?.length ? { status: { in: params.status } } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  const canonical = await readGraph("ContextGraphProposedDiff", candidates);
  const projection = await effectiveGraphVariantProjection(actor, params.workspaceId);
  const output = [...canonical, ...projection.proposedDiffs.filter(row => !params.status?.length || params.status.includes(row.status))]
    .sort((left, right) => right.createdAt.valueOf() - left.createdAt.valueOf());
  const roots = [...await captureArtifactInputProof(actor, params.workspaceId, [
    { kind: "Workspace", id: params.workspaceId },
    ...canonical.map(row => ({ kind: "ContextGraphProposedDiff" as const, id: row.id, snapshot: row })),
  ]), ...projection.lineageRoots];
  await assertEffectiveGraphVariantProjection(actor, params.workspaceId, projection);
  invariant(await isArtifactInputProofReadable(actor, params.workspaceId, roots), 409, "SOURCE_CHANGED", "Graph proposals changed before release.");
  return output.slice(0, params.take ?? 50);
}

export async function updateContextGraphProposedDiff(actor: AppActor, params: GraphLineageCapture & {
  workspaceId: string;
  proposedDiffId: string;
  reason?: string | null;
  diff: ContextGraphDiffInput;
  evidence?: JsonRecord | null;
}) {
  await requireGraphApprove(actor, params.workspaceId);
  validateDiff(params.diff);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ContextGraphProposedDiff" WHERE id = ${params.proposedDiffId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const proposedDiff = await tx.contextGraphProposedDiff.findFirst({
      where: { id: params.proposedDiffId, workspaceId: params.workspaceId },
    });
    invariant(proposedDiff, 404, "NOT_FOUND", "Proposed graph diff not found.");
    invariant((await readableGraphRecords(actor, params.workspaceId, "ContextGraphProposedDiff", [proposedDiff], tx)).length,
      404, "NOT_FOUND", "Proposed graph diff not found.");
    invariant(proposedDiff.status === "pending", 409, "INVALID_STATE", "Only pending graph diffs can be edited.");

    const referencedInputs = graphDiffInputs(params.diff);
    const prepared = referencedInputs ? await prepareGraphLineage(tx, actor, params.workspaceId, params,
      { kind: "ContextGraphProposedDiff", id: proposedDiff.id }, referencedInputs) : null;
    const updated = await tx.contextGraphProposedDiff.update({
      where: { id: proposedDiff.id },
      data: {
        reason: params.reason?.trim() || null,
        diffJson: params.diff as Prisma.InputJsonObject,
        ...(params.evidence !== undefined ? {
          evidenceJson: params.evidence ? (params.evidence as Prisma.InputJsonObject) : Prisma.JsonNull,
        } : {}),
      },
    });
    if (prepared) await captureGraphLineage(tx, actor, params.workspaceId,
      { kind: "ContextGraphProposedDiff", id: updated.id }, updated, prepared);
    else await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId, artifact: { kind: "ContextGraphProposedDiff", id: updated.id }, content: updated });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "context-graph.diff.edited",
      entityType: "ContextGraphProposedDiff",
      entityId: proposedDiff.id,
      meta: {
        objectCount: params.diff.objects?.length ?? 0,
        objectUpdateCount: params.diff.objectUpdates?.length ?? 0,
        relationshipCount: params.diff.relationships?.length ?? 0,
        relationshipUpdateCount: params.diff.relationshipUpdates?.length ?? 0,
        evidenceRefCount: params.diff.evidenceRefs?.length ?? 0,
        mapLayoutUpdateCount: params.diff.mapLayoutUpdates?.length ?? 0,
      },
    });
    return updated;
  });
}

/** Regenerated proposals retain their immutable variant as source authority.
 * Replay providers outside SQL, then bind the same proposal and complete roots
 * around the ordinary native transition. Neither metadata nor a virtual ID grants access. */
async function withVariantProposalTransaction<T>(actor: AppActor, params: { workspaceId: string; proposedDiffId: string },
  work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const variant = await prisma.genericDerivedArtifactVariant.findFirst({ where: { workspaceId: params.workspaceId,
    generatorKey: GRAPH_SOURCE_VARIANT_JOB_TYPE, payloadJson: { path: ["proposedDiff", "id"], equals: params.proposedDiffId } } });
  if (!variant) return prisma.$transaction(work);
  const member = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  invariant(actor.kind === "user" && member?.id === variant.ownerMemberId,
    404, "NOT_FOUND", "Proposed graph diff not found.");
  const row = await prisma.contextGraphProposedDiff.findFirst({ where: { id: params.proposedDiffId, workspaceId: params.workspaceId } });
  invariant(row, 404, "NOT_FOUND", "Proposed graph diff not found.");
  const roots = await currentArtifactInputRoots(prisma, params.workspaceId, { kind: "ContextGraphProposedDiff", id: row.id }, row);
  invariant(roots?.length, 409, "UNKNOWN_LINEAGE", "Graph proposal has no complete input receipt.");
  const token = await prepareArtifactCommitPreflight(actor, params.workspaceId, roots);
  return prisma.$transaction(tx => withArtifactCommitPreflight(actor, params.workspaceId, tx, roots, token, () => work(tx), {
    beforeSourceEpochs: async () => {
      await tx.$queryRaw`SELECT id FROM "ContextGraphProposedDiff" WHERE id = ${row.id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
      const locked = await tx.contextGraphProposedDiff.findFirst({ where: { id: row.id, workspaceId: params.workspaceId } });
      invariant(locked && lineageContentFingerprint("ContextGraphProposedDiff", locked) === lineageContentFingerprint("ContextGraphProposedDiff", row),
        409, "SOURCE_CHANGED", "Graph proposal changed before its native transition.");
    },
  }));
}

export async function reviewContextGraphProposedDiff(actor: AppActor, params: {
  workspaceId: string;
  proposedDiffId: string;
  status: "approved" | "rejected";
}) {
  await requireGraphApprove(actor, params.workspaceId);
  const reviewedByUserId = actor.kind === "user" ? actor.user.id : null;
  return withVariantProposalTransaction(actor, params, async (tx) => {
    await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, tx,
      ...(actor.kind === "user" ? { allowedRoles: ["ADMIN", "FACILITATOR"] } : {}) });
    await tx.$queryRaw`SELECT id FROM "ContextGraphProposedDiff" WHERE id = ${params.proposedDiffId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const proposedDiff = await tx.contextGraphProposedDiff.findFirst({
      where: { id: params.proposedDiffId, workspaceId: params.workspaceId },
    });
    invariant(proposedDiff, 404, "NOT_FOUND", "Proposed graph diff not found.");
    invariant((await readableGraphRecords(actor, params.workspaceId, "ContextGraphProposedDiff", [proposedDiff], tx)).length,
      404, "NOT_FOUND", "Proposed graph diff not found.");
    invariant(proposedDiff.status === "pending", 409, "INVALID_STATE", "Only pending graph diffs can be reviewed.");
    const updated = await tx.contextGraphProposedDiff.update({
      where: { id: proposedDiff.id },
      data: {
        status: params.status,
        reviewedByUserId,
        reviewedAt: new Date(),
      },
    });
    await advanceHumanArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "ContextGraphProposedDiff", id: updated.id }, before: proposedDiff, after: updated });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: `context-graph.diff.${params.status}`,
      entityType: "ContextGraphProposedDiff",
      entityId: proposedDiff.id,
      meta: { status: params.status, ...(params.status === "approved" ? {
        graphApproval: await captureGraphReviewApproval(tx, actor, params.workspaceId, updated),
      } : {}) },
    });
    return updated;
  });
}

export async function applyContextGraphProposedDiff(actor: AppActor, params: {
  workspaceId: string;
  proposedDiffId: string;
}) {
  await requireGraphApprove(actor, params.workspaceId);
  const reviewedByUserId = actor.kind === "user" ? actor.user.id : null;

  return withVariantProposalTransaction(actor, params, async (tx) => {
    await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, tx,
      ...(actor.kind === "user" ? { allowedRoles: ["ADMIN", "FACILITATOR"] } : {}) });
    await tx.$queryRaw`SELECT id FROM "ContextGraphProposedDiff" WHERE id = ${params.proposedDiffId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const proposedDiff = await tx.contextGraphProposedDiff.findFirst({
      where: { id: params.proposedDiffId, workspaceId: params.workspaceId },
    });
    invariant(proposedDiff, 404, "NOT_FOUND", "Proposed graph diff not found.");
    invariant((await readableGraphRecords(actor, params.workspaceId, "ContextGraphProposedDiff", [proposedDiff], tx)).length,
      404, "NOT_FOUND", "Proposed graph diff not found.");
    invariant(["pending", "approved"].includes(proposedDiff.status), 409, "INVALID_STATE", "Only pending or approved graph diffs can be applied.");

    const priorRoots = await currentArtifactInputRoots(tx, params.workspaceId,
      { kind: "ContextGraphProposedDiff", id: proposedDiff.id }, proposedDiff);
    invariant(priorRoots, 409, "UNKNOWN_LINEAGE", "Proposed graph diff has incomplete lineage.");
    for (const root of [...priorRoots].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))) {
      if (root.kind === "ContextGraphObject") {
        await tx.$queryRaw`SELECT id FROM "ContextGraphObject" WHERE id = ${root.id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
      } else if (root.kind === "ContextGraphRelationship") {
        await tx.$queryRaw`SELECT id FROM "ContextGraphRelationship" WHERE id = ${root.id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
      }
    }
    invariant((await readableGraphRecords(actor, params.workspaceId, "ContextGraphProposedDiff", [proposedDiff], tx)).length,
      409, "SOURCE_CHANGED", "Proposed graph diff inputs changed.");
    const diff = proposedDiff.diffJson as ContextGraphDiffInput;
    validateDiff(diff);
    const capture = await prepareGraphLineage(tx, actor, params.workspaceId,
      { lineageInputs: [{ kind: "ContextGraphProposedDiff", id: proposedDiff.id }], lineageRoots: priorRoots });
    const refToObjectId = new Map<string, string>();
    const refToRelationshipId = new Map<string, string>();
    const objectIds: string[] = [];
    const objectUpdateIds: string[] = [];
    const relationshipIds: string[] = [];
    const relationshipUpdateIds: string[] = [];
    const layoutUpdates: Array<{ mapViewId: string; updated: number }> = [];

    for (const objectInput of diff.objects ?? []) {
      const object = await upsertObjectWithTx(tx, actor, params.workspaceId, {
        ...objectInput,
        ...capture,
        status: objectInput.status ?? "approved",
      }, proposedDiff.proposedByAgentRunId);
      objectIds.push(object.id);
      if (objectInput.ref) refToObjectId.set(objectInput.ref, object.id);
    }

    for (const objectUpdateInput of diff.objectUpdates ?? []) {
      const object = await updateObjectWithTx(tx, actor, params.workspaceId, objectUpdateInput, capture);
      objectUpdateIds.push(object.id);
    }

    for (const relationshipInput of diff.relationships ?? []) {
      const relationship = await upsertRelationshipWithTx(tx, actor, params.workspaceId, {
        ...relationshipInput,
        ...capture,
        status: relationshipInput.status ?? "approved",
      }, refToObjectId, proposedDiff.proposedByAgentRunId);
      relationshipIds.push(relationship.id);
      if (relationshipInput.ref) refToRelationshipId.set(relationshipInput.ref, relationship.id);
    }

    for (const relationshipUpdateInput of diff.relationshipUpdates ?? []) {
      const relationship = await updateRelationshipWithTx(tx, actor, params.workspaceId, relationshipUpdateInput, capture);
      relationshipUpdateIds.push(relationship.id);
    }

    for (const evidenceInput of diff.evidenceRefs ?? []) {
      await attachEvidenceWithTx(tx, actor, params.workspaceId, { ...evidenceInput, ...capture }, refToObjectId, refToRelationshipId);
    }

    for (const layoutUpdate of diff.mapLayoutUpdates ?? []) {
      layoutUpdates.push(await applyMapLayoutUpdateWithTx(tx, params.workspaceId, layoutUpdate, {
        actor,
        requireMasterOrOwner: true,
        refToObjectId,
        capture,
      }));
    }

    const updated = await tx.contextGraphProposedDiff.update({
      where: { id: proposedDiff.id },
      data: {
        status: "applied",
        reviewedByUserId: proposedDiff.reviewedByUserId ?? reviewedByUserId,
        reviewedAt: proposedDiff.reviewedAt ?? new Date(),
        appliedAt: new Date(),
      },
    });

    await captureGraphLineage(tx, actor, params.workspaceId,
      { kind: "ContextGraphProposedDiff", id: updated.id }, updated, capture);
    if (proposedDiff.status === "pending") await recordAudit(tx, actor, {
      workspaceId: params.workspaceId, action: "context-graph.diff.approved", entityType: "ContextGraphProposedDiff", entityId: updated.id,
      meta: { graphApproval: await captureGraphReviewApproval(tx, actor, params.workspaceId, updated) },
    });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "context-graph.diff.applied",
      entityType: "ContextGraphProposedDiff",
      entityId: proposedDiff.id,
      meta: { objectIds, objectUpdateIds, relationshipIds, relationshipUpdateIds, layoutUpdates },
    });
    await appendEvents(tx, [{
      workspaceId: params.workspaceId,
      type: "context-graph.diff.applied",
      aggregateType: "ContextGraphProposedDiff",
      aggregateId: proposedDiff.id,
      payload: { proposedDiffId: proposedDiff.id, objectIds, objectUpdateIds, relationshipIds, relationshipUpdateIds, layoutUpdates },
    }]);

    return updated;
  });
}

const OBJECT_CONTEXT_WEIGHTS: Record<string, number> = {
  Task: 36,
  Risk: 34,
  Decision: 30,
  ProcessStep: 28,
  Process: 24,
  Team: 22,
  Role: 20,
  Person: 20,
  Tool: 18,
  Meeting: 12,
  Document: 10,
  Question: 26,
};

const RELATIONSHIP_CONTEXT_WEIGHTS: Record<string, number> = {
  blocks: 44,
  depends_on: 38,
  owns: 34,
  assigned_to: 34,
  needs_approval_from: 32,
  supports: 24,
  uses: 20,
  part_of: 18,
  decided_in: 16,
  created_in: 14,
  contradicts: 30,
};

function statusContextWeight(status: string) {
  if (status === "disputed" || status === "stale") return 28;
  if (status === "proposed" || status === "draft") return 18;
  if (status === "approved") return 8;
  return 0;
}

function relationshipContextWeight(type: string) {
  return RELATIONSHIP_CONTEXT_WEIGHTS[type] ?? 8;
}

export async function buildSelectedRegionContext(actor: AppActor, params: {
  workspaceId: string;
  mapViewId?: string | null;
  objectIds: string[];
  depth?: number;
  asOf?: Date | string | null;
  includeStale?: boolean;
  maxSensitivity?: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "PII";
}) {
  const membership = await requireGraphRead(actor, params.workspaceId);
  const depth = Math.min(Math.max(params.depth ?? 2, 0), 2);
  const selectedIds = [...new Set(params.objectIds)];
  invariant(selectedIds.length > 0, 400, "INVALID_INPUT", "Select at least one context graph object.");

  const asOf = normalizeDate(params.asOf);
  const mapView = params.mapViewId ? await prisma.contextMapView.findFirst({ where: {
    id: params.mapViewId, ...visibleMapViewWhere(params.workspaceId, actorUserId(actor)),
  } }) : null;
  if (params.mapViewId) invariant(mapView && (await readableMapViews(actor, params.workspaceId, [mapView])).length,
    404, "NOT_FOUND", "Context map not found.");
  const readGraph = graphReadWithRebuild(actor, params.workspaceId, mapView);
  const variantProjection = await effectiveGraphVariantProjection(actor, params.workspaceId, mapView, asOf);
  const timeFilter = asOf
    ? {
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: asOf } }] },
        { OR: [{ validTo: null }, { validTo: { gt: asOf } }] },
      ],
    }
    : {};

  const objectsById = new Map<string, Awaited<ReturnType<typeof prisma.contextGraphObject.findMany>>[number]>();
  const relationshipsById = new Map<string, Awaited<ReturnType<typeof prisma.contextGraphRelationship.findMany>>[number]>();
  const objectDistanceById = new Map<string, number>();
  const relationshipDistanceById = new Map<string, number>();
  let frontier = new Set(selectedIds);

  const selectedObjects = await prisma.contextGraphObject.findMany({
    where: {
      id: { in: selectedIds },
      workspaceId: params.workspaceId,
      ...timeFilter,
    },
  });
  const readableSelectedObjects = [...await readGraph("ContextGraphObject", selectedObjects),
    ...variantProjection.objects.filter(object => selectedIds.includes(object.id))].filter((object) => isReadableStatus(object.status, params.includeStale));
  invariant(readableSelectedObjects.length === selectedIds.length, 404, "NOT_FOUND", "One or more selected objects were not found.");
  for (const object of readableSelectedObjects) {
    objectsById.set(object.id, object);
    objectDistanceById.set(object.id, 0);
  }

  for (let currentDepth = 0; currentDepth < depth; currentDepth += 1) {
    const frontierIds = [...frontier];
    const relationships = await prisma.contextGraphRelationship.findMany({
      where: {
        workspaceId: params.workspaceId,
        OR: [
          { sourceObjectId: { in: frontierIds } },
          { targetObjectId: { in: frontierIds } },
        ],
        ...timeFilter,
      },
    });
    const nextFrontier = new Set<string>();
    for (const relationship of [...await readGraph("ContextGraphRelationship", relationships),
      ...variantProjection.relationships.filter(row => frontier.has(row.sourceObjectId) || frontier.has(row.targetObjectId))]) {
      if (!isReadableStatus(relationship.status, params.includeStale)) continue;
      relationshipsById.set(relationship.id, relationship);
      relationshipDistanceById.set(
        relationship.id,
        Math.min(
          relationshipDistanceById.get(relationship.id) ?? Number.POSITIVE_INFINITY,
          currentDepth,
        ),
      );
      if (!objectsById.has(relationship.sourceObjectId)) nextFrontier.add(relationship.sourceObjectId);
      if (!objectsById.has(relationship.targetObjectId)) nextFrontier.add(relationship.targetObjectId);
    }
    if (nextFrontier.size === 0) break;
    const neighbors = await prisma.contextGraphObject.findMany({
      where: {
        id: { in: [...nextFrontier] },
        workspaceId: params.workspaceId,
        ...timeFilter,
      },
    });
    frontier = new Set();
    for (const object of [...await readGraph("ContextGraphObject", neighbors),
      ...variantProjection.objects.filter(row => nextFrontier.has(row.id))]) {
      if (!isReadableStatus(object.status, params.includeStale)) continue;
      objectsById.set(object.id, object);
      objectDistanceById.set(
        object.id,
        Math.min(objectDistanceById.get(object.id) ?? Number.POSITIVE_INFINITY, currentDepth + 1),
      );
      frontier.add(object.id);
    }
  }

  for (const [id, relationship] of relationshipsById) {
    if (!objectsById.has(relationship.sourceObjectId) || !objectsById.has(relationship.targetObjectId)) relationshipsById.delete(id);
  }
  const objectIds = [...objectsById.keys()];
  const relationshipIds = [...relationshipsById.keys()];
  const candidateEvidenceRefs = await prisma.contextGraphEvidenceRef.findMany({
    where: {
      workspaceId: params.workspaceId,
      OR: [
        { objectId: { in: objectIds } },
        { relationshipId: { in: relationshipIds } },
      ],
    },
    orderBy: { createdAt: "desc" },
  });
  const evidenceRefs = [...await readGraph("ContextGraphEvidenceRef", candidateEvidenceRefs), ...variantProjection.evidenceRefs]
    .filter((ref) => !ref.knowledgeChunkId && (ref.objectId ? objectsById.has(ref.objectId)
      : Boolean(ref.relationshipId && relationshipsById.has(ref.relationshipId)))).slice(0, 80);
  const maxSensitivity = params.maxSensitivity ?? (membership ? "INTERNAL" : "PUBLIC");
  // Chunk text needs its own committed receipt and content snapshot; evidence lineage alone is insufficient.
  const knowledgeChunks: Array<{ id: string; sourceType: string; sourceId: string; sourceTitle: string | null;
    chunkIndex: number; content: string; sensitivity: string }> = [];

  const staleOrDisputed = [
    ...[...objectsById.values()].filter((object) => object.status === "stale" || object.status === "disputed"),
    ...[...relationshipsById.values()].filter((relationship) => relationship.status === "stale" || relationship.status === "disputed"),
  ];

  const selectedIdSet = new Set(selectedIds);
  const objectEvidenceCountById = new Map<string, number>();
  const relationshipEvidenceCountById = new Map<string, number>();
  for (const evidenceRef of evidenceRefs) {
    if (evidenceRef.objectId) objectEvidenceCountById.set(evidenceRef.objectId, (objectEvidenceCountById.get(evidenceRef.objectId) ?? 0) + 1);
    if (evidenceRef.relationshipId) relationshipEvidenceCountById.set(evidenceRef.relationshipId, (relationshipEvidenceCountById.get(evidenceRef.relationshipId) ?? 0) + 1);
  }

  const relationshipsByObjectId = new Map<string, Array<Awaited<ReturnType<typeof prisma.contextGraphRelationship.findMany>>[number]>>();
  for (const relationship of relationshipsById.values()) {
    const sourceRelationships = relationshipsByObjectId.get(relationship.sourceObjectId) ?? [];
    sourceRelationships.push(relationship);
    relationshipsByObjectId.set(relationship.sourceObjectId, sourceRelationships);
    const targetRelationships = relationshipsByObjectId.get(relationship.targetObjectId) ?? [];
    targetRelationships.push(relationship);
    relationshipsByObjectId.set(relationship.targetObjectId, targetRelationships);
  }

  const objectScore = (object: Awaited<ReturnType<typeof prisma.contextGraphObject.findMany>>[number]) => {
    const distance = objectDistanceById.get(object.id) ?? 3;
    const workState = stringProperty(object.properties, "workState");
    const relatedRelationshipWeight = Math.max(
      0,
      ...(relationshipsByObjectId.get(object.id) ?? []).map((relationship) => relationshipContextWeight(relationship.relationshipType)),
    );
    return (
      (selectedIdSet.has(object.id) ? 180 : 0)
      + Math.max(0, 3 - distance) * 42
      + (OBJECT_CONTEXT_WEIGHTS[object.objectType] ?? 8)
      + statusContextWeight(object.status)
      + (objectEvidenceCountById.get(object.id) ?? 0) * 12
      + relatedRelationshipWeight * 0.6
      + (workState === "blocked" ? 28 : workState === "in_progress" ? 18 : 0)
    );
  };

  const relationshipScore = (relationship: Awaited<ReturnType<typeof prisma.contextGraphRelationship.findMany>>[number]) => {
    const distance = relationshipDistanceById.get(relationship.id) ?? 3;
    const touchesSelection = selectedIdSet.has(relationship.sourceObjectId) || selectedIdSet.has(relationship.targetObjectId);
    return (
      (touchesSelection ? 120 : 0)
      + Math.max(0, 3 - distance) * 32
      + relationshipContextWeight(relationship.relationshipType)
      + statusContextWeight(relationship.status)
      + (relationshipEvidenceCountById.get(relationship.id) ?? 0) * 14
    );
  };

  const rankedObjects = [...objectsById.values()].sort((left, right) => objectScore(right) - objectScore(left) || left.title.localeCompare(right.title));
  const rankedRelationships = [...relationshipsById.values()].sort((left, right) => relationshipScore(right) - relationshipScore(left) || left.relationshipType.localeCompare(right.relationshipType));

  const directNeighbors = rankedRelationships
    .filter((relationship) => {
      const sourceSelected = selectedIdSet.has(relationship.sourceObjectId);
      const targetSelected = selectedIdSet.has(relationship.targetObjectId);
      return sourceSelected !== targetSelected;
    })
    .map((relationship) => {
      const sourceSelected = selectedIdSet.has(relationship.sourceObjectId);
      const neighborId = sourceSelected ? relationship.targetObjectId : relationship.sourceObjectId;
      const neighbor = objectsById.get(neighborId);
      return neighbor ? {
        objectId: neighbor.id,
        title: neighbor.title,
        objectType: neighbor.objectType,
        relationshipId: relationship.id,
        relationshipType: relationship.relationshipType,
        direction: sourceSelected ? "outgoing" : "incoming",
        status: relationship.status,
        score: relationshipScore(relationship),
      } : null;
    })
    .filter((neighbor): neighbor is NonNullable<typeof neighbor> => Boolean(neighbor))
    .slice(0, 12);

  const chunkById = new Map(knowledgeChunks.map((chunk) => [chunk.id, chunk]));
  const sourceRecordsByKey = new Map<string, {
    sourceType: string;
    sourceId: string;
    sourceTitle: string | null;
    quote: string | null;
    relevanceScore: number | null;
    evidenceRefIds: string[];
  }>();
  for (const evidenceRef of evidenceRefs) {
    const key = `${evidenceRef.sourceType}:${evidenceRef.sourceId}`;
    const chunk = evidenceRef.knowledgeChunkId ? chunkById.get(evidenceRef.knowledgeChunkId) : null;
    const existing = sourceRecordsByKey.get(key);
    const relevanceScore = evidenceRef.relevanceScore ?? existing?.relevanceScore ?? null;
    sourceRecordsByKey.set(key, {
      sourceType: evidenceRef.sourceType,
      sourceId: evidenceRef.sourceId,
      sourceTitle: chunk?.sourceTitle ?? existing?.sourceTitle ?? null,
      quote: existing?.quote ?? evidenceRef.quote ?? null,
      relevanceScore: existing?.relevanceScore != null && relevanceScore != null
        ? Math.max(existing.relevanceScore, relevanceScore)
        : relevanceScore,
      evidenceRefIds: [...(existing?.evidenceRefIds ?? []), evidenceRef.id],
    });
  }
  const sourceRecords = [...sourceRecordsByKey.values()]
    .sort((left, right) => (right.relevanceScore ?? 0) - (left.relevanceScore ?? 0) || left.sourceType.localeCompare(right.sourceType))
    .slice(0, 12);

  const ownerRelationshipTypes = new Set(["owns", "assigned_to", "needs_approval_from"]);
  const ownerObjectTypes = new Set(["Person", "Team", "Role"]);
  const ownerRequiredTypes = new Set(["Process", "ProcessStep", "Decision", "Task", "Risk"]);
  const evidenceRequiredTypes = new Set(["Process", "ProcessStep", "Decision", "Task", "Risk"]);
  const focusObjects = rankedObjects.filter((object) => (objectDistanceById.get(object.id) ?? 3) <= 1).slice(0, 16);
  const contextGaps: Array<{ id: string; objectId: string; kind: string; severity: "high" | "medium" | "low"; title: string; detail: string }> = [];

  for (const object of focusObjects) {
    const relatedRelationships = relationshipsByObjectId.get(object.id) ?? [];
    const hasOwner = relatedRelationships.some((relationship) => {
      if (!ownerRelationshipTypes.has(relationship.relationshipType)) return false;
      const otherId = relationship.sourceObjectId === object.id ? relationship.targetObjectId : relationship.sourceObjectId;
      const otherObject = objectsById.get(otherId);
      return otherObject ? ownerObjectTypes.has(otherObject.objectType) : false;
    });
    const hasEvidence = (objectEvidenceCountById.get(object.id) ?? 0) > 0
      || relatedRelationships.some((relationship) => (relationshipEvidenceCountById.get(relationship.id) ?? 0) > 0);
    const hasBlocker = relatedRelationships.some((relationship) => (
      relationship.relationshipType === "blocks" && relationship.targetObjectId === object.id
    ));
    const workState = stringProperty(object.properties, "workState");

    if (ownerRequiredTypes.has(object.objectType) && !hasOwner) {
      contextGaps.push({
        id: `${object.id}:missing-owner`,
        objectId: object.id,
        kind: "missing_owner",
        severity: object.objectType === "Task" || object.objectType === "Risk" ? "high" : "medium",
        title: `Missing owner: ${object.title}`,
        detail: `${object.objectType} has no direct owns, assigned_to, or approval-owner relationship in this region.`,
      });
    }
    if (evidenceRequiredTypes.has(object.objectType) && !hasEvidence) {
      contextGaps.push({
        id: `${object.id}:missing-evidence`,
        objectId: object.id,
        kind: "missing_evidence",
        severity: object.status === "approved" ? "high" : "medium",
        title: `Missing evidence: ${object.title}`,
        detail: `${object.objectType} is visible in the process path but has no attached evidence ref in the selected context.`,
      });
    }
    if (workState === "blocked" && !hasBlocker) {
      contextGaps.push({
        id: `${object.id}:missing-blocker-link`,
        objectId: object.id,
        kind: "missing_blocker_link",
        severity: "high",
        title: `Blocked without blocker link: ${object.title}`,
        detail: "The work state is blocked, but no blocks relationship explains what is blocking it.",
      });
    }
    if (object.status === "proposed" || object.status === "draft") {
      contextGaps.push({
        id: `${object.id}:needs-review`,
        objectId: object.id,
        kind: "needs_review",
        severity: object.objectType === "Risk" ? "high" : "medium",
        title: `Needs review: ${object.title}`,
        detail: `${object.objectType} is not approved graph truth yet and should be reviewed before agents act on it as fact.`,
      });
    }
  }

  const likelyNextActions: Array<{ id: string; title: string; reason: string }> = [];
  for (const relationship of rankedRelationships.filter((item) => item.relationshipType === "blocks").slice(0, 2)) {
    const sourceObject = objectsById.get(relationship.sourceObjectId);
    const targetObject = objectsById.get(relationship.targetObjectId);
    if (sourceObject && targetObject) {
      likelyNextActions.push({
        id: `${relationship.id}:resolve-blocker`,
        title: `Resolve blocker: ${sourceObject.title}`,
        reason: `${sourceObject.title} blocks ${targetObject.title}.`,
      });
    }
  }
  for (const gap of contextGaps.filter((item) => item.kind === "missing_owner" || item.kind === "missing_evidence").slice(0, 3)) {
    likelyNextActions.push({
      id: `${gap.id}:action`,
      title: gap.kind === "missing_owner" ? gap.title.replace("Missing owner", "Assign owner") : gap.title.replace("Missing evidence", "Attach evidence"),
      reason: gap.detail,
    });
  }
  for (const object of rankedObjects.filter((item) => item.objectType === "Task" && (item.status === "draft" || item.status === "proposed")).slice(0, 2)) {
    likelyNextActions.push({
      id: `${object.id}:review-task`,
      title: `Review task: ${object.title}`,
      reason: "Task is still draft/proposed and needs human approval before it becomes company truth.",
    });
  }

  const dedupedNextActions = [...new Map(likelyNextActions.map((action) => [action.title, action])).values()].slice(0, 5);
  const rankedFacts = [
    ...rankedObjects.map((object) => ({
      kind: "object" as const,
      id: object.id,
      title: object.title,
      type: object.objectType,
      status: object.status,
      distance: objectDistanceById.get(object.id) ?? null,
      score: objectScore(object),
      evidenceCount: objectEvidenceCountById.get(object.id) ?? 0,
    })),
    ...rankedRelationships.map((relationship) => {
      const sourceObject = objectsById.get(relationship.sourceObjectId);
      const targetObject = objectsById.get(relationship.targetObjectId);
      return {
        kind: "relationship" as const,
        id: relationship.id,
        title: `${sourceObject?.title ?? relationship.sourceObjectId} ${relationship.relationshipType} ${targetObject?.title ?? relationship.targetObjectId}`,
        type: relationship.relationshipType,
        status: relationship.status,
        distance: relationshipDistanceById.get(relationship.id) ?? null,
        score: relationshipScore(relationship),
        evidenceCount: relationshipEvidenceCountById.get(relationship.id) ?? 0,
      };
    }),
  ].sort((left, right) => right.score - left.score || left.title.localeCompare(right.title)).slice(0, 24);

  const lineageInputs: Array<LineageInput & { snapshot?: Record<string, unknown> }> = [
    ...(mapView ? [{ kind: "ContextMapView" as const, id: mapView.id, snapshot: mapView }] : []),
    ...[...objectsById.values()].filter(row => !variantProjection.virtualIds.has(row.id)).map((row) => ({ kind: "ContextGraphObject" as const, id: row.id, snapshot: row })),
    ...[...relationshipsById.values()].filter(row => !variantProjection.virtualIds.has(row.id)).map((row) => ({ kind: "ContextGraphRelationship" as const, id: row.id, snapshot: row })),
    ...evidenceRefs.filter(row => !variantProjection.virtualIds.has(row.id)).map((row) => ({ kind: "ContextGraphEvidenceRef" as const, id: row.id, snapshot: row })),
  ];
  const consumedIds = new Set([...objectsById.keys(), ...relationshipsById.keys(), ...evidenceRefs.map(row => row.id)]);
  const consumedBundles = [...variantProjection.bundles].filter(([, bundle]) => [...bundle.childIds].some(id => consumedIds.has(id)));
  const usedVariantProjection = { ...variantProjection, variantIds: consumedBundles.map(([id]) => id),
    lineageRoots: consumedBundles.flatMap(([, bundle]) => bundle.roots) };
  const lineageRoots = [...(lineageInputs.length ? await captureArtifactInputProof(actor, params.workspaceId, lineageInputs) : []), ...usedVariantProjection.lineageRoots];
  await assertEffectiveGraphVariantProjection(actor, params.workspaceId, usedVariantProjection);
  invariant(await isArtifactInputProofReadable(actor, params.workspaceId, lineageRoots), 409, "SOURCE_CHANGED", "Graph context changed before release.");
  return {
    lineageInputs, lineageRoots,
    selectedObjectIds: selectedIds,
    mapViewId: params.mapViewId ?? null,
    temporalScope: { asOf: asOf?.toISOString() ?? "now", includeStale: Boolean(params.includeStale) },
    objects: rankedObjects,
    relationships: rankedRelationships,
    rankedFacts,
    directNeighbors,
    evidenceRefs,
    evidenceSnippets: evidenceRefs
      .filter((evidenceRef) => evidenceRef.quote)
      .sort((left, right) => (right.relevanceScore ?? 0) - (left.relevanceScore ?? 0))
      .slice(0, 10),
    sourceRecords,
    knowledgeChunks,
    staleOrDisputed,
    contextGaps: contextGaps.slice(0, 12),
    likelyNextActions: dedupedNextActions,
    openQuestions: rankedObjects.filter((object) => object.objectType === "Question" && object.status !== "archived"),
    permissions: {
      actorKind: actor.kind,
      canRead: true,
      canPropose: actor.kind === "user" || Boolean(actor.scopes?.includes("context-graph:propose")),
      canApprove: actor.kind === "user"
        ? membership?.role === "ADMIN" || membership?.role === "FACILITATOR"
        : Boolean(actor.scopes?.includes("context-graph:approve")),
      maxSensitivity,
    },
  };
}

function selectedRegionSourceId(mapViewId: string | null | undefined, selectedObjectIds: string[]) {
  return `${mapViewId ?? "context-map"}:${[...selectedObjectIds].sort().join(",")}`;
}

const WORK_STATE_ALIASES: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /\b(stalled|blocked|stuck|stop|stopped)\b/i, value: "stalled" },
  { pattern: /\b(moving|in progress|progressing|active)\b/i, value: "moving" },
  { pattern: /\b(pending decision|decision pending|needs decision)\b/i, value: "pending_decision" },
];

function cleanInstructionFragment(value: string) {
  return value
    .replace(/^["'\s:,-]+|["'\s.,;]+$/g, "")
    .trim()
    .slice(0, 180);
}

const AMBIGUOUS_SINGLE_TOKEN_TITLES = new Set([
  "agent",
  "archive",
  "change",
  "connect",
  "decision",
  "edit",
  "metric",
  "process",
  "question",
  "remove",
  "risk",
  "status",
  "step",
  "task",
  "team",
  "update",
]);

function normalizedInstructionText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function instructionMentionsObjectTitle(instruction: string, title: string) {
  const normalizedTitle = normalizedInstructionText(title);
  if (!normalizedTitle) return false;
  const titleTokens = normalizedTitle.split(" ");
  if (titleTokens.length === 1 && (titleTokens[0].length < 6 || AMBIGUOUS_SINGLE_TOKEN_TITLES.has(titleTokens[0]))) {
    return false;
  }
  return ` ${normalizedInstructionText(instruction)} `.includes(` ${normalizedTitle} `);
}

function extractInstructionValue(instruction: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = instruction.match(pattern);
    const value = match?.[1] ? cleanInstructionFragment(match[1]) : null;
    if (value) return value;
  }
  return null;
}

function workStateFromInstruction(instruction: string) {
  return WORK_STATE_ALIASES.find((alias) => alias.pattern.test(instruction))?.value ?? null;
}

function mapChangeReason(targetTitles: string[], instruction: string) {
  return `Map change request${targetTitles.length ? ` for ${targetTitles.slice(0, 3).join(", ")}` : ""}: ${instruction.slice(0, 180)}`;
}

export async function createContextMapChangeProposal(actor: AppActor, params: {
  workspaceId: string;
  mapViewId: string;
  selectedObjectIds?: string[];
  instruction: string;
}): Promise<ContextMapChangeProposalResult> {
  await requireGraphPropose(actor, params.workspaceId);
  const instruction = params.instruction.trim();
  invariant(instruction.length > 0, 400, "INVALID_INPUT", "Change instruction is required.");

  const userId = actorUserId(actor);
  const mapView = await prisma.contextMapView.findFirst({
    where: { id: params.mapViewId, ...visibleMapViewWhere(params.workspaceId, userId) },
  });
  invariant(mapView, 404, "NOT_FOUND", "Context map not found.");

  invariant((await readableMapViews(actor, params.workspaceId, [mapView])).length, 404, "NOT_FOUND", "Context map not found.");
  const mapRoots = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "ContextMapView", id: mapView.id, snapshot: mapView }]);
  const readGraph = graphReadWithRebuild(actor, params.workspaceId, mapView);
  const selectedIds = [...new Set(params.selectedObjectIds ?? [])];
  const mapObjectWhere = objectWhereForMapView(params.workspaceId, mapView, false);
  const [candidateMapObjects, candidateSelectedObjects] = await Promise.all([
    prisma.contextGraphObject.findMany({
      where: mapObjectWhere,
    }),
    selectedIds.length
      ? prisma.contextGraphObject.findMany({
        where: { AND: [mapObjectWhere, { id: { in: selectedIds } }] },
      })
      : Promise.resolve([]),
  ]);
  const projection = await effectiveGraphVariantProjection(actor, params.workspaceId, mapView);
  const mapObjects = [...await readGraph("ContextGraphObject", candidateMapObjects), ...projection.objects];
  const explicitSelectedObjects = await readGraph("ContextGraphObject", candidateSelectedObjects);
  const objectById = new Map([...mapObjects, ...explicitSelectedObjects].map((object) => [object.id, object]));
  const scopedObjects = [...objectById.values()];
  const selectableObjects = scopedObjects.filter((object) => ["Process", "ProcessStep", "Team"].includes(object.objectType));
  const selectedObjectById = new Map(scopedObjects.map((object) => [object.id, object]));
  const selectedObjects = selectedIds.length
    ? selectedIds.map((id) => selectedObjectById.get(id)).filter((object): object is (typeof scopedObjects)[number] => Boolean(object))
    : [];
  let targets = selectedObjects;

  if (targets.length === 0) {
    targets = selectableObjects.filter((object) => instructionMentionsObjectTitle(instruction, object.title));
  }

  if (targets.length === 0) {
    return {
      mode: "needs_clarification",
      message: "Select a process or step, or name exactly one visible process/step in the request.",
    };
  }
  if (targets.length > 1 && !/\b(connect|depends on|block|blocks|archive|remove|delete)\b/i.test(instruction)) {
    return {
      mode: "needs_clarification",
      message: "This matches more than one map item. Select the exact item before asking for the change.",
    };
  }

  await assertEffectiveGraphVariantProjection(actor, params.workspaceId, projection);
  invariant(!targets.some(target => projection.virtualIds.has(target.id)), 409, "GRAPH_VARIANT_REVIEW_REQUIRED",
    "A fresh graph bundle needs a separate review before native edits can be proposed.");
  const titleUpdate = extractInstructionValue(instruction, [
    /\brename(?: it)? to\s+(.+)$/i,
    /\btitle(?: should be| to| is)\s+(.+)$/i,
  ]);
  const nextAction = extractInstructionValue(instruction, [
    /\bnext action(?: should be| to| is)\s+(.+)$/i,
    /\bwhat(?:'s| is) needed(?: to proceed)?(?: should be| to| is)\s+(.+)$/i,
    /\bneeded to proceed(?: should be| to| is)\s+(.+)$/i,
  ]);
  const summaryUpdate = extractInstructionValue(instruction, [
    /\bsummary(?: should be| to| is)\s+(.+)$/i,
  ]);
  const workState = workStateFromInstruction(instruction);
  const addStepTitle = extractInstructionValue(instruction, [
    /\badd(?: a)?(?: process)? step(?: called| named)?\s+(.+?)\s+(?:under|inside|within)\s+.+$/i,
    /\badd(?: a)?(?: process)? step(?: called| named)?\s+(.+)$/i,
  ]);
  const shouldArchive = /\b(archive|remove|delete)\b/i.test(instruction);
  const wantsConnect = /\b(connect|depends on|block|blocks)\b/i.test(instruction);
  if (wantsConnect && targets.length !== 2) {
    return {
      mode: "needs_clarification",
      message: "Select exactly two process items before asking to connect them.",
    };
  }
  if (targets.length > 1 && shouldArchive && selectedObjects.length !== targets.length) {
    return {
      mode: "needs_clarification",
      message: "This matches more than one map item. Select the exact items before asking to archive them.",
    };
  }
  const shouldConnect = wantsConnect;

  const diff: ContextGraphDiffInput = {};
  const evidence: JsonRecord = {
    kind: "context-map-change-request",
    mapViewId: params.mapViewId,
    selectedObjectIds: selectedIds,
    instruction,
  };

  if (addStepTitle) {
    const parent = targets.find((object) => ["Process", "Team"].includes(object.objectType)) ?? targets[0];
    invariant(parent, 400, "INVALID_INPUT", "A parent process or stream is required.");
    const ref = "requested-step";
    diff.objects = [{
      ref,
      objectType: "ProcessStep",
      title: addStepTitle,
      status: "proposed",
      sourceEntityType: "ContextMapView",
      sourceEntityId: params.mapViewId,
      properties: {
        requestedBy: "context_map_changes",
        nextAction: "Review and fill in the working details for this step.",
      },
    }];
    diff.relationships = [{
      sourceRef: ref,
      targetObjectId: parent.id,
      relationshipType: "part_of",
      status: "proposed",
      sourceEntityType: "ContextMapView",
      sourceEntityId: params.mapViewId,
    }];
  } else if (shouldConnect) {
    const relationshipType = /\bblock|blocks\b/i.test(instruction) ? "blocks" : "depends_on";
    diff.relationships = [{
      sourceObjectId: targets[0].id,
      targetObjectId: targets[1].id,
      relationshipType,
      status: "proposed",
      sourceEntityType: "ContextMapView",
      sourceEntityId: params.mapViewId,
    }];
  } else {
    const objectUpdates: ContextGraphObjectUpdateInput[] = [];
    const hasObjectChange = Boolean(titleUpdate || summaryUpdate || nextAction || workState || shouldArchive);
    if (!hasObjectChange) {
      return {
        mode: "needs_clarification",
        message: "Say whether to rename, change status, set next action, add a step, connect two selected items, or archive the selected item.",
      };
    }
    for (const target of shouldArchive ? targets : targets.slice(0, 1)) {
      const currentProperties = jsonValueRecord(target.properties);
      const properties = {
        ...currentProperties,
        ...(nextAction ? { nextAction } : {}),
        ...(workState ? { workState } : {}),
      };
      const update: ContextGraphObjectUpdateInput = {
        id: target.id,
        ...(titleUpdate ? { title: titleUpdate } : {}),
        ...(summaryUpdate ? { summary: summaryUpdate } : {}),
        ...(nextAction || workState ? { properties } : {}),
        ...(shouldArchive ? { status: "archived" } : {}),
      };
      objectUpdates.push(update);
    }
    if (objectUpdates.length) diff.objectUpdates = objectUpdates;
  }

  if (
    (diff.objects?.length ?? 0) === 0
    && (diff.objectUpdates?.length ?? 0) === 0
    && (diff.relationships?.length ?? 0) === 0
    && (diff.relationshipUpdates?.length ?? 0) === 0
  ) {
    return {
      mode: "needs_clarification",
      message: "Say whether to rename, change status, set next action, add a step, connect two selected items, or archive the selected item.",
    };
  }

  const proposedDiff = await createContextGraphProposedDiff(actor, {
    workspaceId: params.workspaceId,
    lineageInputs: scopedObjects.filter(object => !projection.virtualIds.has(object.id)).map((object) => ({ kind: "ContextGraphObject" as const, id: object.id })),
    lineageRoots: [...mapRoots, ...projection.lineageRoots, ...scopedObjects.filter(object => !projection.virtualIds.has(object.id)).map((object) => ({ kind: "ContextGraphObject" as const, id: object.id,
      fingerprint: lineageContentFingerprint("ContextGraphObject", object) }))],
    reason: mapChangeReason(targets.map((target) => target.title), instruction),
    evidence,
    diff,
  });

  return {
    mode: "proposed",
    proposedDiffId: proposedDiff.id,
    reason: proposedDiff.reason,
    status: proposedDiff.status,
    createdAt: proposedDiff.createdAt,
    diffJson: proposedDiff.diffJson,
  };
}

function requireManualRelationIntent(value: string | null | undefined): ContextMapManualRelationIntent {
  const intent = value?.trim();
  invariant(
    intent === "enables" || intent === "blocks" || intent === "supports" || intent === "needs_approval_from",
    400,
    "INVALID_INPUT",
    "Choose a supported connection type.",
  );
  return intent;
}

function manualRelationshipInputForVisual(
  intent: ContextMapManualRelationIntent,
  visualSource: { objectId?: string; ref?: string },
  visualTarget: { objectId?: string; ref?: string },
): ContextGraphRelationshipInput {
  const base = {
    status: "proposed",
    sourceEntityType: "ContextMapView",
    properties: {
      manualMapEdit: true,
      relationIntent: intent,
    },
  } satisfies Partial<ContextGraphRelationshipInput>;

  if (intent === "enables") {
    return {
      ...base,
      relationshipType: "depends_on",
      sourceObjectId: visualTarget.objectId,
      sourceRef: visualTarget.ref,
      targetObjectId: visualSource.objectId,
      targetRef: visualSource.ref,
    };
  }

  return {
    ...base,
    relationshipType: intent,
    sourceObjectId: visualSource.objectId,
    sourceRef: visualSource.ref,
    targetObjectId: visualTarget.objectId,
    targetRef: visualTarget.ref,
  };
}

function manualRelationshipUpdateForVisual(
  id: string,
  intent: ContextMapManualRelationIntent,
  visualSourceObjectId: string,
  visualTargetObjectId: string,
  existingProperties?: Prisma.JsonValue | null,
): ContextGraphRelationshipUpdateInput {
  const properties = {
    ...jsonValueRecord(existingProperties),
    manualMapEdit: true,
    relationIntent: intent,
  };

  if (intent === "enables") {
    return {
      id,
      relationshipType: "depends_on",
      sourceObjectId: visualTargetObjectId,
      targetObjectId: visualSourceObjectId,
      properties,
    };
  }

  return {
    id,
    relationshipType: intent,
    sourceObjectId: visualSourceObjectId,
    targetObjectId: visualTargetObjectId,
    properties,
  };
}

async function requireVisibleMapObject(actor: AppActor, workspaceId: string, mapView: { id: string; query: Prisma.JsonValue; createdByUserId?: string | null }, objectId: string, includeStale = false, roots?: NonNullable<GraphLineageCapture["lineageRoots"]>, readGraph = graphReadWithRebuild(actor, workspaceId, mapView)) {
  const normalizedObjectId = requireStringField(objectId, "Context map object id is required.").trim();
  invariant(normalizedObjectId.length > 0, 400, "INVALID_INPUT", "Context map object id is required.");
  const object = await prisma.contextGraphObject.findFirst({
    where: { AND: [objectWhereForMapView(workspaceId, mapView, includeStale), { id: normalizedObjectId }] },
  });
  invariant(object && (await readGraph("ContextGraphObject", [object])).length,
    404, "NOT_FOUND", "Context graph object not found on this map.");
  if (roots) roots.push(...await captureArtifactInputProof(actor, workspaceId, [{ kind: "ContextGraphObject", id: object.id, snapshot: object }]));
  return object;
}

function manualEditReason(edit: ContextMapManualEditInput, title?: string | null) {
  if (edit.action === "add-card") {
    return `Manual map edit: add ${edit.cardKind === "alert" ? "alert card" : "standard card"}${title ? ` "${title}"` : ""}.`;
  }
  if (edit.action === "add-connection") {
    return `Manual map edit: add ${edit.relationIntent.replace(/_/g, " ")} connection.`;
  }
  if (edit.action === "archive-card") return "Manual map edit: archive card.";
  if (edit.archive) return "Manual map edit: archive connection.";
  return `Manual map edit: change connection to ${edit.relationIntent?.replace(/_/g, " ") ?? "selected type"}.`;
}

export async function createContextMapManualEditProposal(actor: AppActor, params: {
  workspaceId: string;
  mapViewId: string;
  includeStale?: boolean;
  edit: ContextMapManualEditInput;
}): Promise<Extract<ContextMapChangeProposalResult, { mode: "proposed" }>> {
  await requireGraphPropose(actor, params.workspaceId);
  const userId = actorUserId(actor);
  const mapView = await prisma.contextMapView.findFirst({
    where: { id: params.mapViewId, ...visibleMapViewWhere(params.workspaceId, userId) },
  });
  invariant(mapView, 404, "NOT_FOUND", "Context map not found.");

  invariant((await readableMapViews(actor, params.workspaceId, [mapView])).length, 404, "NOT_FOUND", "Context map not found.");
  const lineageRoots = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "ContextMapView", id: mapView.id, snapshot: mapView }]);
  const readGraph = graphReadWithRebuild(actor, params.workspaceId, mapView);
  const variantProjection = await effectiveGraphVariantProjection(actor, params.workspaceId, mapView);
  const requestedIds = Object.entries(params.edit).filter(([key]) => ["objectId", "sourceObjectId", "targetObjectId", "relationshipId"].includes(key))
    .map(([, value]) => value).filter((value): value is string => typeof value === "string");
  await assertEffectiveGraphVariantProjection(actor, params.workspaceId, variantProjection);
  invariant(!requestedIds.some(id => variantProjection.virtualIds.has(id)), 409, "GRAPH_VARIANT_REVIEW_REQUIRED",
    "A fresh graph bundle needs a separate review before native edits can be proposed.");
  const edit = params.edit;
  const diff: ContextGraphDiffInput = {};
  const evidence: JsonRecord = {
    kind: "context-map-manual-edit",
    mapViewId: params.mapViewId,
    action: edit.action,
  };
  let titleForReason: string | null = null;

  if (edit.action === "add-card") {
    const title = requireStringField(edit.title, "Card title is required.").trim();
    invariant(title.length > 0, 400, "INVALID_INPUT", "Card title is required.");
    invariant(Number.isFinite(edit.position.x) && Number.isFinite(edit.position.y), 400, "INVALID_INPUT", "Card position must be finite.");
    titleForReason = title.slice(0, 120);
    const ref = "manual-card";
    const objectType: ContextGraphObjectType = edit.cardKind === "alert" ? "Risk" : "ProcessStep";
    diff.objects = [{
      ref,
      objectType,
      title: title.slice(0, 180),
      summary: edit.cardKind === "alert"
        ? "Manual alert card proposed from the context map."
        : "Manual standard card proposed from the context map.",
      status: "proposed",
      properties: {
        manualMapEdit: true,
        cardKind: edit.cardKind,
        contextMapDisplay: "canvas",
        sourceMapViewId: params.mapViewId,
        pathStage: edit.cardKind === "alert" ? "Alert" : "Manual",
        workState: "needs_review",
      },
    }];
    if (mapView.createdByUserId === null) {
      diff.mapLayoutUpdates = [{
        mapViewId: params.mapViewId,
        items: [{
          objectRef: ref,
          x: edit.position.x,
          y: edit.position.y,
          width: 250,
          height: 128,
          visualState: {
            manualMapEdit: true,
            cardKind: edit.cardKind,
          },
        }],
      }];
    }

    if (edit.sourceObjectId) {
      await requireVisibleMapObject(actor, params.workspaceId, mapView, edit.sourceObjectId, params.includeStale, lineageRoots, readGraph);
      const intent = requireManualRelationIntent(edit.relationIntent ?? (edit.cardKind === "alert" ? "blocks" : "enables"));
      diff.relationships = [intent === "blocks"
        ? {
          relationshipType: "blocks",
          sourceRef: ref,
          targetObjectId: edit.sourceObjectId,
          status: "proposed",
          sourceEntityType: "ContextMapView",
          sourceEntityId: params.mapViewId,
          properties: { manualMapEdit: true, relationIntent: intent },
        }
        : {
          ...manualRelationshipInputForVisual(intent, { objectId: edit.sourceObjectId }, { ref }),
          sourceEntityId: params.mapViewId,
        }];
    }
  } else if (edit.action === "add-connection") {
    invariant(edit.sourceObjectId !== edit.targetObjectId, 400, "INVALID_INPUT", "Choose two different map cards to connect.");
    await requireVisibleMapObject(actor, params.workspaceId, mapView, edit.sourceObjectId, params.includeStale, lineageRoots, readGraph);
    await requireVisibleMapObject(actor, params.workspaceId, mapView, edit.targetObjectId, params.includeStale, lineageRoots, readGraph);
    const intent = requireManualRelationIntent(edit.relationIntent);
    diff.relationships = [{
      ...manualRelationshipInputForVisual(intent, { objectId: edit.sourceObjectId }, { objectId: edit.targetObjectId }),
      sourceEntityId: params.mapViewId,
    }];
  } else if (edit.action === "archive-card") {
    const object = await requireVisibleMapObject(actor, params.workspaceId, mapView, edit.objectId, params.includeStale, lineageRoots, readGraph);
    titleForReason = object.title;
    diff.objectUpdates = [{ id: object.id, status: "archived" }];
  } else {
    const relationshipId = requireStringField(edit.relationshipId, "Connection id is required.").trim();
    invariant(relationshipId.length > 0, 400, "INVALID_INPUT", "Connection id is required.");
    const relationship = await prisma.contextGraphRelationship.findFirst({
      where: { id: relationshipId, workspaceId: params.workspaceId },
    });
    invariant(relationship && (await readGraph("ContextGraphRelationship", [relationship])).length,
      404, "NOT_FOUND", "Context graph relationship not found.");
    lineageRoots.push(...await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "ContextGraphRelationship", id: relationship.id, snapshot: relationship }]));
    await requireVisibleMapObject(actor, params.workspaceId, mapView, relationship.sourceObjectId, params.includeStale, lineageRoots, readGraph);
    await requireVisibleMapObject(actor, params.workspaceId, mapView, relationship.targetObjectId, params.includeStale, lineageRoots, readGraph);

    if (edit.archive) {
      diff.relationshipUpdates = [{ id: relationship.id, status: "archived" }];
    } else {
      const intent = requireManualRelationIntent(edit.relationIntent);
      const visualSourceObjectId = relationship.relationshipType === "depends_on" ? relationship.targetObjectId : relationship.sourceObjectId;
      const visualTargetObjectId = relationship.relationshipType === "depends_on" ? relationship.sourceObjectId : relationship.targetObjectId;
      diff.relationshipUpdates = [manualRelationshipUpdateForVisual(
        relationship.id,
        intent,
        visualSourceObjectId,
        visualTargetObjectId,
        relationship.properties,
      )];
    }
  }

  const proposedDiff = await createContextGraphProposedDiff(actor, {
    workspaceId: params.workspaceId,
    lineageInputs: [], lineageRoots,
    humanOriginal: actor.kind === "user",
    reason: manualEditReason(edit, titleForReason),
    evidence,
    diff,
  });

  return {
    mode: "proposed",
    proposedDiffId: proposedDiff.id,
    reason: proposedDiff.reason,
    status: proposedDiff.status,
    createdAt: proposedDiff.createdAt,
    diffJson: proposedDiff.diffJson,
  };
}

export async function createMissingRegionFactsProposal(actor: AppActor, params: {
  workspaceId: string;
  mapViewId: string;
  objectIds: string[];
}) {
  const context = await buildSelectedRegionContext(actor, {
    workspaceId: params.workspaceId,
    mapViewId: params.mapViewId,
    objectIds: params.objectIds,
    depth: 2,
  });

  invariant(!context.lineageRoots.some(root => root.kind === "GenericDerivedArtifactVariant"),
    409, "GRAPH_VARIANT_REVIEW_REQUIRED", "A fresh graph bundle needs a separate review before native edits can be proposed.");
  const sourceId = selectedRegionSourceId(params.mapViewId, context.selectedObjectIds);
  const selectedObjectIds = [...context.selectedObjectIds].sort();
  const selectedObjectSegment = shortHash(selectedObjectIds.join(","));
  const objects: ContextGraphObjectInput[] = [];
  const relationships: ContextGraphRelationshipInput[] = [];
  const evidenceRefs: ContextGraphEvidenceInput[] = [];
  const addedProposalKeys = new Set<string>();

  function addProposal(input: {
    kind: "task" | "risk" | "owner" | "question";
    objectType: "Task" | "Risk" | "Question";
    title: string;
    summary: string;
    targetObjectId?: string;
    relationshipType?: ContextGraphRelationshipType;
    confidence?: number;
  }) {
    const title = input.title.trim().slice(0, 180);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72);
    const proposalKey = [input.kind, input.targetObjectId ?? "region", slug].join(":");
    if (!title || addedProposalKeys.has(proposalKey)) return;
    addedProposalKeys.add(proposalKey);
    const ref = `missing-region-fact-${objects.length + 1}`;
    const dedupeKey = [
      params.workspaceId,
      "missing-region-fact",
      params.mapViewId,
      selectedObjectSegment,
      input.kind,
      input.targetObjectId ?? "region",
      slug,
    ].join(":");

    objects.push({
      ref,
      objectType: input.objectType,
      title,
      summary: input.summary,
      status: "proposed",
      confidence: input.confidence ?? 0.72,
      sourceEntityType: "ContextMapView",
      sourceEntityId: params.mapViewId,
      dedupeKey,
      properties: {
        proposalKind: "missing_region_fact",
        missingFactKind: input.kind,
        regionContextId: sourceId,
        selectedObjectIds,
        nextAction: input.summary,
      },
    });

    if (input.targetObjectId && input.relationshipType) {
      relationships.push({
        sourceRef: ref,
        targetObjectId: input.targetObjectId,
        relationshipType: input.relationshipType,
        status: "proposed",
        confidence: input.confidence ?? 0.72,
        sourceEntityType: "ContextMapView",
        sourceEntityId: params.mapViewId,
        properties: {
          proposalKind: "missing_region_fact",
          selectedObjectIds,
        },
      });
    }

    evidenceRefs.push({
      objectRef: ref,
      sourceType: "ContextGraphObject",
      sourceId: input.targetObjectId ?? selectedObjectIds[0],
      quote: input.summary.slice(0, 600),
      relevanceScore: input.confidence ?? 0.72,
      metadata: {
        mapViewId: params.mapViewId,
        selectedObjectIds,
        missingFactKind: input.kind,
        regionContextId: sourceId,
      },
    });
  }

  const actionableGaps = context.contextGaps
    .filter((gap) => ["missing_owner", "missing_blocker_link", "missing_evidence", "needs_review"].includes(gap.kind))
    .slice(0, 5);
  for (const gap of actionableGaps) {
    if (gap.kind === "missing_blocker_link") {
      addProposal({
        kind: "risk",
        objectType: "Risk",
        title: gap.title.replace("Blocked without blocker link", "Clarify blocker"),
        summary: gap.detail,
        targetObjectId: gap.objectId,
        relationshipType: "blocks",
        confidence: gap.severity === "high" ? 0.82 : 0.68,
      });
      continue;
    }
    addProposal({
      kind: gap.kind === "missing_owner" ? "owner" : "task",
      objectType: "Task",
      title: gap.kind === "missing_owner"
        ? gap.title.replace("Missing owner", "Assign owner")
        : gap.title.replace("Missing evidence", "Attach evidence").replace("Needs review", "Review fact"),
      summary: gap.detail,
      targetObjectId: gap.objectId,
      relationshipType: "supports",
      confidence: gap.severity === "high" ? 0.8 : 0.66,
    });
  }

  for (const action of context.likelyNextActions.slice(0, 4)) {
    if (objects.length >= 6) break;
    addProposal({
      kind: "task",
      objectType: "Task",
      title: action.title,
      summary: action.reason,
      targetObjectId: selectedObjectIds[0],
      relationshipType: "supports",
      confidence: 0.7,
    });
  }

  if (objects.length === 0) {
    addProposal({
      kind: "question",
      objectType: "Question",
      title: `Review selected region for missing tasks, risks, or owners`,
      summary: "No explicit gaps were detected automatically. Ask a human or agent to verify whether the selected region needs missing task, risk, or ownership facts before changing graph truth.",
      targetObjectId: selectedObjectIds[0],
      relationshipType: "supports",
      confidence: 0.52,
    });
  }

  return createContextGraphProposedDiff(actor, {
    workspaceId: params.workspaceId,
    lineageInputs: context.lineageInputs,
    lineageRoots: context.lineageRoots,
    reason: "Propose missing tasks, risks, or owners from the selected map region.",
    evidence: {
      kind: "selected-region-missing-facts",
      mapViewId: params.mapViewId,
      selectedObjectIds,
      contextObjectCount: context.objects.length,
      contextRelationshipCount: context.relationships.length,
      contextGapCount: context.contextGaps.length,
      likelyNextActionCount: context.likelyNextActions.length,
    },
    diff: {
      objects,
      relationships,
      evidenceRefs,
    },
  });
}

export function contextGraphSystemActor(workspaceId: string, label = "context-graph-sync"): AppActor {
  return {
    kind: "agent",
    authProvider: "control-plane",
    label,
    workspaceIds: [workspaceId],
  };
}

export async function syncContextGraphForMeeting(actor: AppActor, params: { workspaceId: string; meetingId: string }) {
  await requireGraphPropose(actor, params.workspaceId);
  return prisma.$transaction(async (tx) => {
    const meeting = await tx.meeting.findFirst({ where: { id: params.meetingId, workspaceId: params.workspaceId }, include: { insights: true } });
    if (!meeting || !(await readableGraphRecords(actor, params.workspaceId, "Meeting", [meeting], tx)).length) return null;
    const meetingRoots = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "Meeting", id: meeting.id, snapshot: meeting }], tx);
    const insights = await readableGraphRecords(actor, params.workspaceId, "MeetingInsight", meeting.insights, tx);
    const meetingObject = await upsertObjectWithTx(tx, actor, params.workspaceId, {
      lineageInputs: [], lineageRoots: meetingRoots,
      objectType: "Meeting",
      title: meeting.title ?? "Untitled meeting",
      summary: meeting.summaryMd,
      status: "approved",
      sourceEntityType: "Meeting",
      sourceEntityId: meeting.id,
      validFrom: meeting.recordedAt,
      lastVerifiedAt: new Date(),
      properties: {
        source: meeting.source,
        recordedAt: meeting.recordedAt.toISOString(),
      },
    });

    for (const insight of insights) {
      if (insight.status === "DISMISSED") continue;
      const insightRoots = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "MeetingInsight", id: insight.id, snapshot: insight }], tx);
      const lineageRoots = [...meetingRoots, ...insightRoots];
      const objectType: ContextGraphObjectType = insight.type === "ACTION_ITEM"
        ? "Task"
        : insight.type === "FOLLOW_UP"
          ? "Task"
          : insight.type === "PROPOSAL"
            ? "Hypothesis"
            : insight.type === "TENSION"
              ? "Risk"
              : insight.type === "DELIBERATION_ENTRY"
                ? "Evidence"
                : "Decision";
      const status: ContextGraphStatus = insight.status === "SUGGESTED" ? "proposed" : "approved";
      const object = await upsertObjectWithTx(tx, actor, params.workspaceId, {
        lineageInputs: [], lineageRoots,
        objectType,
        title: insight.title,
        summary: insight.bodyMd,
        confidence: insight.confidence,
        status,
        sourceEntityType: "MeetingInsight",
        sourceEntityId: insight.id,
        validFrom: meeting.recordedAt,
        lastVerifiedAt: insight.status === "SUGGESTED" ? null : new Date(),
        properties: {
          meetingId: meeting.id,
          insightType: insight.type,
          operation: insight.operation,
          assigneeHint: insight.assigneeHint,
          appliedEntityType: insight.appliedEntityType,
          appliedEntityId: insight.appliedEntityId,
          targetEntityType: insight.targetEntityType,
          targetEntityId: insight.targetEntityId,
        },
      });
      const relationship = await upsertRelationshipWithTx(tx, actor, params.workspaceId, {
        lineageInputs: [], lineageRoots,
        sourceObjectId: object.id,
        targetObjectId: meetingObject.id,
        relationshipType: insight.type === "DECISION" ? "decided_in" : "created_in",
        confidence: insight.confidence,
        status,
        sourceEntityType: "MeetingInsight",
        sourceEntityId: insight.id,
      }, new Map());
      await attachEvidenceWithTx(tx, actor, params.workspaceId, {
        lineageInputs: [], lineageRoots,
        objectId: object.id,
        sourceType: "MEETING",
        sourceId: meeting.id,
        quote: insight.sourceQuote,
        relevanceScore: insight.confidence,
        metadata: { meetingInsightId: insight.id },
      }, new Map(), new Map());
      await attachEvidenceWithTx(tx, actor, params.workspaceId, {
        lineageInputs: [], lineageRoots,
        relationshipId: relationship.id,
        sourceType: "MEETING",
        sourceId: meeting.id,
        quote: insight.sourceQuote,
        relevanceScore: insight.confidence,
        metadata: { meetingInsightId: insight.id },
      }, new Map(), new Map());
    }
    return meetingObject;
  });
}
