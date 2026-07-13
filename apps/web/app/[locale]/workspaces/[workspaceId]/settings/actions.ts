"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, asOptionalInt, refresh } from "../action-utils";
import {
  createMember,
  markAllNotificationsRead,
  markNotificationRead,
  updateMember,
  resolveAgentRun,
  createWebhookEndpoint,
  updateWebhookEndpoint,
  deleteWebhookEndpoint,
  rotateWebhookSecret,
  createExpertiseTag,
  addMemberExpertise,
  upsertSsoConfig,
  updateModelUsageBudget,
  inviteMember,
  bulkInviteMembers,
  updateMemberInvitePolicy,
  requestMemberInvite,
  approveMemberInviteRequest,
  rejectMemberInviteRequest,
  resendMemberAccessLink,
  disconnectCommunicationInstallation,
  updateSlackAgendaSettings,
  updateMeetingRecorderConfig,
  renderAccountSetupEmail,
  connectMeetingTranscriptSource,
  normalizeMeetingTranscriptSourceProvider,
  retryMeetingTranscriptImportBatch,
  runMeetingTranscriptSourceBackfill,
  deleteOAuthConnection,
  enqueueOAuthConnectionSync,
  requestManagedEnterpriseService,
  createModuleAccessRequest,
  decideModuleAccessRequest,
  type AccountAccessEmailKind,
  type EnterpriseServiceKey,
} from "@corgtex/domain";
import { prisma, sendEmail } from "@corgtex/shared";

async function workspaceNameForEmail(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true },
  });
  return workspace?.name ?? null;
}

async function sendInvitationEmail(email: string, displayName: string | null, token: string, params: {
  workspaceId: string;
  kind?: AccountAccessEmailKind;
}) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const resetUrl = `${appUrl}/setup-account/${encodeURIComponent(token)}`;

  try {
    if (!process.env.RESEND_API_KEY) {
      console.warn("RESEND_API_KEY missing, not sending email");
      return { sent: false, error: "RESEND_API_KEY is not configured on the server." };
    }

    const workspaceName = await workspaceNameForEmail(params.workspaceId);
    await sendEmail({
      to: email,
      subject: `You've been invited to Corgtex`,
      html: renderAccountSetupEmail({
        setupUrl: resetUrl,
        displayName,
        workspaceName,
        kind: params.kind ?? "member-invite",
      }),
    });
    return { sent: true };
  } catch (error: any) {
    console.error("Failed to send invitation email:", error);
    return { sent: false, error: error.message || String(error) };
  }
}

export async function createMemberAction(formData: FormData) {
  try {
    const _demoGuardWsId = formData.get("workspaceId") as string;
    if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

    const actor = await requirePageActor();
    const workspaceId = asString(formData, "workspaceId");
    const result = await createMember(actor, {
      workspaceId,
      email: asString(formData, "email"),
      displayName: asOptional(formData, "displayName"),
      role: asString(formData, "role") as "CONTRIBUTOR" | "FACILITATOR" | "FINANCE_STEWARD" | "ADMIN",
    });
    
    let emailStatus: { sent: boolean; error?: string } | undefined;
    if ((result as any).token) {
      emailStatus = await sendInvitationEmail(result.user.email, result.user.displayName, (result as any).token, {
        workspaceId,
        kind: "admin-added",
      });
    }
    
    refresh(workspaceId);
    return { success: true, emailStatus };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to create member." };
  }
}

export async function requestMemberInviteAction(formData: FormData) {
  try {
    const _demoGuardWsId = formData.get("workspaceId") as string;
    if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

    const actor = await requirePageActor();
    const workspaceId = asString(formData, "workspaceId");
    await requestMemberInvite(actor, {
      workspaceId,
      email: asString(formData, "email"),
      displayName: asOptional(formData, "displayName"),
    });
    refresh(workspaceId);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to request member invite." };
  }
}

export async function inviteMemberAction(formData: FormData) {
  try {
    const _demoGuardWsId = formData.get("workspaceId") as string;
    if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

    const actor = await requirePageActor();
    const workspaceId = asString(formData, "workspaceId");
    const result = await inviteMember(actor, {
      workspaceId,
      email: asString(formData, "email"),
      displayName: asOptional(formData, "displayName"),
    });
    const emailStatus = await sendInvitationEmail(result.user.email, result.user.displayName, result.token, {
      workspaceId,
      kind: "member-invite",
    });
    refresh(workspaceId);
    return { success: true, emailStatus };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to invite member." };
  }
}

