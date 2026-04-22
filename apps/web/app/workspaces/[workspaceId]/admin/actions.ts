"use server";

import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, refresh } from "../action-utils";
import { adminTriggerPasswordReset, adminAddToWorkspace, adminRemoveFromWorkspace } from "@corgtex/domain";
import { sendEmail, prisma } from "@corgtex/shared";
import { notFound } from "next/navigation";

async function verifyGlobalAdmin(workspaceId: string) {
  const actor = await requirePageActor();
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId }
  });

  if (!workspace || workspace.slug !== "corgtex" || actor.kind !== "user" || actor.user.email !== "janbrezina@icloud.com") {
    notFound();
  }
  return actor;
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
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2>Reset Your Password</h2>
        <p>An administrator has triggered a password reset for your account.</p>
        <div style="margin: 32px 0;">
          <a href="${resetUrl}" style="background-color: #111; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Reset Password</a>
        </div>
      </div>
    `,
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
