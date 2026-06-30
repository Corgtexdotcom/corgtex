"use server";

import { revalidatePath } from "next/cache";
import {
  enqueueExternalContentSourceSync,
  selectExternalContentSource,
} from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";

function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateToolPath(workspaceId: string, catalogItemId: string) {
  revalidatePath(`/workspaces/${workspaceId}/tools/${catalogItemId}`);
}

export async function selectBoxExternalContentSourceAction(formData: FormData) {
  const actor = await requirePageActor();
  const workspaceId = formString(formData, "workspaceId");
  const catalogItemId = formString(formData, "catalogItemId");
  await selectExternalContentSource(actor, {
    workspaceId,
    providerKey: "box",
    sourceKind: formString(formData, "sourceKind"),
    externalId: formString(formData, "externalId"),
    title: formString(formData, "title"),
    externalUrl: formString(formData, "externalUrl"),
    connectionId: formString(formData, "connectionId"),
    metadata: {
      selectedFrom: "tools_connector_panel",
    },
  });
  revalidateToolPath(workspaceId, catalogItemId);
}

export async function syncBoxExternalContentSourceAction(formData: FormData) {
  const actor = await requirePageActor();
  const workspaceId = formString(formData, "workspaceId");
  const catalogItemId = formString(formData, "catalogItemId");
  await enqueueExternalContentSourceSync(actor, {
    workspaceId,
    sourceId: formString(formData, "sourceId"),
  });
  revalidateToolPath(workspaceId, catalogItemId);
}
