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

export type ContextGraphDiffInput = {
  objects?: ContextGraphObjectInput[];
  relationships?: ContextGraphRelationshipInput[];
  evidenceRefs?: ContextGraphEvidenceInput[];
  mapLayoutUpdates?: ContextMapLayoutUpdateInput[];
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
  const objectType = input.objectType.trim();
  const title = input.title.trim();
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
  const relationshipType = input.relationshipType.trim();
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
  invariant(item.objectId.trim().length > 0, 400, "INVALID_INPUT", "Layout object id is required.");
  invariant(Number.isFinite(item.x) && Number.isFinite(item.y), 400, "INVALID_INPUT", "Layout coordinates must be finite numbers.");
  return {
    objectId: item.objectId.trim(),
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

export async function ensureDefaultContextMapView(actor: AppActor, workspaceId: string) {
  await requireGraphRead(actor, workspaceId);
  const existing = await prisma.contextMapView.findFirst({
    where: { workspaceId, viewType: "process", createdByUserId: null },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;

  return prisma.contextMapView.create({
    data: {
      workspaceId,
      name: "Living process map",
      viewType: "process",
      query: { objectTypes: ["Process", "ProcessStep", "Decision", "Task", "Risk", "Question", "Tool", "Team", "Role", "Meeting"] },
      createdByUserId: null,
    },
  });
}

export async function listContextMapViews(actor: AppActor, workspaceId: string) {
  await requireGraphRead(actor, workspaceId);
  const userId = actorUserId(actor);
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
  const mapView = params.mapViewId
    ? await prisma.contextMapView.findFirst({ where: { id: params.mapViewId, ...visibleMapViewWhere(params.workspaceId, userId) } })
    : await ensureDefaultContextMapView(actor, params.workspaceId);
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
  const [relationships, mapViews, layoutItems, proposedDiffs] = await Promise.all([
    prisma.contextGraphRelationship.findMany({
      where: {
        workspaceId: params.workspaceId,
        status: params.includeStale ? { not: "archived" } : { notIn: ["archived", "stale"] },
        sourceObjectId: { in: objectIds },
        targetObjectId: { in: objectIds },
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

function validateDiff(diff: ContextGraphDiffInput) {
  for (const object of diff.objects ?? []) normalizeObjectInput(object);
  for (const relationship of diff.relationships ?? []) normalizeRelationshipInput(relationship);
  for (const evidence of diff.evidenceRefs ?? []) {
    invariant(evidence.sourceType.trim().length > 0, 400, "INVALID_INPUT", "Evidence source type is required.");
    invariant(evidence.sourceId.trim().length > 0, 400, "INVALID_INPUT", "Evidence source id is required.");
  }
  for (const layoutUpdate of diff.mapLayoutUpdates ?? []) {
    invariant(layoutUpdate.mapViewId.trim().length > 0, 400, "INVALID_INPUT", "Map view id is required.");
    invariant(layoutUpdate.items.length > 0, 400, "INVALID_INPUT", "At least one layout item is required.");
    for (const item of layoutUpdate.items) normalizeLayoutItem(item);
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
  let frontier = new Set(selectedIds);

  const selectedObjects = await prisma.contextGraphObject.findMany({
    where: {
      id: { in: selectedIds },
      workspaceId: params.workspaceId,
      ...timeFilter,
    },
  });
  invariant(selectedObjects.length === selectedIds.length, 404, "NOT_FOUND", "One or more selected objects were not found.");
  for (const object of selectedObjects) objectsById.set(object.id, object);

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

  return {
    selectedObjectIds: selectedIds,
    mapViewId: params.mapViewId ?? null,
    temporalScope: { asOf: asOf?.toISOString() ?? "now", includeStale: Boolean(params.includeStale) },
    objects: [...objectsById.values()],
    relationships: [...relationshipsById.values()],
    evidenceRefs,
    knowledgeChunks,
    staleOrDisputed,
    openQuestions: [...objectsById.values()].filter((object) => object.objectType === "Question" && object.status !== "archived"),
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
