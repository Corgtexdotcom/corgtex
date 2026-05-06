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
  registerCustomerDeploymentRecord,
  provisionCustomerDeployment,
  removeCustomerDeployment,
  probeCustomerDeploymentHealth,
  suspendCustomerDeployment,
  triggerCustomerDeploymentBootstrap,
  upgradeCustomerDeploymentRelease,
  getWorkspaceAdminDetail,
  type RailwayRuntimeServiceSource
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

function optionalString(formData: FormData, name: string) {
  const value = formData.get(name);
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function looksLikeGitSha(value: string) {
  return /^[a-f0-9]{7,40}$/i.test(value.trim());
}

function serviceSourceFromForm(
  formData: FormData,
  prefix: "web" | "worker",
  releaseImageTag: string,
): RailwayRuntimeServiceSource | null {
  const repo = optionalString(formData, `${prefix}Repo`);
  if (!repo) {
    return null;
  }
  const commitSha = optionalString(formData, `${prefix}CommitSha`)
    ?? (looksLikeGitSha(releaseImageTag) ? releaseImageTag.trim() : null);

  return {
    repo,
    branch: optionalString(formData, `${prefix}Branch`),
    commitSha,
    rootDirectory: optionalString(formData, `${prefix}RootDirectory`),
    dockerfilePath: optionalString(formData, `${prefix}DockerfilePath`),
    startCommand: optionalString(formData, `${prefix}StartCommand`),
  };
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
  const setupUrl = res.token ? `${appUrl}/setup-account/${res.token}` : null;

  if (res.token) {
    await sendEmail({
      to: email,
      subject: `You have been added to a Corgtex workspace`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2>Welcome to Corgtex</h2>
          <p>An administrator has added you to a workspace. Please set up your account.</p>
          <div style="margin: 32px 0;">
            <a href="${setupUrl}" style="background-color: #111; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Set up account</a>
          </div>
        </div>
      `,
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

  await sendEmail({
    to: res.user.email,
    subject: `Your Corgtex setup link`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2>Set up your Corgtex account</h2>
        <p>An administrator requested a new setup link for your account.</p>
        <div style="margin: 32px 0;">
          <a href="${setupUrl}" style="background-color: #111; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none;">Set up account</a>
        </div>
      </div>
    `,
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

export async function adminRegisterCustomerDeploymentAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);
  
  await registerCustomerDeploymentRecord(actor, {
    url: asString(formData, "url"),
    label: asString(formData, "label"),
    environment: formData.get("environment") as string | undefined,
    notes: formData.get("notes") as string | undefined,
    customerSlug: formData.get("customerSlug") as string | undefined,
    region: formData.get("region") as string | undefined,
    dataResidency: formData.get("dataResidency") as string | undefined,
    customDomain: formData.get("customDomain") as string | undefined,
    supportOwnerEmail: formData.get("supportOwnerEmail") as string | undefined,
    releaseVersion: formData.get("releaseVersion") as string | undefined,
    releaseImageTag: formData.get("releaseImageTag") as string | undefined,
    storageBucketName: formData.get("storageBucketName") as string | undefined,
    bootstrapBundleUri: formData.get("bootstrapBundleUri") as string | undefined,
    bootstrapBundleChecksum: formData.get("bootstrapBundleChecksum") as string | undefined,
    bootstrapBundleSchemaVersion: formData.get("bootstrapBundleSchemaVersion") as string | undefined,
  });

  refresh(workspaceId);
}

export async function adminProvisionCustomerDeploymentAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);
  const webImage = optionalString(formData, "webImage");
  const workerImage = optionalString(formData, "workerImage");
  const releaseImageTag = asString(formData, "releaseImageTag");

  await provisionCustomerDeployment(actor, {
    label: asString(formData, "label"),
    customerSlug: asString(formData, "customerSlug"),
    region: asString(formData, "region"),
    dataResidency: asString(formData, "dataResidency"),
    customDomain: formData.get("customDomain") as string | null,
    supportOwnerEmail: formData.get("supportOwnerEmail") as string | null,
    releaseVersion: formData.get("releaseVersion") as string | null,
    releaseImageTag,
    webImage,
    workerImage,
    webSource: webImage ? null : serviceSourceFromForm(formData, "web", releaseImageTag),
    workerSource: workerImage ? null : serviceSourceFromForm(formData, "worker", releaseImageTag),
    storageBucketName: formData.get("storageBucketName") as string | null,
    bootstrapBundleUri: formData.get("bootstrapBundleUri") as string | null,
    bootstrapBundleChecksum: formData.get("bootstrapBundleChecksum") as string | null,
    bootstrapBundleSchemaVersion: formData.get("bootstrapBundleSchemaVersion") as string | null,
  });

  refresh(workspaceId);
}

export async function adminRemoveCustomerDeploymentAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);
  
  await removeCustomerDeployment(actor, asString(formData, "deploymentId"));

  refresh(workspaceId);
}

export async function adminProbeCustomerDeploymentHealthAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);
  
  await probeCustomerDeploymentHealth(actor, asString(formData, "deploymentId"));

  refresh(workspaceId);
}

export async function adminSuspendCustomerDeploymentAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);

  await suspendCustomerDeployment(actor, asString(formData, "deploymentId"));

  refresh(workspaceId);
}

export async function adminUpgradeCustomerDeploymentAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);
  const webImage = optionalString(formData, "webImage");
  const workerImage = optionalString(formData, "workerImage");
  const releaseImageTag = asString(formData, "releaseImageTag");

  await upgradeCustomerDeploymentRelease(actor, {
    deploymentId: asString(formData, "deploymentId"),
    releaseVersion: formData.get("releaseVersion") as string | null,
    releaseImageTag,
    webImage,
    workerImage,
    webSource: webImage ? null : serviceSourceFromForm(formData, "web", releaseImageTag),
    workerSource: workerImage ? null : serviceSourceFromForm(formData, "worker", releaseImageTag),
  });

  refresh(workspaceId);
}

export async function adminTriggerBootstrapAction(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  const actor = await verifyGlobalAdmin(workspaceId);

  await triggerCustomerDeploymentBootstrap(actor, {
    deploymentId: asString(formData, "deploymentId"),
    token: asString(formData, "bootstrapToken"),
    expiresAt: new Date(asString(formData, "expiresAt")),
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
