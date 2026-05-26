import type { ModelTool } from "@corgtex/models";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import {
  AppError,
  applyContextGraphProposedDiff,
  buildSelectedRegionContext,
  createContextGraphProposedDiff,
  getContextMapData,
  type ContextGraphDiffInput,
} from "@corgtex/domain";
import type { ConversationPageContext } from "../page-context";

type ContextMapToolContext = {
  workspaceId: string;
  pageContext?: ConversationPageContext | null;
};

type JsonRecord = Record<string, unknown>;

const CONTEXT_MAP_AI_FLAGS = ["CONTEXT_MAPS", "CONTEXT_MAP_AI"];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pageContextMapViewId(ctx: ContextMapToolContext) {
  return ctx.pageContext?.surface === "context-map" ? ctx.pageContext.mapView.id : null;
}

function selectedObjectIds(ctx: ContextMapToolContext, args: JsonRecord) {
  const explicitIds = Array.isArray(args.objectIds) ? args.objectIds.filter((id): id is string => typeof id === "string") : [];
  if (explicitIds.length > 0) {
    return [...new Set(explicitIds)].slice(0, 12);
  }
  const pageIds = ctx.pageContext?.surface === "context-map" ? ctx.pageContext.selectedObjectIds : [];
  return [...new Set(pageIds)].slice(0, 12);
}

function mapObjectSummary(object: {
  id: string;
  objectType: string;
  title: string;
  status: string;
  properties: unknown;
}) {
  return {
    id: object.id,
    objectType: object.objectType,
    title: object.title,
    status: object.status,
    properties: object.properties,
  };
}

function mapRelationshipSummary(relationship: {
  id: string;
  sourceObjectId: string;
  targetObjectId: string;
  relationshipType: string;
  status: string;
}) {
  return {
    id: relationship.id,
    sourceObjectId: relationship.sourceObjectId,
    targetObjectId: relationship.targetObjectId,
    relationshipType: relationship.relationshipType,
    status: relationship.status,
  };
}

function graphEvidence(ctx: ContextMapToolContext, evidence: unknown) {
  return {
    ...(isRecord(evidence) ? evidence : {}),
    kind: "context-map-chat",
    pageContext: ctx.pageContext ?? null,
  };
}

function normalizeDiff(value: unknown): ContextGraphDiffInput {
  if (!isRecord(value)) {
    throw new AppError(400, "INVALID_INPUT", "Context map diff must be an object.");
  }
  return value as ContextGraphDiffInput;
}

function isApprovalError(error: unknown) {
  return isRecord(error) && (error.status === 403 || error.code === "FORBIDDEN");
}

export async function isContextMapAiAvailable(workspaceId: string) {
  const records = await prisma.workspaceFeatureFlag.findMany({
    where: {
      workspaceId,
      flag: { in: CONTEXT_MAP_AI_FLAGS },
    },
    select: { flag: true, enabled: true },
  });
  const enabled = new Map(records.map((record) => [record.flag, record.enabled]));
  return CONTEXT_MAP_AI_FLAGS.every((flag) => enabled.get(flag) === true);
}

async function requireContextMapAi(workspaceId: string) {
  if (!(await isContextMapAiAvailable(workspaceId))) {
    throw new AppError(403, "FEATURE_DISABLED", "Context map AI is not enabled for this workspace.");
  }
}

export const getContextMapInfoTool: ModelTool = {
  type: "function",
  function: {
    name: "get_context_map_info",
    description: "Read bounded metadata for the current context map, selected items, visible objects, and visible relationships. Does not include evidence excerpts.",
    parameters: {
      type: "object",
      properties: {
        mapViewId: { type: "string", description: "Optional context map view id. Defaults to the current page context map view." },
        includeStale: { type: "boolean", description: "Whether to include stale graph facts." },
      },
    },
  },
};

export const getSelectedContextMapRegionTool: ModelTool = {
  type: "function",
  function: {
    name: "get_selected_context_map_region",
    description: "Fetch bounded graph context, evidence, gaps, and likely next actions for selected context map object ids.",
    parameters: {
      type: "object",
      properties: {
        mapViewId: { type: "string", description: "Optional context map view id. Defaults to the current page context map view." },
        objectIds: { type: "array", items: { type: "string" }, description: "Selected ContextGraphObject ids. Defaults to current page selection." },
        depth: { type: "number", description: "Context depth. Default 2, max 2." },
        includeStale: { type: "boolean", description: "Whether to include stale graph facts." },
      },
    },
  },
};

