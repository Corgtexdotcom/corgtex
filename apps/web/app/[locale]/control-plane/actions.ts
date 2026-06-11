"use server";

import { revalidatePath } from "next/cache";
import {
  configureControlPlaneMeetingRecorderIntegration,
  configureSupportConnector,
  createControlPlaneCustomerMember,
  deployLatestControlPlaneRelease,
  disconnectControlPlaneSlackInstallation,
  enqueueControlPlaneDeployLatestRollout,
  assignEnterpriseAppSurface,
  fetchCustomerSupportSnapshot,
  installEnterpriseApp,
  probeEnterpriseAppInstallationHealth,
  recordBreakGlassSupportNote,
  revokeEnterpriseAppInstallationSessions,
  revokeControlPlaneAgentCredential,
  resendControlPlaneCustomerMemberAccessLink,
  runControlPlaneContextOperation,
  runControlPlaneMeetingRecorderOperation,
  runControlPlaneReleaseOperation,
  runCustomerSupportOperation,
  setControlPlaneFeatureFlag,
  updateControlPlaneSlackAgendaSettings,
  updateControlPlaneAgentCredentialScopes,
  updateControlPlaneAgentPolicy,
  updateControlPlaneCustomerMemberStatus,
  updateControlPlaneModelBudget,
  updateEnterpriseAppInstallation,
} from "@corgtex/domain";
import type { SupportAction } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { invalidateControlPlaneReadCache } from "./cache";

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

function asRequiredBoolean(formData: FormData, key: string) {
  const value = asString(formData, key);
  if (value !== "true" && value !== "false") {
    throw new Error(`${key} must be true or false.`);
  }
  return value === "true";
}

function asOptionalNumber(formData: FormData, key: string) {
  const value = asString(formData, key);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const LOCAL_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const TIMEZONE_AWARE_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?([zZ]|[+-]\d{2}:\d{2})$/;

function parseDateTimeLocalWithOffset(value: string, offsetMinutesRaw: string | null) {
  const timezoneAwareMatch = value.match(TIMEZONE_AWARE_DATETIME_PATTERN);
  if (timezoneAwareMatch) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.valueOf()) || !timezoneAwareTimestampMatchesInput(parsed, timezoneAwareMatch)) {
      throw new Error("joinAt must be a valid datetime.");
    }
    return parsed;
  }
  const match = value.match(LOCAL_DATETIME_PATTERN);
  const offsetMinutes = offsetMinutesRaw === null ? NaN : Number(offsetMinutesRaw);
  if (!match) {
    throw new Error("joinAt must be a valid datetime.");
  }
  if (!Number.isInteger(offsetMinutes)) {
    throw new Error("joinAt timezone offset is required.");
  }
  const [, year, month, day, hour, minute, second = "0"] = match;
  const parsed = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ) + offsetMinutes * 60_000);
  if (Number.isNaN(parsed.valueOf()) || !localTimestampMatchesInput(parsed, match, offsetMinutes)) {
    throw new Error("joinAt must be a valid datetime.");
  }
  return parsed;
}

