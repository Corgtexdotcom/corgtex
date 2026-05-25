import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireAgentScope } from "./agent-auth";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { AppError, invariant } from "./errors";

export const CONTEXT_GRAPH_OBJECT_TYPES = [
  "Person",
  "Team",
  "Role",
  "Process",
  "ProcessStep",
  "Project",
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

type ContextGraphObjectInput = {
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

type ContextGraphRelationshipInput = {
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

type ContextGraphEvidenceInput = {
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

type ContextMapLayoutUpdateInput = {
  mapViewId: string;
  items: ContextMapLayoutItemInput[];
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
  name: string;
  viewType: ContextMapViewType;
  query: Prisma.InputJsonObject;
}> = [
  {
    name: "Critical path process map",
    viewType: "process",
    query: {
      mode: "criticalPath",
      objectTypes: ["Process", "ProcessStep", "Decision", "Task", "Risk", "Question", "Tool", "Team", "Role", "Meeting"],
      relationshipTypes: ["part_of", "depends_on", "blocks", "owns", "assigned_to", "supports", "uses", "created_in", "decided_in", "needs_approval_from"],
    },
  },
  {
    name: "Organization map",
    viewType: "org",
    query: {
      mode: "organization",
      objectTypes: ["Team", "Role", "Person"],
      relationshipTypes: ["part_of", "member_of", "reports_to", "owns"],
    },
  },
  {
    name: "Agent governance map",
    viewType: "agent",
    query: {
      mode: "agentGovernance",
      objectTypes: ["Agent", "Policy", "Tool", "Meeting", "Document", "Task", "Decision", "Risk", "Evidence"],
      relationshipTypes: ["input_to", "output_of", "uses", "supports", "needs_approval_from", "created_in", "has_evidence", "blocks"],
    },
  },
];

export type ContextGraphDiffInput = {
  objects?: ContextGraphObjectInput[];
  relationships?: ContextGraphRelationshipInput[];
  evidenceRefs?: ContextGraphEvidenceInput[];
  mapLayoutUpdates?: ContextMapLayoutUpdateInput[];
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
  };

  const dedupeKey = data.dedupeKey
    ?? (data.sourceEntityType && data.sourceEntityId ? `${workspaceId}:${data.sourceEntityType}:${data.sourceEntityId}` : null);

  if (dedupeKey) {
    return tx.contextGraphObject.upsert({
      where: { dedupeKey },
      update: { ...writeData, dedupeKey },
      create: {
        workspaceId,
        ...writeData,
        dedupeKey,
      },
    });
  }

  return tx.contextGraphObject.create({
    data: {
      workspaceId,
      ...writeData,
    },
  });
}

async function resolveObjectId(tx: Prisma.TransactionClient, workspaceId: string, objectId: string) {
  const object = await tx.contextGraphObject.findFirst({
    where: { id: objectId, workspaceId },
    select: { id: true },
  });
  invariant(object, 404, "NOT_FOUND", "Context graph object not found.");
  return object.id;
}

async function upsertRelationshipWithTx(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  workspaceId: string,
  input: ContextGraphRelationshipInput,
  refToObjectId: Map<string, string>,
  agentRunId?: string | null,
) {
  const sourceObjectId = input.sourceObjectId ?? (input.sourceRef ? refToObjectId.get(input.sourceRef) : undefined);
  const targetObjectId = input.targetObjectId ?? (input.targetRef ? refToObjectId.get(input.targetRef) : undefined);
  invariant(sourceObjectId, 400, "INVALID_INPUT", "Relationship source object is required.");
  invariant(targetObjectId, 400, "INVALID_INPUT", "Relationship target object is required.");

  await resolveObjectId(tx, workspaceId, sourceObjectId);
  await resolveObjectId(tx, workspaceId, targetObjectId);

  const data = normalizeRelationshipInput(input);
  const dedupeKey = data.dedupeKey ?? `${workspaceId}:${sourceObjectId}:${data.relationshipType}:${targetObjectId}:${data.sourceEntityType ?? "manual"}:${data.sourceEntityId ?? "manual"}`;
  const writeData = {
    ...data,
    dedupeKey,
    sourceObjectId,
    targetObjectId,
    ...creatorData(actor, agentRunId),
  };

  return tx.contextGraphRelationship.upsert({
    where: { dedupeKey },
    update: writeData,
    create: {
      workspaceId,
      ...writeData,
    },
  });
}

async function attachEvidenceWithTx(
  tx: Prisma.TransactionClient,
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
    select: { id: true },
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

  if (existing) {
    return tx.contextGraphEvidenceRef.update({ where: { id: existing.id }, data });
  }
  return tx.contextGraphEvidenceRef.create({ data });
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

async function applyMapLayoutUpdateWithTx(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  update: ContextMapLayoutUpdateInput,
  options?: { actor?: AppActor; requireMasterOrOwner?: boolean },
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
    const item = normalizeLayoutItem(rawItem);
    await resolveObjectId(tx, workspaceId, item.objectId);
    await tx.contextMapLayoutItem.upsert({
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

export async function importContextGraphMap(actor: AppActor, params: ContextGraphMapImportInput & {
  workspaceId: string;
}): Promise<ContextGraphMapImportResult> {
  await requireGraphApprove(actor, params.workspaceId);
  const mapInput = normalizeMapImportInput(params);

  return prisma.$transaction(async (tx) => {
    const existingMapView = await tx.contextMapView.findFirst({
      where: { workspaceId: params.workspaceId, name: mapInput.name, createdByUserId: null },
      orderBy: { createdAt: "asc" },
    });
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

    const refToObjectId = new Map<string, string>();
    const refToRelationshipId = new Map<string, string>();
    const objectIds: string[] = [];
    const relationshipIds: string[] = [];

    for (const objectInput of params.objects) {
      const object = await upsertObjectWithTx(tx, actor, params.workspaceId, {
        ...objectInput,
        status: objectInput.status ?? "approved",
      }, params.agentRunId);
      objectIds.push(object.id);
      if (objectInput.ref) refToObjectId.set(objectInput.ref, object.id);
    }

    for (const relationshipInput of params.relationships ?? []) {
      const relationship = await upsertRelationshipWithTx(tx, actor, params.workspaceId, {
        ...relationshipInput,
        status: relationshipInput.status ?? "approved",
      }, refToObjectId, params.agentRunId);
      relationshipIds.push(relationship.id);
      if (relationshipInput.ref) refToRelationshipId.set(relationshipInput.ref, relationship.id);
    }

    for (const evidenceInput of params.evidenceRefs ?? []) {
      await attachEvidenceWithTx(tx, params.workspaceId, evidenceInput, refToObjectId, refToRelationshipId);
    }

    const layoutItems = (params.layoutItems ?? []).map((item) => layoutItemFromImport(item, refToObjectId));
    if (layoutItems.length) {
      await applyMapLayoutUpdateWithTx(tx, params.workspaceId, {
        mapViewId: mapView.id,
        items: layoutItems,
      }, {
        actor,
        requireMasterOrOwner: true,
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
  return prisma.$transaction(async (tx) => attachEvidenceWithTx(tx, params.workspaceId, params, new Map(), new Map()));
}

async function ensureDefaultContextMapViewsForWorkspace(workspaceId: string) {
  const views = [];
  for (const config of DEFAULT_CONTEXT_MAP_VIEW_CONFIGS) {
    const existing = await prisma.contextMapView.findFirst({
      where: { workspaceId, viewType: config.viewType, createdByUserId: null },
      orderBy: { createdAt: "asc" },
    });
    if (existing) {
      views.push(existing);
      continue;
    }

    views.push(await prisma.contextMapView.create({
      data: {
        workspaceId,
        name: config.name,
        viewType: config.viewType,
        query: config.query,
        createdByUserId: null,
      },
    }));
  }

  return views;
}

export async function ensureDefaultContextMapView(actor: AppActor, workspaceId: string) {
  await requireGraphRead(actor, workspaceId);
  const views = await ensureDefaultContextMapViewsForWorkspace(workspaceId);
  return views.find((view) => view.viewType === "process") ?? views[0];
}

export async function listContextMapViews(actor: AppActor, workspaceId: string) {
  await requireGraphRead(actor, workspaceId);
  const userId = actorUserId(actor);
  await ensureDefaultContextMapViewsForWorkspace(workspaceId);
  return prisma.contextMapView.findMany({
    where: visibleMapViewWhere(workspaceId, userId),
    orderBy: [{ createdByUserId: "asc" }, { viewType: "asc" }, { createdAt: "asc" }],
  });
}

export async function getContextMapData(actor: AppActor, params: {
  workspaceId: string;
  mapViewId?: string | null;
  includeStale?: boolean;
}) {
  const membership = await requireGraphRead(actor, params.workspaceId);
  const userId = actorUserId(actor);
  const defaultViews = await ensureDefaultContextMapViewsForWorkspace(params.workspaceId);
  const mapView = params.mapViewId
    ? await prisma.contextMapView.findFirst({ where: { id: params.mapViewId, ...visibleMapViewWhere(params.workspaceId, userId) } })
    : defaultViews.find((view) => view.viewType === "process") ?? defaultViews[0];
  invariant(mapView, 404, "NOT_FOUND", "Context map not found.");

  const objects = await prisma.contextGraphObject.findMany({
    where: objectWhereForMapView(params.workspaceId, mapView, params.includeStale),
    include: {
      evidenceRefs: {
        orderBy: { createdAt: "desc" },
        take: 5,
      },
    },
    orderBy: [{ objectType: "asc" }, { updatedAt: "desc" }],
    take: 200,
  });
  const objectIds = objects.map((object) => object.id);
  const relationshipTypes = stringArrayFromQuery(mapView.query, "relationshipTypes");
  const [relationships, mapViews, layoutItems, proposedDiffs] = await Promise.all([
    prisma.contextGraphRelationship.findMany({
      where: {
        workspaceId: params.workspaceId,
        status: params.includeStale ? { not: "archived" } : { notIn: ["archived", "stale"] },
        sourceObjectId: { in: objectIds },
        targetObjectId: { in: objectIds },
        ...(relationshipTypes.length ? { relationshipType: { in: relationshipTypes } } : {}),
      },
      include: {
        evidenceRefs: {
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
      take: 300,
    }),
    prisma.contextMapView.findMany({
      where: visibleMapViewWhere(params.workspaceId, userId),
      orderBy: [{ createdByUserId: "asc" }, { viewType: "asc" }, { createdAt: "asc" }],
    }),
    prisma.contextMapLayoutItem.findMany({
      where: { mapViewId: mapView.id },
    }),
    prisma.contextGraphProposedDiff.findMany({
      where: { workspaceId: params.workspaceId, status: { in: ["pending", "approved"] } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  return {
    mapView,
    mapViews,
    objects,
    relationships,
    layoutItems,
    proposedDiffs,
    permissions: {
      canSavePersonalView: actor.kind === "user",
      canUpdateMasterView: canApproveContextGraph(actor, membership),
      canRequestMasterUpdate: actor.kind === "user",
    },
  };
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
    select: { id: true, name: true, createdByUserId: true },
  });
  invariant(mapView, 404, "NOT_FOUND", "Context map not found.");

  const isPersonalOwner = Boolean(userId && mapView.createdByUserId === userId);
  const isMaster = mapView.createdByUserId === null;
  const canUpdateMaster = isMaster && canApproveContextGraph(actor, membership);
  invariant(isPersonalOwner || isMaster, 403, "FORBIDDEN", "You cannot update another user's context map view.");

  if (!isPersonalOwner && !canUpdateMaster) {
    const proposedDiff = await createContextGraphProposedDiff(actor, {
      workspaceId: params.workspaceId,
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
    });
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

  const query = (sourceMapView.query && typeof sourceMapView.query === "object" && !Array.isArray(sourceMapView.query))
    ? { ...(sourceMapView.query as JsonRecord) }
    : {};
  const name = params.name?.trim() || `${sourceMapView.name} - personal`;
  const sourceLayoutItems = params.items?.length
    ? params.items.map(normalizeLayoutItem)
    : await prisma.contextMapLayoutItem.findMany({
      where: { mapViewId: sourceMapView.id },
      select: { objectId: true, x: true, y: true, width: true, height: true, visualState: true },
    }).then((items) => items.map((item) => normalizeLayoutItem({
      objectId: item.objectId,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      visualState: item.visualState && typeof item.visualState === "object" && !Array.isArray(item.visualState)
        ? item.visualState as JsonRecord
        : undefined,
    })));

  return prisma.$transaction(async (tx) => {
    for (const normalized of sourceLayoutItems) {
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

    for (const normalized of sourceLayoutItems) {
      await tx.contextMapLayoutItem.create({
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
  requireOptionalArray(diff.relationships, "Context graph diff relationships must be an array.");
  requireOptionalArray(diff.evidenceRefs, "Context graph diff evidence refs must be an array.");
  requireOptionalArray(diff.mapLayoutUpdates, "Context graph diff map layout updates must be an array.");

  const objects = diff.objects as unknown[] | undefined;
  const relationships = diff.relationships as unknown[] | undefined;
  const evidenceRefs = diff.evidenceRefs as unknown[] | undefined;
  const mapLayoutUpdates = diff.mapLayoutUpdates as unknown[] | undefined;

  for (const object of objects ?? []) {
    invariant(isJsonRecord(object), 400, "INVALID_INPUT", "Context graph diff objects must be objects.");
    normalizeObjectInput(object as ContextGraphObjectInput);
  }
  for (const relationship of relationships ?? []) {
    invariant(isJsonRecord(relationship), 400, "INVALID_INPUT", "Context graph diff relationships must be objects.");
    normalizeRelationshipInput(relationship as ContextGraphRelationshipInput);
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
      normalizeLayoutItem(item as ContextMapLayoutItemInput);
    }
  }
}

export async function createContextGraphProposedDiff(actor: AppActor, params: {
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
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "context-graph.diff.proposed",
      entityType: "ContextGraphProposedDiff",
      entityId: proposedDiff.id,
      meta: {
        reason: proposedDiff.reason,
        objectCount: params.diff.objects?.length ?? 0,
        relationshipCount: params.diff.relationships?.length ?? 0,
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
  return prisma.contextGraphProposedDiff.findMany({
    where: {
      workspaceId: params.workspaceId,
      ...(params.status?.length ? { status: { in: params.status } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: params.take ?? 50,
  });
}

export async function updateContextGraphProposedDiff(actor: AppActor, params: {
  workspaceId: string;
  proposedDiffId: string;
  reason?: string | null;
  diff: ContextGraphDiffInput;
  evidence?: JsonRecord | null;
}) {
  await requireGraphApprove(actor, params.workspaceId);
  validateDiff(params.diff);

  return prisma.$transaction(async (tx) => {
    const proposedDiff = await tx.contextGraphProposedDiff.findFirst({
      where: { id: params.proposedDiffId, workspaceId: params.workspaceId },
    });
    invariant(proposedDiff, 404, "NOT_FOUND", "Proposed graph diff not found.");
    invariant(proposedDiff.status === "pending", 409, "INVALID_STATE", "Only pending graph diffs can be edited.");

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
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "context-graph.diff.edited",
      entityType: "ContextGraphProposedDiff",
      entityId: proposedDiff.id,
      meta: {
        objectCount: params.diff.objects?.length ?? 0,
        relationshipCount: params.diff.relationships?.length ?? 0,
        evidenceRefCount: params.diff.evidenceRefs?.length ?? 0,
        mapLayoutUpdateCount: params.diff.mapLayoutUpdates?.length ?? 0,
      },
    });
    return updated;
  });
}

export async function reviewContextGraphProposedDiff(actor: AppActor, params: {
  workspaceId: string;
  proposedDiffId: string;
  status: "approved" | "rejected";
}) {
  await requireGraphApprove(actor, params.workspaceId);
  const reviewedByUserId = actor.kind === "user" ? actor.user.id : null;
  return prisma.$transaction(async (tx) => {
    const proposedDiff = await tx.contextGraphProposedDiff.findFirst({
      where: { id: params.proposedDiffId, workspaceId: params.workspaceId },
    });
    invariant(proposedDiff, 404, "NOT_FOUND", "Proposed graph diff not found.");
    invariant(proposedDiff.status === "pending", 409, "INVALID_STATE", "Only pending graph diffs can be reviewed.");
    const updated = await tx.contextGraphProposedDiff.update({
      where: { id: proposedDiff.id },
      data: {
        status: params.status,
        reviewedByUserId,
        reviewedAt: new Date(),
      },
    });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: `context-graph.diff.${params.status}`,
      entityType: "ContextGraphProposedDiff",
      entityId: proposedDiff.id,
      meta: { status: params.status },
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

  return prisma.$transaction(async (tx) => {
    const proposedDiff = await tx.contextGraphProposedDiff.findFirst({
      where: { id: params.proposedDiffId, workspaceId: params.workspaceId },
    });
    invariant(proposedDiff, 404, "NOT_FOUND", "Proposed graph diff not found.");
    invariant(["pending", "approved"].includes(proposedDiff.status), 409, "INVALID_STATE", "Only pending or approved graph diffs can be applied.");

    const diff = proposedDiff.diffJson as ContextGraphDiffInput;
    validateDiff(diff);
    const refToObjectId = new Map<string, string>();
    const refToRelationshipId = new Map<string, string>();
    const objectIds: string[] = [];
    const relationshipIds: string[] = [];
    const layoutUpdates: Array<{ mapViewId: string; updated: number }> = [];

    for (const objectInput of diff.objects ?? []) {
      const object = await upsertObjectWithTx(tx, actor, params.workspaceId, {
        ...objectInput,
        status: objectInput.status ?? "approved",
      }, proposedDiff.proposedByAgentRunId);
      objectIds.push(object.id);
      if (objectInput.ref) refToObjectId.set(objectInput.ref, object.id);
    }

    for (const relationshipInput of diff.relationships ?? []) {
      const relationship = await upsertRelationshipWithTx(tx, actor, params.workspaceId, {
        ...relationshipInput,
        status: relationshipInput.status ?? "approved",
      }, refToObjectId, proposedDiff.proposedByAgentRunId);
      relationshipIds.push(relationship.id);
      if (relationshipInput.ref) refToRelationshipId.set(relationshipInput.ref, relationship.id);
    }

    for (const evidenceInput of diff.evidenceRefs ?? []) {
      await attachEvidenceWithTx(tx, params.workspaceId, evidenceInput, refToObjectId, refToRelationshipId);
    }

    for (const layoutUpdate of diff.mapLayoutUpdates ?? []) {
      layoutUpdates.push(await applyMapLayoutUpdateWithTx(tx, params.workspaceId, layoutUpdate, {
        actor,
        requireMasterOrOwner: true,
      }));
    }

    const updated = await tx.contextGraphProposedDiff.update({
      where: { id: proposedDiff.id },
      data: {
        status: "applied",
        reviewedByUserId,
        reviewedAt: proposedDiff.reviewedAt ?? new Date(),
        appliedAt: new Date(),
      },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "context-graph.diff.applied",
      entityType: "ContextGraphProposedDiff",
      entityId: proposedDiff.id,
      meta: { objectIds, relationshipIds, layoutUpdates },
    });
    await appendEvents(tx, [{
      workspaceId: params.workspaceId,
      type: "context-graph.diff.applied",
      aggregateType: "ContextGraphProposedDiff",
      aggregateId: proposedDiff.id,
      payload: { proposedDiffId: proposedDiff.id, objectIds, relationshipIds, layoutUpdates },
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
  invariant(selectedObjects.length === selectedIds.length, 404, "NOT_FOUND", "One or more selected objects were not found.");
  for (const object of selectedObjects) {
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
    for (const relationship of relationships) {
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
    for (const object of neighbors) {
      if (!isReadableStatus(object.status, params.includeStale)) continue;
      objectsById.set(object.id, object);
      objectDistanceById.set(
        object.id,
        Math.min(objectDistanceById.get(object.id) ?? Number.POSITIVE_INFINITY, currentDepth + 1),
      );
      frontier.add(object.id);
    }
  }

  const objectIds = [...objectsById.keys()];
  const relationshipIds = [...relationshipsById.keys()];
  const evidenceRefs = await prisma.contextGraphEvidenceRef.findMany({
    where: {
      workspaceId: params.workspaceId,
      OR: [
        { objectId: { in: objectIds } },
        { relationshipId: { in: relationshipIds } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 80,
  });
  const chunkIds = evidenceRefs.map((ref) => ref.knowledgeChunkId).filter((id): id is string => Boolean(id));
  const sensitivityOrder = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "PII"];
  const maxSensitivity = params.maxSensitivity ?? (membership ? "INTERNAL" : "PUBLIC");
  const allowedSensitivity = sensitivityOrder.slice(0, sensitivityOrder.indexOf(maxSensitivity) + 1);
  const knowledgeChunks = chunkIds.length
    ? await prisma.knowledgeChunk.findMany({
      where: {
        id: { in: chunkIds },
        workspaceId: params.workspaceId,
        sensitivity: { in: allowedSensitivity as Array<"PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "PII"> },
      },
      select: {
        id: true,
        sourceType: true,
        sourceId: true,
        sourceTitle: true,
        chunkIndex: true,
        content: true,
        sensitivity: true,
      },
    })
    : [];

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

  return {
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
      sourceType: "REGION_CONTEXT",
      sourceId,
      quote: input.summary.slice(0, 600),
      relevanceScore: input.confidence ?? 0.72,
      metadata: {
        mapViewId: params.mapViewId,
        selectedObjectIds,
        missingFactKind: input.kind,
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

export function contextGraphSystemActor(label = "context-graph-sync"): AppActor {
  return {
    kind: "agent",
    authProvider: "control-plane",
    label,
  };
}

export async function syncContextGraphForMeeting(actor: AppActor, params: { workspaceId: string; meetingId: string }) {
  await requireGraphPropose(actor, params.workspaceId);
  const meeting = await prisma.meeting.findFirst({
    where: { id: params.meetingId, workspaceId: params.workspaceId },
    include: {
      insights: true,
    },
  });
  if (!meeting) return null;

  return prisma.$transaction(async (tx) => {
    const meetingObject = await upsertObjectWithTx(tx, actor, params.workspaceId, {
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

    for (const insight of meeting.insights) {
      if (insight.status === "DISMISSED") continue;
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
        sourceObjectId: object.id,
        targetObjectId: meetingObject.id,
        relationshipType: insight.type === "DECISION" ? "decided_in" : "created_in",
        confidence: insight.confidence,
        status,
        sourceEntityType: "MeetingInsight",
        sourceEntityId: insight.id,
      }, new Map());
      await attachEvidenceWithTx(tx, params.workspaceId, {
        objectId: object.id,
        sourceType: "MEETING",
        sourceId: meeting.id,
        quote: insight.sourceQuote,
        relevanceScore: insight.confidence,
        metadata: { meetingInsightId: insight.id },
      }, new Map(), new Map());
      await attachEvidenceWithTx(tx, params.workspaceId, {
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
