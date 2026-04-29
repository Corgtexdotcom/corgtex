"use server";

import { revalidatePath } from "next/cache";
import { configureSupportConnector, fetchCustomerSupportSnapshot, recordBreakGlassSupportNote, runCustomerSupportOperation } from "@corgtex/domain";
import type { SupportAction } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";

function asString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(formData: FormData, key: string) {
  const value = asString(formData, key);
  return value.length > 0 ? value : null;
}

function parseJsonObject(value: string) {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export async function configureSupportConnectorAction(formData: FormData) {
  const actor = await requirePageActor();
  const instanceId = asString(formData, "instanceId");
  await configureSupportConnector(actor, {
    instanceId,
    supportBaseUrl: optionalString(formData, "supportBaseUrl"),
    supportMcpUrl: optionalString(formData, "supportMcpUrl"),
    supportCredential: asString(formData, "supportCredential"),
    supportCredentialLabel: optionalString(formData, "supportCredentialLabel"),
    supportNotes: optionalString(formData, "supportNotes"),
  });
  revalidatePath(`/control-plane/customers/${instanceId}`);
}

export async function runSupportOperationAction(formData: FormData) {
  const actor = await requirePageActor();
  const instanceId = asString(formData, "instanceId");
  const action = asString(formData, "action") as SupportAction;
  await runCustomerSupportOperation(actor, {
    instanceId,
    action,
    reason: optionalString(formData, "reason"),
    arguments: parseJsonObject(asString(formData, "argumentsJson")),
    remoteWorkspaceId: optionalString(formData, "remoteWorkspaceId"),
  });
  revalidatePath(`/control-plane/customers/${instanceId}`);
}

export async function recordBreakGlassAction(formData: FormData) {
  const actor = await requirePageActor();
  const instanceId = asString(formData, "instanceId");
  await recordBreakGlassSupportNote(actor, {
    instanceId,
    reason: asString(formData, "reason"),
    notes: asString(formData, "notes"),
  });
  revalidatePath(`/control-plane/customers/${instanceId}`);
}

export async function refreshSupportSnapshotAction(formData: FormData) {
  const actor = await requirePageActor();
  const instanceId = asString(formData, "instanceId");
  await fetchCustomerSupportSnapshot(actor, instanceId);
  revalidatePath(`/control-plane/customers/${instanceId}`);
}
