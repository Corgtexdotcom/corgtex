"use server";

import { revalidatePath } from "next/cache";
import {
  configureControlPlaneMeetingRecorderIntegration,
  configureSupportConnector,
  createControlPlaneCustomerMember,
  deployLatestControlPlaneRelease,
  enqueueControlPlaneDeployLatestRollout,
  fetchCustomerSupportSnapshot,
  recordBreakGlassSupportNote,
  resendControlPlaneCustomerMemberAccessLink,
  runControlPlaneContextOperation,
  runControlPlaneReleaseOperation,
  runCustomerSupportOperation,
  setControlPlaneFeatureFlag,
  updateControlPlaneCustomerMemberStatus,
} from "@corgtex/domain";
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

function asBoolean(formData: FormData, key: string) {
  return asString(formData, key) === "true";
}

function asOptionalNumber(formData: FormData, key: string) {
  const value = asString(formData, key);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asBooleanFromCheckbox(formData: FormData, key: string) {
  const value = formData.get(key);
  return value === "on" || value === "true";
}

function asStringArray(formData: FormData, key: string) {
  return formData.getAll(key).filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function parseJsonObject(value: string) {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function revalidateControlPlaneDeployment(deploymentId: string) {
  revalidatePath(`/control-plane/deployments/${deploymentId}`);
  revalidatePath(`/es/control-plane/deployments/${deploymentId}`);
}

export async function configureSupportConnectorAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  await configureSupportConnector(actor, {
    deploymentId,
    supportBaseUrl: optionalString(formData, "supportBaseUrl"),
    supportMcpUrl: optionalString(formData, "supportMcpUrl"),
    supportCredential: asString(formData, "supportCredential"),
    supportCredentialLabel: optionalString(formData, "supportCredentialLabel"),
    supportNotes: optionalString(formData, "supportNotes"),
  });
  revalidateControlPlaneDeployment(deploymentId);
}

export async function runSupportOperationAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  const action = asString(formData, "action") as SupportAction;
  await runCustomerSupportOperation(actor, {
    deploymentId,
    action,
    reason: optionalString(formData, "reason"),
    arguments: parseJsonObject(asString(formData, "argumentsJson")),
    remoteWorkspaceId: optionalString(formData, "remoteWorkspaceId"),
  });
  revalidateControlPlaneDeployment(deploymentId);
}

export async function recordBreakGlassAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  await recordBreakGlassSupportNote(actor, {
    deploymentId,
    reason: asString(formData, "reason"),
    notes: asString(formData, "notes"),
  });
  revalidateControlPlaneDeployment(deploymentId);
}

export async function refreshSupportSnapshotAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  await fetchCustomerSupportSnapshot(actor, deploymentId);
  revalidateControlPlaneDeployment(deploymentId);
}

export async function configureMeetingRecorderIntegrationAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  await configureControlPlaneMeetingRecorderIntegration(actor, {
    deploymentId,
    entitlementEnabled: asBoolean(formData, "entitlementEnabled"),
    enabled: asBoolean(formData, "enabled"),
    autoRecordEnabled: asBoolean(formData, "autoRecordEnabled"),
    defaultProvider: asString(formData, "defaultProvider"),
    fallbackProvider: optionalString(formData, "fallbackProvider"),
    monthlyMinuteCap: asOptionalNumber(formData, "monthlyMinuteCap") ?? 6_000,
    botName: optionalString(formData, "botName"),
    entryMessage: optionalString(formData, "entryMessage"),
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
}

export async function runContextOperationAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  await runControlPlaneContextOperation(actor, {
    deploymentId,
    operation: asString(formData, "operation"),
    sourceId: optionalString(formData, "sourceId"),
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
}

export async function runReleaseOperationAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  await runControlPlaneReleaseOperation(actor, {
    deploymentId,
    operation: asString(formData, "operation"),
    targetReleaseImageTag: asString(formData, "targetReleaseImageTag"),
    targetReleaseVersion: optionalString(formData, "targetReleaseVersion"),
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
}

export async function createControlPlaneMemberAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  await createControlPlaneCustomerMember(actor, {
    deploymentId,
    email: asString(formData, "email"),
    displayName: optionalString(formData, "displayName"),
    role: asString(formData, "role") || "CONTRIBUTOR",
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
}

export async function resendControlPlaneAccessLinkAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  await resendControlPlaneCustomerMemberAccessLink(actor, {
    deploymentId,
    memberId: asString(formData, "memberId"),
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
}

export async function updateControlPlaneMemberStatusAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  await updateControlPlaneCustomerMemberStatus(actor, {
    deploymentId,
    memberId: asString(formData, "memberId"),
    isActive: asString(formData, "isActive") === "true",
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
}

export async function setControlPlaneFeatureFlagAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  await setControlPlaneFeatureFlag(actor, {
    deploymentId,
    flag: asString(formData, "flag"),
    enabled: asString(formData, "enabled") === "true",
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
}

export async function deployLatestControlPlaneReleaseAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  await deployLatestControlPlaneRelease(actor, {
    deploymentId,
    reason: asString(formData, "reason"),
    force: asBooleanFromCheckbox(formData, "force"),
  });
  revalidateControlPlaneDeployment(deploymentId);
}

export async function enqueueDeployLatestRolloutAction(formData: FormData) {
  const actor = await requirePageActor();
  await enqueueControlPlaneDeployLatestRollout(actor, {
    deploymentIds: asStringArray(formData, "deploymentIds"),
    allEligible: asBooleanFromCheckbox(formData, "allEligible"),
    includeUnhealthy: asBooleanFromCheckbox(formData, "includeUnhealthy"),
    reason: asString(formData, "reason"),
    limit: asOptionalNumber(formData, "limit") ?? 100,
  });
  revalidatePath("/control-plane");
  revalidatePath("/es/control-plane");
}
