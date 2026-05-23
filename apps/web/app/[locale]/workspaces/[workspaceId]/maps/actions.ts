"use server";

import { revalidatePath } from "next/cache";

import {
  applyContextGraphProposedDiff,
  buildSelectedRegionContext,
  createContextGraphProposedDiff,
  updateContextMapLayout,
} from "@corgtex/domain";

import { requirePageActor } from "@/lib/auth";

export async function saveContextMapLayoutAction(params: {
  workspaceId: string;
  mapViewId: string;
  items: Array<{ objectId: string; x: number; y: number; width?: number | null; height?: number | null }>;
}) {
  const actor = await requirePageActor();
  await updateContextMapLayout(actor, {
    workspaceId: params.workspaceId,
    mapViewId: params.mapViewId,
    items: params.items,
  });
  revalidatePath(`/workspaces/${params.workspaceId}/maps`);
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

export async function applyContextGraphProposedDiffAction(params: {
  workspaceId: string;
  proposedDiffId: string;
}) {
  const actor = await requirePageActor();
  const result = await applyContextGraphProposedDiff(actor, params);
  revalidatePath(`/workspaces/${params.workspaceId}/maps`);
  return result;
}
