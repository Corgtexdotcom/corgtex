"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { purgeWorkspaceArtifact, restoreWorkspaceArtifact } from "@corgtex/domain";
import { asString, refresh } from "../action-utils";

export async function restoreArchivedArtifactAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  if (workspaceId) await enforceDemoGuard(workspaceId);

  const actor = await requirePageActor();
  await restoreWorkspaceArtifact(actor, {
    workspaceId,
    entityType: asString(formData, "entityType"),
    entityId: asString(formData, "entityId"),
  });
  refresh(workspaceId);
}

export async function purgeArchivedArtifactAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  if (workspaceId) await enforceDemoGuard(workspaceId);

  const actor = await requirePageActor();
  await purgeWorkspaceArtifact(actor, {
    workspaceId,
    entityType: asString(formData, "entityType"),
    entityId: asString(formData, "entityId"),
    reason: asString(formData, "reason"),
  });
  refresh(workspaceId);
}
