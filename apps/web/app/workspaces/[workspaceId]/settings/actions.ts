"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, asOptionalInt, refresh } from "../action-utils";
import {
  createMember,
  deactivateMember,
  markAllNotificationsRead,
  updateMember,
  resolveAgentRun,
  createWebhookEndpoint,
  updateWebhookEndpoint,
  deleteWebhookEndpoint,
  rotateWebhookSecret,
  createExpertiseTag,
  addMemberExpertise,
  endorseMemberExpertise,
  upsertSsoConfig,
  updateModelUsageBudget
} from "@corgtex/domain";


export async function createMemberAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createMember(actor, {
    workspaceId,
    email: asString(formData, "email"),
    password: asString(formData, "password"),
    displayName: asOptional(formData, "displayName"),
    role: asString(formData, "role") as "CONTRIBUTOR" | "FACILITATOR" | "FINANCE_STEWARD" | "ADMIN",
  });
  refresh(workspaceId);
}

export async function updateMemberAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await updateMember(actor, {
    workspaceId,
    memberId: asString(formData, "memberId"),
    role: asOptional(formData, "role") as "CONTRIBUTOR" | "FACILITATOR" | "FINANCE_STEWARD" | "ADMIN" | undefined ?? undefined,
  });
  refresh(workspaceId);
}

export async function deactivateMemberAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await deactivateMember(actor, {
    workspaceId,
    memberId: asString(formData, "memberId"),
  });
  refresh(workspaceId);
}

export async function markAllNotificationsReadAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await markAllNotificationsRead(actor, workspaceId);
  refresh(workspaceId);
}


export async function createWebhookEndpointAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const eventTypesRaw = asOptional(formData, "eventTypes");
  const eventTypes = eventTypesRaw
    ? eventTypesRaw.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  await createWebhookEndpoint(actor, {
    workspaceId,
    url: asString(formData, "url"),
    label: asOptional(formData, "label"),
    eventTypes,
  });
  refresh(workspaceId);
}

export async function updateWebhookEndpointAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await updateWebhookEndpoint(actor, {
    workspaceId,
    endpointId: asString(formData, "endpointId"),
    status: asOptional(formData, "status") as "ACTIVE" | "PAUSED" | "DISABLED" | null ?? undefined,
  });
  refresh(workspaceId);
}

export async function deleteWebhookEndpointAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await deleteWebhookEndpoint(actor, {
    workspaceId,
    endpointId: asString(formData, "endpointId"),
  });
  refresh(workspaceId);
}

export async function rotateWebhookSecretAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await rotateWebhookSecret(actor, {
    workspaceId,
    endpointId: asString(formData, "endpointId"),
  });
  refresh(workspaceId);
}

export async function resolveAgentRunAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await resolveAgentRun(actor, {
    workspaceId,
    agentRunId: asString(formData, "agentRunId"),
    status: asString(formData, "status") as "COMPLETED" | "CANCELLED",
  });
  refresh(workspaceId);
}


export async function createExpertiseTagAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createExpertiseTag(actor, {
    workspaceId,
    label: asString(formData, "label"),
    description: asOptional(formData, "description") || undefined,
  });
  refresh(workspaceId);
}

export async function addMemberExpertiseAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await addMemberExpertise(actor, {
    workspaceId,
    memberId: asString(formData, "memberId"),
    tagId: asString(formData, "tagId"),
    level: asOptional(formData, "level") as "LEARNING" | "PRACTITIONER" | "EXPERT" | "AUTHORITY" | undefined,
  });
  refresh(workspaceId);
}

export async function endorseMemberExpertiseAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await endorseMemberExpertise(actor, {
    workspaceId,
    memberId: asString(formData, "memberId"),
    tagId: asString(formData, "tagId"),
  });
  refresh(workspaceId);
}

export async function upsertSsoConfigAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const allowedDomainsRaw = asString(formData, "allowedDomains");
  const allowedDomains = allowedDomainsRaw.split(",").map((domain) => domain.trim().toLowerCase()).filter(Boolean);

  await upsertSsoConfig(actor, {
    workspaceId,
    provider: asString(formData, "provider"),
    clientId: asString(formData, "clientId"),
    clientSecretEnc: asString(formData, "clientSecret"),
    allowedDomains,
    isEnabled: formData.get("isEnabled") === "true",
  });

  refresh(workspaceId);
}

export async function updateModelUsageBudgetAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const monthlyCostCapUsd = parseFloat(asString(formData, "monthlyCostCapUsd"));
  const alertThresholdPct = parseInt(asString(formData, "alertThresholdPct"), 10);
  const periodStartDay = parseInt(asString(formData, "periodStartDay"), 10);

  await updateModelUsageBudget(actor, {
    workspaceId,
    monthlyCostCapUsd: isNaN(monthlyCostCapUsd) ? -1 : monthlyCostCapUsd,
    alertThresholdPct: isNaN(alertThresholdPct) ? 80 : alertThresholdPct,
    periodStartDay: isNaN(periodStartDay) ? 1 : periodStartDay,
  });

  refresh(workspaceId);
}