function timezoneAwareTimestampMatchesInput(parsed: Date, match: RegExpMatchArray) {
  const [, year, month, day, hour, minute, second = "0", fraction = "0", zone] = match;
  const offsetMinutes = zone.toUpperCase() === "Z"
    ? 0
    : (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * (zone.startsWith("-") ? -1 : 1);
  const local = new Date(parsed.getTime() + offsetMinutes * 60_000);
  return localDateTimeMatches(local, year, month, day, hour, minute, second, fraction);
}

function localTimestampMatchesInput(parsed: Date, match: RegExpMatchArray, offsetMinutes: number) {
  const [, year, month, day, hour, minute, second = "0"] = match;
  const local = new Date(parsed.getTime() - offsetMinutes * 60_000);
  return localDateTimeMatches(local, year, month, day, hour, minute, second, "0");
}

function localDateTimeMatches(
  date: Date,
  year: string,
  month: string,
  day: string,
  hour: string,
  minute: string,
  second: string,
  fraction: string,
) {
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() + 1 === Number(month)
    && date.getUTCDate() === Number(day)
    && date.getUTCHours() === Number(hour)
    && date.getUTCMinutes() === Number(minute)
    && date.getUTCSeconds() === Number(second)
    && date.getUTCMilliseconds() === Number(fraction.slice(0, 3).padEnd(3, "0"));
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
  invalidateControlPlaneReadCache();
  revalidatePath(`/control-plane/deployments/${deploymentId}`);
  revalidatePath(`/es/control-plane/deployments/${deploymentId}`);
  revalidatePath(`/control-plane/deployments/${deploymentId}/agent-governance`);
  revalidatePath(`/es/control-plane/deployments/${deploymentId}/agent-governance`);
}

function revalidateEnterpriseAppWorkspace(workspaceId: string) {
  revalidatePath(`/workspaces/${workspaceId}/finance`);
  revalidatePath(`/es/workspaces/${workspaceId}/finance`);
  revalidatePath(`/workspaces/${workspaceId}/tools`);
  revalidatePath(`/es/workspaces/${workspaceId}/tools`);
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

export async function runMeetingRecorderOperationAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  const joinAtRaw = optionalString(formData, "joinAt");
  const joinAtTimezoneOffsetMinutes = optionalString(formData, "joinAtTimezoneOffsetMinutes");
  await runControlPlaneMeetingRecorderOperation(actor, {
    deploymentId,
    operation: asString(formData, "operation") as "enqueue_calendar_sync" | "dry_run_scan" | "live_smoke" | "enable_auto_recording_after_smoke",
    meetingUrl: optionalString(formData, "meetingUrl"),
    joinAt: joinAtRaw ? parseDateTimeLocalWithOffset(joinAtRaw, joinAtTimezoneOffsetMinutes) : null,
    provider: optionalString(formData, "provider"),
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
}

export async function updateControlPlaneSlackAgendaSettingsAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  await updateControlPlaneSlackAgendaSettings(actor, {
    deploymentId,
    installationId: asString(formData, "installationId"),
    defaultAgendaChannelId: optionalString(formData, "defaultAgendaChannelId"),
    agendaTimezone: optionalString(formData, "agendaTimezone"),
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
}

export async function disconnectControlPlaneSlackInstallationAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  await disconnectControlPlaneSlackInstallation(actor, {
    deploymentId,
    installationId: asString(formData, "installationId"),
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
  const role = asString(formData, "role");
  if (!role) {
    throw new Error("role is required.");
  }
  await createControlPlaneCustomerMember(actor, {
    deploymentId,
    email: asString(formData, "email"),
    displayName: optionalString(formData, "displayName"),
    role,
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
    isActive: asRequiredBoolean(formData, "isActive"),
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
    enabled: asRequiredBoolean(formData, "enabled"),
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
}

export async function installEnterpriseAppFromControlPlaneAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  const workspaceId = asString(formData, "workspaceId");
  await installEnterpriseApp(actor, {
    workspaceId,
    appKey: asString(formData, "appKey") || "practice-ledger",
    surface: optionalString(formData, "surface"),
    runtimeMode: optionalString(formData, "runtimeMode"),
    runtimeBaseUrl: optionalString(formData, "runtimeBaseUrl"),
    runtimeHealthUrl: optionalString(formData, "runtimeHealthUrl"),
    runtimeMcpUrl: optionalString(formData, "runtimeMcpUrl"),
    tenantExternalId: optionalString(formData, "tenantExternalId"),
    launchPath: optionalString(formData, "launchPath"),
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
  revalidateEnterpriseAppWorkspace(workspaceId);
}

export async function updateEnterpriseAppFromControlPlaneAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  const workspaceId = asString(formData, "workspaceId");
  await updateEnterpriseAppInstallation(actor, {
    workspaceId,
    appInstallationId: asString(formData, "appInstallationId"),
    status: optionalString(formData, "status"),
    runtimeMode: optionalString(formData, "runtimeMode"),
    runtimeStatus: optionalString(formData, "runtimeStatus"),
    runtimeBaseUrl: optionalString(formData, "runtimeBaseUrl"),
    runtimeHealthUrl: optionalString(formData, "runtimeHealthUrl"),
    runtimeMcpUrl: optionalString(formData, "runtimeMcpUrl"),
    tenantExternalId: optionalString(formData, "tenantExternalId"),
    launchPath: optionalString(formData, "launchPath"),
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
  revalidateEnterpriseAppWorkspace(workspaceId);
}

export async function setEnterpriseAppSurfaceFromControlPlaneAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  const workspaceId = asString(formData, "workspaceId");
  await assignEnterpriseAppSurface(actor, {
    workspaceId,
    appInstallationId: asString(formData, "appInstallationId"),
    surface: asString(formData, "surface"),
    enabled: asRequiredBoolean(formData, "enabled"),
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
  revalidateEnterpriseAppWorkspace(workspaceId);
}

export async function probeEnterpriseAppHealthFromControlPlaneAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  const workspaceId = asString(formData, "workspaceId");
  await probeEnterpriseAppInstallationHealth(actor, {
    workspaceId,
    appInstallationId: asString(formData, "appInstallationId"),
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
  revalidateEnterpriseAppWorkspace(workspaceId);
}

export async function revokeEnterpriseAppSessionsFromControlPlaneAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  const workspaceId = asString(formData, "workspaceId");
  await revokeEnterpriseAppInstallationSessions(actor, {
    workspaceId,
    appInstallationId: asString(formData, "appInstallationId"),
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
  revalidateEnterpriseAppWorkspace(workspaceId);
}

export async function updateControlPlaneAgentCredentialScopesAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  await updateControlPlaneAgentCredentialScopes(actor, {
    deploymentId,
    credentialId: asString(formData, "credentialId"),
    scopes: asStringArray(formData, "scopes"),
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
}

export async function revokeControlPlaneAgentCredentialAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  await revokeControlPlaneAgentCredential(actor, {
    deploymentId,
    credentialId: asString(formData, "credentialId"),
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
}

export async function updateControlPlaneModelBudgetAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  const monthlyCostCapUsd = asOptionalNumber(formData, "monthlyCostCapUsd");
  if (monthlyCostCapUsd === undefined) {
    throw new Error("monthlyCostCapUsd is required.");
  }
  await updateControlPlaneModelBudget(actor, {
    deploymentId,
    monthlyCostCapUsd,
    alertThresholdPct: asOptionalNumber(formData, "alertThresholdPct"),
    periodStartDay: asOptionalNumber(formData, "periodStartDay"),
    reason: asString(formData, "reason"),
  });
  revalidateControlPlaneDeployment(deploymentId);
}

export async function updateControlPlaneAgentPolicyAction(formData: FormData) {
  const actor = await requirePageActor();
  const deploymentId = asString(formData, "deploymentId");
  await updateControlPlaneAgentPolicy(actor, {
    deploymentId,
    agentKey: asString(formData, "agentKey"),
    governancePolicy: optionalString(formData, "governancePolicy"),
    modelOverride: optionalString(formData, "modelOverride"),
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
    force: false,
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
  invalidateControlPlaneReadCache();
  revalidatePath("/control-plane");
  revalidatePath("/es/control-plane");
}
