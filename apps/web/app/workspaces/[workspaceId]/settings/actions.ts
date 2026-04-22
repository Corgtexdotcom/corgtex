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
  updateModelUsageBudget,
  inviteMember,
  bulkInviteMembers
} from "@corgtex/domain";
import { sendEmail } from "@corgtex/shared";

async function sendInvitationEmail(email: string, displayName: string | null, token: string) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const resetUrl = `${appUrl}/setup-account/${token}`;

  try {
    await sendEmail({
      to: email,
      subject: `You've been invited to Corgtex`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2>Join Corgtex</h2>
          <p>Hi ${displayName || 'there'},</p>
          <p>You have been invited to join a workspace on Corgtex.</p>
          <div style="margin: 32px 0;">
            <a href="${resetUrl}" style="background-color: #111; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">Set up your account</a>
          </div>
        </div>
      `,
    });
  } catch (error) {
    console.error("Failed to send invitation email:", error);
  }
}

export async function createMemberAction(formData: FormData) {
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
  
  if ((result as any).token) {
    await sendInvitationEmail(result.user.email, result.user.displayName, (result as any).token);
  }
  
  refresh(workspaceId);
}

export async function inviteMemberAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const result = await inviteMember(actor, {
    workspaceId,
    email: asString(formData, "email"),
    displayName: asOptional(formData, "displayName"),
  });
  await sendInvitationEmail(result.user.email, result.user.displayName, result.token);
  refresh(workspaceId);
}

export async function bulkInviteAction(formData: FormData) {
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

  for (const detail of result.details) {
    await sendInvitationEmail(detail.email, detail.displayName, detail.token);
  }

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
