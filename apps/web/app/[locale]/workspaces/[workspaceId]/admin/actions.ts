"use server";

import { requirePageActor } from "@/lib/auth";
import { asString, refresh } from "../action-utils";
import { 
  adminTriggerPasswordReset, 
  adminAddToWorkspace, 
  adminRemoveFromWorkspace, 
  isGlobalOperator,
  adminCreateMember,
  adminUpdateMember,
  adminDeactivateMember,
  adminBulkInvite,
  adminResendAccessLink,
  adminCreateWorkspace,
  getWorkspaceAdminDetail,
  renderAccountSetupEmail,
  renderPasswordResetEmail,
  renderPasswordResetEmailText,
} from "@corgtex/domain";
import { sendEmail, prisma } from "@corgtex/shared";
import { notFound } from "next/navigation";
import { discardFailedJob, replayWorkflowJob } from "@corgtex/domain";

async function verifyGlobalAdmin(workspaceId: string) {
  const actor = await requirePageActor();
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId }
  });

  if (!workspace || !isGlobalOperator(actor)) {
    notFound();
  }
  return actor;
}

async function workspaceNameForEmail(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true },
  });
  return workspace?.name ?? null;
}

export async function adminResetPasswordAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);
  const email = asString(formData, "email");
  
  const token = await adminTriggerPasswordReset(actor, email);
  
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const resetUrl = `${appUrl}/reset-password/${token}`;

  await sendEmail({
    to: email,
    subject: `Password Reset Request (Admin Triggered)`,
    html: renderPasswordResetEmail({
      resetUrl,
      kind: "admin-triggered",
    }),
    text: renderPasswordResetEmailText({
      resetUrl,
      kind: "admin-triggered",
    }),
    tracking: {
      emailType: "password_reset",
      metadata: {
        kind: "admin-triggered",
        source: "workspace_admin_reset",
      },
      workspaceId,
    },
  });

  refresh(workspaceId);
}

export async function adminCreateMemberAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);
  const targetWorkspaceId = asString(formData, "targetWorkspaceId");
  const email = asString(formData, "email");
  const displayName = formData.get("displayName") as string | null;
  const role = asString(formData, "role") as any;

  const res = await adminCreateMember(actor, {
    workspaceId: targetWorkspaceId,
    email,
    displayName,
    role,
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  if (res.token) {
    const setupUrl = `${appUrl}/setup-account/${encodeURIComponent(res.token)}`;
    const workspaceName = await workspaceNameForEmail(targetWorkspaceId);
    await sendEmail({
      to: email,
      subject: `You have been added to a Corgtex workspace`,
      html: renderAccountSetupEmail({
        setupUrl,
        displayName,
        workspaceName,
        kind: "admin-added",
      }),
    });
  }

  refresh(workspaceId);
}

export async function adminUpdateMemberAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);
  
  await adminUpdateMember(actor, {
    workspaceId: asString(formData, "targetWorkspaceId"),
    memberId: asString(formData, "memberId"),
    role: asString(formData, "role") as any,
  });

  refresh(workspaceId);
}

export async function adminDeactivateMemberAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);
  
  await adminDeactivateMember(actor, {
    workspaceId: asString(formData, "targetWorkspaceId"),
    memberId: asString(formData, "memberId"),
  });

  refresh(workspaceId);
}

export async function adminBulkInviteAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);
  const membersJson = asString(formData, "members");
  
  try {
    const members = JSON.parse(membersJson);
    await adminBulkInvite(actor, {
      workspaceId: asString(formData, "targetWorkspaceId"),
      members,
    });
  } catch (e) {
    console.error("Bulk invite parsing failed", e);
  }

  refresh(workspaceId);
}

export async function adminResendAccessLinkAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);
  
  const res = await adminResendAccessLink(actor, {
    workspaceId: asString(formData, "targetWorkspaceId"),
    memberId: asString(formData, "memberId"),
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const setupUrl = `${appUrl}/setup-account/${res.token}`;
  const targetWorkspaceId = asString(formData, "targetWorkspaceId");
  const workspaceName = await workspaceNameForEmail(targetWorkspaceId);

  await sendEmail({
    to: res.user.email,
    subject: `Your Corgtex setup link`,
    html: renderAccountSetupEmail({
      setupUrl,
      displayName: res.user.displayName,
      workspaceName,
      kind: "resend-access",
    }),
  });

  refresh(workspaceId);
  // We can't easily return { url } from a server action used in a form. 
  // Let's rely on refresh and client-side code if needed. Actually Server Actions can return values if called directly.
  return { url: setupUrl };
}

export async function adminCreateWorkspaceAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);
  
  await adminCreateWorkspace(actor, {
    name: asString(formData, "name"),
    slug: asString(formData, "slug"),
    description: formData.get("description") as string | null,
  });

  refresh(workspaceId);
}

export async function adminDiscardFailedJobAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);
  
  await discardFailedJob(actor, {
    workspaceId: asString(formData, "targetWorkspaceId"),
    workflowJobId: asString(formData, "jobId"),
  });

  refresh(workspaceId);
}

export async function adminRetryFailedJobAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);
  
  await replayWorkflowJob(actor, {
    workspaceId: asString(formData, "targetWorkspaceId"),
    workflowJobId: asString(formData, "jobId"),
  });

  refresh(workspaceId);
}

export async function adminAddToWorkspaceAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);
  
  await adminAddToWorkspace(actor, {
    userId: asString(formData, "userId"),
    workspaceId: asString(formData, "targetWorkspaceId"),
    role: asString(formData, "role") as any,
  });

  refresh(workspaceId);
}

export async function adminRemoveFromWorkspaceAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);
  
  await adminRemoveFromWorkspace(actor, {
    memberId: asString(formData, "memberId"),
  });

  refresh(workspaceId);
}

export async function adminGetWorkspaceDetailAction(workspaceId: string, targetWorkspaceId: string) {
  const actor = await verifyGlobalAdmin(workspaceId);
  return getWorkspaceAdminDetail(actor, targetWorkspaceId);
}
