import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { MemberRole } from "@prisma/client";
import { AppError, invariant } from "./errors";
import { requestPasswordReset } from "./password-reset";
import { createMember } from "./members";
import { requireGlobalOperator } from "./auth";
import { createWorkspace } from "./workspaces";

export async function listAllWorkspaces(actor: AppActor) {
  requireGlobalOperator(actor);
  const workspaces = await prisma.workspace.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: { members: true },
      },
    },
  });
  return workspaces.map(w => ({
    id: w.id,
    slug: w.slug,
    name: w.name,
    createdAt: w.createdAt,
    memberCount: w._count.members,
  }));
}

export async function listAllUsers(actor: AppActor) {
  requireGlobalOperator(actor);
  return prisma.user.findMany({
    orderBy: { email: "asc" },
    include: {
      sessions: {
        orderBy: { createdAt: "desc" },
        take: 1
      },
      memberships: {
        include: {
          workspace: { select: { slug: true, name: true } }
        }
      }
    }
  });
}

export async function adminTriggerPasswordReset(actor: AppActor, email: string) {
  requireGlobalOperator(actor);
  const result = await requestPasswordReset(email);
  if (!result) {
    throw new AppError(404, "NOT_FOUND", "User not found.");
  }
  return result.token;
}

export async function adminAddToWorkspace(actor: AppActor, params: {
  userId: string;
  workspaceId: string;
  role: "CONTRIBUTOR" | "FACILITATOR" | "FINANCE_STEWARD" | "ADMIN";
}) {
  requireGlobalOperator(actor);
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
  });
  if (!user) throw new AppError(404, "NOT_FOUND", "User not found.");

  return createMember(actor, {
    workspaceId: params.workspaceId,
    email: user.email,
    displayName: user.displayName,
    role: params.role,
  });
}

export async function adminRemoveFromWorkspace(actor: AppActor, params: {
  memberId: string;
}) {
  requireGlobalOperator(actor);
  await prisma.member.delete({
    where: { id: params.memberId },
  });
}

export async function getOperatorOverview(actor: AppActor) {
  requireGlobalOperator(actor);
  const workspacesCount = await prisma.workspace.count();
  const usersCount = await prisma.user.count();
  const activeMembersCount = await prisma.member.count({ where: { isActive: true } });
  
  const lastJob = await prisma.workflowJob.findFirst({
    where: { status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
  });
  const pendingJobs = await prisma.workflowJob.count({ where: { status: "PENDING" } });
  const failedJobs = await prisma.workflowJob.count({ where: { status: "FAILED" } });
  
  const workerHealthy = failedJobs < 10;
  
  return {
    workspacesCount,
    usersCount,
    activeMembersCount,
    worker: {
      isHealthy: workerHealthy,
      lastJobAt: lastJob?.createdAt || null,
      pendingJobs,
      failedJobs
    }
  };
}

export async function listAllWorkspacesEnriched(actor: AppActor) {
  requireGlobalOperator(actor);
  const workspaces = await prisma.workspace.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      members: {
        select: { isActive: true, role: true }
      },
      _count: {
        select: {
          members: true,
          workflowJobs: { where: { status: "FAILED" } }
        }
      }
    }
  });

  return workspaces.map(w => {
    const activeMemberCount = w.members.filter(m => m.isActive).length;
    const adminCount = w.members.filter(m => m.role === "ADMIN").length;
    return {
      id: w.id,
      slug: w.slug,
      name: w.name,
      createdAt: w.createdAt,
      memberCount: w._count.members,
      activeMemberCount,
      adminCount,
      failedJobsCount: w._count.workflowJobs,
    };
  });
}

export async function getWorkspaceAdminDetail(actor: AppActor, workspaceId: string) {
  requireGlobalOperator(actor);
  
  const members = await prisma.member.findMany({
    where: { workspaceId },
    include: {
      user: {
        include: {
          sessions: { orderBy: { createdAt: "desc" }, take: 1 }
        }
      }
    }
  });

  const failedJobs = await prisma.workflowJob.findMany({
    where: { workspaceId, status: "FAILED" },
    orderBy: { createdAt: "desc" },
    take: 20
  });

  const commInstallations = await prisma.communicationInstallation.findMany({
    where: { workspaceId },
  });

  return { members, failedJobs, commInstallations };
}

export async function adminCreateMember(actor: AppActor, params: {
  workspaceId: string;
  email: string;
  displayName: string | null;
  role: MemberRole;
}) {
  requireGlobalOperator(actor);
  return createMember(actor, {
    workspaceId: params.workspaceId,
    email: params.email,
    displayName: params.displayName,
    role: params.role,
    skipAdminCheck: true,
  });
}

export async function adminUpdateMember(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
  role: MemberRole;
}) {
  requireGlobalOperator(actor);
  await prisma.member.update({
    where: { id: params.memberId },
    data: { role: params.role }
  });
}

export async function adminDeactivateMember(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
}) {
  requireGlobalOperator(actor);
  await prisma.member.update({
    where: { id: params.memberId },
    data: { isActive: false }
  });
}

export async function adminBulkInvite(actor: AppActor, params: {
  workspaceId: string;
  members: Array<{ email: string; displayName?: string; role: MemberRole }>;
}) {
  requireGlobalOperator(actor);
  for (const m of params.members) {
    await createMember(actor, {
      workspaceId: params.workspaceId,
      email: m.email,
      displayName: m.displayName || null,
      role: m.role,
      skipAdminCheck: true,
    });
  }
}

export async function adminResendAccessLink(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
}) {
  requireGlobalOperator(actor);
  const member = await prisma.member.findUniqueOrThrow({
    where: { id: params.memberId },
    include: { user: true }
  });
  const token = await requestPasswordReset(member.user.email);
  return { user: member.user, token: token?.token };
}

export async function adminCreateWorkspace(actor: AppActor, params: {
  name: string;
  slug: string;
  description: string | null;
}) {
  requireGlobalOperator(actor);
  return createWorkspace(actor, {
    name: params.name,
    slug: params.slug,
  });
}

export async function listExternalInstances(actor: AppActor) {
  requireGlobalOperator(actor);
  return prisma.instanceRegistry.findMany({
    orderBy: { createdAt: "desc" }
  });
}

export async function registerExternalInstance(actor: AppActor, params: {
  label: string;
  url: string;
  environment?: string;
  notes?: string;
}) {
  requireGlobalOperator(actor);
  return prisma.instanceRegistry.create({
    data: {
      label: params.label,
      url: params.url,
      environment: params.environment || "production",
      notes: params.notes,
    }
  });
}

export async function removeExternalInstance(actor: AppActor, id: string) {
  requireGlobalOperator(actor);
  await prisma.instanceRegistry.delete({
    where: { id }
  });
}

export async function probeExternalInstanceHealth(actor: AppActor, id: string) {
  requireGlobalOperator(actor);
  const instance = await prisma.instanceRegistry.findUniqueOrThrow({ where: { id } });
  
  let status = "unknown";
  let error = null;

  try {
    const res = await fetch(`${instance.url}/api/health`, { method: "GET" });
    if (res.ok) {
      status = "ok";
    } else {
      status = "degraded";
      error = `Status ${res.status}`;
    }
  } catch (e: any) {
    status = "down";
    error = e.message;
  }

  await prisma.instanceRegistry.update({
    where: { id },
    data: {
      lastHealthCheck: new Date(),
      lastHealthStatus: status,
      lastHealthError: error,
    }
  });
}
