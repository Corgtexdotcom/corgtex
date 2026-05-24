"use server";

import { revalidatePath } from "next/cache";

import {
  AppError,
  applyContextGraphProposedDiff,
  buildSelectedRegionContext,
  createContextGraphProposedDiff,
  createMissingRegionFactsProposal,
  createPersonalContextMapView,
  reviewContextGraphProposedDiff,
  updateContextMapLayout,
  updateContextGraphProposedDiff,
} from "@corgtex/domain";

import { requirePageActor } from "@/lib/auth";

type EditableContextGraphDiff = Parameters<typeof updateContextGraphProposedDiff>[1]["diff"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertEditableContextGraphDiff(value: unknown): asserts value is EditableContextGraphDiff {
  if (!isRecord(value)) {
    throw new AppError(400, "INVALID_INPUT", "Edited graph diff must be an object.");
  }
  for (const key of ["objects", "relationships", "evidenceRefs", "mapLayoutUpdates"] as const) {
    if (value[key] !== undefined && !Array.isArray(value[key])) {
      throw new AppError(400, "INVALID_INPUT", `Edited graph diff ${key} must be an array.`);
    }
  }
}

export async function saveContextMapLayoutAction(params: {
  workspaceId: string;
  mapViewId: string;
  items: Array<{ objectId: string; x: number; y: number; width?: number | null; height?: number | null }>;
}) {
  const actor = await requirePageActor();
  const result = await updateContextMapLayout(actor, {
    workspaceId: params.workspaceId,
    mapViewId: params.mapViewId,
    items: params.items,
  });
  revalidatePath(`/workspaces/${params.workspaceId}/maps`);
  return result;
}

export async function createPersonalContextMapViewAction(params: {
  workspaceId: string;
  sourceMapViewId: string;
  name?: string | null;
  items?: Array<{ objectId: string; x: number; y: number; width?: number | null; height?: number | null }>;
}) {
  const actor = await requirePageActor();
  const mapView = await createPersonalContextMapView(actor, params);
  revalidatePath(`/workspaces/${params.workspaceId}/maps`);
  return { id: mapView.id, name: mapView.name };
}

export async function buildSelectedRegionContextAction(params: {
  workspaceId: string;
  mapViewId: string;
  objectIds: string[];
}) {
  const actor = await requirePageActor();
  return buildSelectedRegionContext(actor, {
    workspaceId: params.workspaceId,
    mapViewId: params.mapViewId,
    objectIds: params.objectIds,
    depth: 2,
  });
}

export async function createRegionProposalAction(params: {
  workspaceId: string;
  mapViewId: string;
  objectIds: string[];
}) {
  const actor = await requirePageActor();
  const context = await buildSelectedRegionContext(actor, {
    workspaceId: params.workspaceId,
    mapViewId: params.mapViewId,
    objectIds: params.objectIds,
    depth: 2,
  });
  const title = `Review context region: ${context.objects.slice(0, 3).map((object) => object.title).join(", ")}`;
  const proposedDiff = await createContextGraphProposedDiff(actor, {
    workspaceId: params.workspaceId,
    reason: "User requested an agent-ready review of the selected map region.",
    evidence: {
      mapViewId: params.mapViewId,
      selectedObjectIds: params.objectIds,
      contextObjectCount: context.objects.length,
      contextRelationshipCount: context.relationships.length,
    },
    diff: {
      objects: [{
        ref: "region-question",
        objectType: "Question",
        title: title.slice(0, 180),
        summary: "Review this selected map region and propose any missing owners, blockers, stale facts, or next actions before changing company truth.",
        status: "proposed",
        sourceEntityType: "ContextMapView",
        sourceEntityId: params.mapViewId,
        properties: {
          selectedObjectIds: params.objectIds,
        },
      }],
    },
  });
  revalidatePath(`/workspaces/${params.workspaceId}/maps`);
  return proposedDiff;
}

export async function createMissingRegionFactsProposalAction(params: {
  workspaceId: string;
  mapViewId: string;
  objectIds: string[];
}) {
  const actor = await requirePageActor();
  const proposedDiff = await createMissingRegionFactsProposal(actor, params);
  revalidatePath(`/workspaces/${params.workspaceId}/maps`);
  return proposedDiff;
}

export async function updateContextGraphProposedDiffAction(params: {
  workspaceId: string;
  proposedDiffId: string;
  reason?: string | null;
  diff: unknown;
}) {
  const actor = await requirePageActor();
  assertEditableContextGraphDiff(params.diff);
  const result = await updateContextGraphProposedDiff(actor, {
    workspaceId: params.workspaceId,
    proposedDiffId: params.proposedDiffId,
    reason: params.reason,
    diff: params.diff,
  });
  revalidatePath(`/workspaces/${params.workspaceId}/maps`);
  return result;
}

export async function reviewContextGraphProposedDiffAction(params: {
  workspaceId: string;
  proposedDiffId: string;
  status: "approved" | "rejected";
}) {
  const actor = await requirePageActor();
  const result = await reviewContextGraphProposedDiff(actor, params);
  revalidatePath(`/workspaces/${params.workspaceId}/maps`);
  return result;
}

export async function applyContextGraphProposedDiffAction(params: {
  workspaceId: string;
  proposedDiffId: string;
}) {
  const actor = await requirePageActor();
  const result = await applyContextGraphProposedDiff(actor, params);
  revalidatePath(`/workspaces/${params.workspaceId}/maps`);
  return result;
}