export const createContextMapDiffTool: ModelTool = {
  type: "function",
  function: {
    name: "create_context_map_diff",
    description: "Create a pending proposed diff against the living context map. Use this when approval or review is needed before changing graph truth.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
        diff: { type: "object", description: "ContextGraphDiffInput with objects, objectUpdates, relationships, relationshipUpdates, evidenceRefs, or mapLayoutUpdates." },
        evidence: { type: "object", description: "Optional sanitized evidence metadata." },
      },
      required: ["diff"],
    },
  },
};

export const applyContextMapDiffTool: ModelTool = {
  type: "function",
  function: {
    name: "apply_context_map_diff",
    description: "Create a proposed context map diff and immediately apply it if the actor has graph approval permission. If approval is not allowed, leaves the diff pending.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
        diff: { type: "object", description: "ContextGraphDiffInput to propose and apply." },
        evidence: { type: "object", description: "Optional sanitized evidence metadata." },
      },
      required: ["diff"],
    },
  },
};

export const contextMapTools = [
  getContextMapInfoTool,
  getSelectedContextMapRegionTool,
  createContextMapDiffTool,
  applyContextMapDiffTool,
];

export async function getContextMapInfoAction(actor: AppActor, ctx: ContextMapToolContext, args: JsonRecord) {
  await requireContextMapAi(ctx.workspaceId);
  const mapViewId = typeof args.mapViewId === "string" ? args.mapViewId : pageContextMapViewId(ctx);
  const data = await getContextMapData(actor, {
    workspaceId: ctx.workspaceId,
    mapViewId,
    includeStale: args.includeStale === true || ctx.pageContext?.includeStale === true,
  });
  const selectedIds = new Set(selectedObjectIds(ctx, args));
  return {
    mapView: data.mapView,
    permissions: data.permissions,
    currentPageContext: ctx.pageContext ?? null,
    selectedObjects: data.objects.filter((object) => selectedIds.has(object.id)).map(mapObjectSummary),
    visibleObjects: data.objects.slice(0, 80).map(mapObjectSummary),
    visibleRelationships: data.relationships.slice(0, 120).map(mapRelationshipSummary),
  };
}

export async function getSelectedContextMapRegionAction(actor: AppActor, ctx: ContextMapToolContext, args: JsonRecord) {
  await requireContextMapAi(ctx.workspaceId);
  const objectIds = selectedObjectIds(ctx, args);
  if (objectIds.length === 0) {
    throw new AppError(400, "INVALID_INPUT", "Select or provide at least one context map object id.");
  }
  const requestedDepth = Number(args.depth ?? 2);
  return buildSelectedRegionContext(actor, {
    workspaceId: ctx.workspaceId,
    mapViewId: typeof args.mapViewId === "string" ? args.mapViewId : pageContextMapViewId(ctx),
    objectIds,
    depth: Number.isFinite(requestedDepth) ? Math.min(requestedDepth, 2) : 2,
    includeStale: args.includeStale === true || ctx.pageContext?.includeStale === true,
  });
}

export async function createContextMapDiffAction(actor: AppActor, ctx: ContextMapToolContext, args: JsonRecord) {
  await requireContextMapAi(ctx.workspaceId);
  const proposedDiff = await createContextGraphProposedDiff(actor, {
    workspaceId: ctx.workspaceId,
    reason: typeof args.reason === "string" ? args.reason : "Context map chat proposed a graph change.",
    diff: normalizeDiff(args.diff),
    evidence: graphEvidence(ctx, args.evidence),
  });
  return {
    mode: "proposed",
    proposedDiffId: proposedDiff.id,
    status: proposedDiff.status,
  };
}

export async function applyContextMapDiffAction(actor: AppActor, ctx: ContextMapToolContext, args: JsonRecord) {
  await requireContextMapAi(ctx.workspaceId);
  const proposedDiff = await createContextGraphProposedDiff(actor, {
    workspaceId: ctx.workspaceId,
    reason: typeof args.reason === "string" ? args.reason : "Context map chat applied a graph change.",
    diff: normalizeDiff(args.diff),
    evidence: graphEvidence(ctx, args.evidence),
  });

  try {
    const applied = await applyContextGraphProposedDiff(actor, {
      workspaceId: ctx.workspaceId,
      proposedDiffId: proposedDiff.id,
    });
    return {
      mode: "applied",
      proposedDiffId: proposedDiff.id,
      status: applied.status,
    };
  } catch (error) {
    if (isApprovalError(error)) {
      return {
        mode: "approval_required",
        proposedDiffId: proposedDiff.id,
        status: proposedDiff.status,
        message: "Created a pending context map change, but this actor cannot apply graph changes directly.",
      };
    }
    throw error;
  }
}

export const contextMapToolHandlers = {
  get_context_map_info: getContextMapInfoAction,
  get_selected_context_map_region: getSelectedContextMapRegionAction,
  create_context_map_diff: createContextMapDiffAction,
  apply_context_map_diff: applyContextMapDiffAction,
};