export async function bulkInviteAction(formData: FormData) {
  try {
    const _demoGuardWsId = formData.get("workspaceId") as string;
    if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

    const actor = await requirePageActor();
    const workspaceId = asString(formData, "workspaceId");
    const rawCsv = asString(formData, "csvData");
    
    const parsed = rawCsv.split("\n").map(line => {
      const parts = line.split(",").map(p => p.trim());
      return {
        displayName: parts[0] || null,
        email: parts[1] || "",
        role: (parts[2] || "CONTRIBUTOR") as any,
      };
    }).filter(m => m.email);

    const result = await bulkInviteMembers(actor, {
      workspaceId,
      members: parsed,
    });

    let overallEmailStatus: { sent: boolean; error?: string } = { sent: true, error: undefined };
    for (const detail of result.details) {
      const st = await sendInvitationEmail(detail.email, detail.displayName, detail.token, {
        workspaceId,
        kind: "member-invite",
      });
      if (!st.sent) {
        overallEmailStatus.sent = false;
        overallEmailStatus.error = st.error || "Failed to send to one or more members.";
      }
    }

    refresh(workspaceId);
    return { success: true, invitedCount: result.invited, emailStatus: overallEmailStatus };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to bulk invite members." };
  }
}

export async function updateMemberAction(formData: FormData) {
  try {
    const _demoGuardWsId = formData.get("workspaceId") as string;
    if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

    const actor = await requirePageActor();
    const workspaceId = asString(formData, "workspaceId");
    const isActiveRaw = asOptional(formData, "isActive");
    const result = await updateMember(actor, {
      workspaceId,
      memberId: asString(formData, "memberId"),
      role: formData.has("role")
        ? asString(formData, "role") as "CONTRIBUTOR" | "FACILITATOR" | "FINANCE_STEWARD" | "ADMIN"
        : undefined,
      email: formData.has("email") ? asOptional(formData, "email") : undefined,
      displayName: formData.has("displayName") ? asOptional(formData, "displayName") : undefined,
      isActive: isActiveRaw === null ? undefined : isActiveRaw === "true",
    });
    
    let emailStatus: { sent: boolean; error?: string } | undefined;
    if (result.setupToken) {
      emailStatus = await sendInvitationEmail(result.user.email, result.user.displayName, result.setupToken, {
        workspaceId,
        kind: "resend-access",
      });
    }
    
    refresh(workspaceId);
    return { success: true, emailStatus };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to update member." };
  }
}

export async function resendMemberAccessLinkAction(formData: FormData) {
  try {
    const _demoGuardWsId = formData.get("workspaceId") as string;
    if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

    const actor = await requirePageActor();
    const workspaceId = asString(formData, "workspaceId");
    const result = await resendMemberAccessLink(actor, {
      workspaceId,
      memberId: asString(formData, "memberId"),
    });
    const emailStatus = await sendInvitationEmail(result.user.email, result.user.displayName, result.token, {
      workspaceId,
      kind: "resend-access",
    });
    refresh(workspaceId);
    return { success: true, emailStatus };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to resend access link." };
  }
}

export async function updateMemberInvitePolicyAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await updateMemberInvitePolicy(actor, {
    workspaceId,
    policy: asString(formData, "policy") as "ADMINS_ONLY" | "MEMBERS_CAN_INVITE" | "MEMBERS_CAN_REQUEST",
  });
  refresh(workspaceId);
}

export async function approveMemberInviteRequestAction(formData: FormData) {
  try {
    const _demoGuardWsId = formData.get("workspaceId") as string;
    if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

    const actor = await requirePageActor();
    const workspaceId = asString(formData, "workspaceId");
    const result = await approveMemberInviteRequest(actor, {
      workspaceId,
      requestId: asString(formData, "requestId"),
    });
    const emailStatus = await sendInvitationEmail(result.user.email, result.user.displayName, result.token, {
      workspaceId,
      kind: "member-invite",
    });
    refresh(workspaceId);
    return { success: true, emailStatus };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to approve invite request." };
  }
}

export async function rejectMemberInviteRequestAction(formData: FormData) {
  try {
    const _demoGuardWsId = formData.get("workspaceId") as string;
    if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

    const actor = await requirePageActor();
    const workspaceId = asString(formData, "workspaceId");
    await rejectMemberInviteRequest(actor, {
      workspaceId,
      requestId: asString(formData, "requestId"),
    });
    refresh(workspaceId);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to reject invite request." };
  }
}

export async function markAllNotificationsReadAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await markAllNotificationsRead(actor, workspaceId);
  refresh(workspaceId);
}

export async function markNotificationReadAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await markNotificationRead(actor, workspaceId, asString(formData, "notificationId"));
  refresh(workspaceId);
}

export async function disconnectCommunicationInstallationAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await disconnectCommunicationInstallation(actor, asString(formData, "installationId"));
  refresh(workspaceId);
}

export async function updateSlackAgendaSettingsAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await updateSlackAgendaSettings(actor, {
    workspaceId,
    defaultAgendaChannelId: asString(formData, "defaultAgendaChannelId"),
    agendaTimezone: asOptional(formData, "agendaTimezone") || "UTC",
  });
  refresh(workspaceId);
}

export async function updateMeetingRecorderConfigAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const fallbackProvider = asOptional(formData, "fallbackProvider");
  await updateMeetingRecorderConfig(actor, {
    workspaceId,
    enabled: formData.get("enabled") === "true",
    autoRecordEnabled: formData.get("autoRecordEnabled") === "true",
    defaultProvider: asString(formData, "defaultProvider") as "RECALL_AI" | "MEETING_BAAS",
    fallbackProvider: fallbackProvider ? fallbackProvider as "RECALL_AI" | "MEETING_BAAS" : null,
    botName: asString(formData, "botName"),
    entryMessage: asOptional(formData, "entryMessage"),
    monthlyMinuteCap: asOptionalInt(formData, "monthlyMinuteCap") ?? 6000,
  });
  refresh(workspaceId);
}

export async function requestManagedEnterpriseServiceAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await requestManagedEnterpriseService(actor, {
    workspaceId,
    serviceKey: asString(formData, "serviceKey") as EnterpriseServiceKey,
    noteMd: asOptional(formData, "supportNotesMd"),
  });
  refresh(workspaceId);
}

export async function connectMeetingTranscriptSourceAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await connectMeetingTranscriptSource(actor, {
    workspaceId,
    provider: normalizeMeetingTranscriptSourceProvider(asString(formData, "provider")),
    displayName: asOptional(formData, "displayName"),
    apiKey: asOptional(formData, "apiKey"),
    webhookSecret: asOptional(formData, "webhookSecret"),
    webhookUrl: asOptional(formData, "webhookUrl"),
  });
  refresh(workspaceId);
}

export async function runMeetingTranscriptSourceBackfillAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await runMeetingTranscriptSourceBackfill(actor, {
    workspaceId,
    provider: normalizeMeetingTranscriptSourceProvider(asString(formData, "provider")),
  });
  refresh(workspaceId);
}

export async function retryMeetingTranscriptImportBatchAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await retryMeetingTranscriptImportBatch(actor, {
    workspaceId,
    batchId: asString(formData, "batchId"),
  });
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

export async function runOAuthConnectionSyncAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  await enforceDemoGuard(workspaceId);

  const actor = await requirePageActor();
  const kinds = formData.getAll("syncKind")
    .map((value) => String(value))
    .filter((value): value is "calendar" | "documents" | "email" => (
      value === "calendar" || value === "documents" || value === "email"
    ));
  await enqueueOAuthConnectionSync(actor, {
    workspaceId,
    connectionId: asString(formData, "connectionId"),
    kinds,
  });
  refresh(workspaceId);
}

export async function deleteOAuthConnectionAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  await enforceDemoGuard(workspaceId);

  const actor = await requirePageActor();
  await deleteOAuthConnection(actor, {
    workspaceId,
    connectionId: asString(formData, "connectionId"),
  });
  refresh(workspaceId);
}

export async function updateProfileAction(
  workspaceId: string,
  data: { displayName?: string; bio?: string; linkedinUrl?: string; websiteUrl?: string }
) {
  const actor = await requirePageActor();
  const { updateUserProfile } = await import("@corgtex/domain");
  await updateUserProfile(actor, data);
  refresh(workspaceId);
  return { success: true };
}

export async function updateNotificationPrefAction(
  workspaceId: string,
  data: { notifType: string; channel: string }
) {
  const actor = await requirePageActor();
  const { updateNotificationPreference } = await import("@corgtex/domain");
  await updateNotificationPreference(actor, data);
  refresh(workspaceId);
  return { success: true };
}

export async function requestModuleAccessAction(formData: FormData) {
  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await enforceDemoGuard(workspaceId);
  await createModuleAccessRequest(actor, {
    workspaceId,
    moduleKey: asString(formData, "moduleKey"),
    accessLevel: asString(formData, "accessLevel") === "write" ? "write" : "read",
    reasonMd: asString(formData, "reasonMd"),
  });
  refresh(workspaceId);
}

export async function decideModuleAccessRequestAction(formData: FormData) {
  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await enforceDemoGuard(workspaceId);
  await decideModuleAccessRequest(actor, {
    workspaceId,
    requestId: asString(formData, "requestId"),
    status: asString(formData, "status") === "APPROVED" ? "APPROVED" : "REJECTED",
    decisionNoteMd: asOptional(formData, "decisionNoteMd"),
  });
  refresh(workspaceId);
}

export async function updateMemberNewspaperCadenceAction(
  workspaceId: string,
  cadence: "WORKSPACE_DEFAULT" | "DAILY" | "WEEKLY" | "OFF"
) {
  const actor = await requirePageActor();
  const { updateMemberNewspaperCadencePreference } = await import("@corgtex/domain");
  await updateMemberNewspaperCadencePreference(actor, {
    workspaceId,
    cadence: cadence === "WORKSPACE_DEFAULT" ? null : cadence,
  });
  refresh(workspaceId);
  return { success: true };
}
