import type { MemberRole } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { prisma, hashPassword, randomOpaqueToken, sha256 } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";

export async function listMembers(workspaceId: string) {
  return prisma.member.findMany({
    where: { workspaceId, isActive: true },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
        },
      },
    },
    orderBy: {
      joinedAt: "asc",
    },
  });
}

export async function listMembersEnriched(workspaceId: string, opts?: { includeInactive?: boolean }) {
  return prisma.member.findMany({
    where: {
      workspaceId,
      ...(opts?.includeInactive ? {} : { isActive: true }),
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
        },
      },
      roleAssignments: {
        include: {
          role: {
            include: {
              circle: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
      },
    },
    orderBy: {
      joinedAt: "asc",
    },
  });
}

export async function bulkInviteMembers(actor: AppActor, params: {
  workspaceId: string;
  members: { email: string; displayName?: string | null; role?: MemberRole }[];
}): Promise<{ invited: number; details: { email: string; displayName: string | null; token: string }[]; errors: string[] }> {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  let invited = 0;
  const errors: string[] = [];
  const details: { email: string; displayName: string | null; token: string }[] = [];

  for (const info of params.members) {
    try {
      const result = await createMember(actor, {
        workspaceId: params.workspaceId,
        email: info.email,
        displayName: info.displayName,
        role: info.role || "CONTRIBUTOR",
      });
      invited++;
      details.push({
        email: result.user.email,
        displayName: result.user.displayName,
        token: result.token,
      });
    } catch (e: any) {
      errors.push(`Failed for ${info.email}: ${e.message}`);
    }
  }

  return { invited, details, errors };
}

export async function createMember(actor: AppActor, params: {
  workspaceId: string;
  email: string;
  displayName?: string | null;
  role: MemberRole;
  skipAdminCheck?: boolean;
}) {
  if (!params.skipAdminCheck) {
    await requireWorkspaceMembership({
      actor,
      workspaceId: params.workspaceId,
      allowedRoles: ["ADMIN"],
    });
  }

  const email = params.email.trim().toLowerCase();
  invariant(email.length > 0, 400, "INVALID_INPUT", "Email is required.");

  return prisma.$transaction(async (tx) => {
    const randomPassword = randomOpaqueToken();
    const user = await tx.user.upsert({
      where: { email },
      update: {
        displayName: params.displayName?.trim() || undefined,
      },
      create: {
        email,
        displayName: params.displayName?.trim() || null,
        passwordHash: hashPassword(randomPassword),
      },
      select: {
        id: true,
        email: true,
        displayName: true,
      },
    });

    const member = await tx.member.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: params.workspaceId,
          userId: user.id,
        },
      },
      update: {
        role: params.role,
        isActive: true,
      },
      create: {
        workspaceId: params.workspaceId,
        userId: user.id,
        role: params.role,
        isActive: true,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "member.created",
        entityType: "Member",
        entityId: member.id,
        meta: {
          email,
          role: params.role,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "member.created",
        aggregateType: "Member",
        aggregateId: member.id,
        payload: {
          memberId: member.id,
          userId: user.id,
          role: member.role,
        },
      },
    ]);

    const token = randomOpaqueToken();
    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return { user, member, token };
  });
}

export async function inviteMember(actor: AppActor, params: {
  workspaceId: string;
  email: string;
  displayName?: string | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return createMember(actor, {
    ...params,
    role: "CONTRIBUTOR",
    skipAdminCheck: true,
  });
}

export async function updateMember(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
  role?: MemberRole;
  isActive?: boolean;
  displayName?: string | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUnique({
      where: { id: params.memberId },
    });

    invariant(member && member.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Member not found.");

    const memberData: Record<string, unknown> = {};
    if (params.role !== undefined) memberData.role = params.role;
    if (params.isActive !== undefined) memberData.isActive = params.isActive;

    const updated = await tx.member.update({
      where: { id: params.memberId },
      data: memberData,
      include: { user: { select: { id: true, email: true, displayName: true } } },
    });

    if (params.displayName !== undefined) {
      await tx.user.update({
        where: { id: member.userId },
        data: { displayName: params.displayName?.trim() || null },
      });
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "member.updated",
        entityType: "Member",
        entityId: updated.id,
        meta: { fields: [...Object.keys(memberData), ...(params.displayName !== undefined ? ["displayName"] : [])] },
      },
    });

    return updated;
  });
}

export async function deactivateMember(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUnique({
      where: { id: params.memberId },
    });

    invariant(member && member.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Member not found.");
    invariant(member.isActive, 400, "INVALID_STATE", "Member is already deactivated.");

    const updated = await tx.member.update({
      where: { id: params.memberId },
      data: { isActive: false },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "member.deactivated",
        entityType: "Member",
        entityId: updated.id,
        meta: {},
      },
    });

    return updated;
  });
}

export async function getMemberProfile(workspaceId: string, memberId: string) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
        },
      },
      roleAssignments: {
        include: {
          role: {
            include: {
              circle: {
                select: { id: true, name: true, maturityStage: true },
              },
            },
          },
        },
      },
      assignedActions: {
        where: { status: "OPEN" },
        take: 5,
        orderBy: { createdAt: "desc" },
      },
      assignedTensions: {
        where: { status: { in: ["OPEN", "IN_PROGRESS"] } },
        take: 5,
        orderBy: { createdAt: "desc" },
      },
    },
  });

  invariant(member && member.workspaceId === workspaceId, 404, "NOT_FOUND", "Member not found.");

  const meetings = await prisma.meeting.findMany({
    where: {
      workspaceId,
      participantIds: {
        has: member.user.id,
      },
    },
    orderBy: { recordedAt: "desc" },
    take: 5,
  });

  const recentActivity = await prisma.auditLog.findMany({
    where: {
      workspaceId,
      actorUserId: member.user.id,
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const proposals = await prisma.proposal.findMany({
    where: {
      workspaceId,
      authorUserId: member.user.id,
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  const authoredTensions = await prisma.tension.findMany({
    where: {
      workspaceId,
      authorUserId: member.user.id,
      status: { in: ["OPEN", "IN_PROGRESS"] },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  return {
    member,
    meetings,
    recentActivity,
    proposals,
    authoredTensions,
  };
}
