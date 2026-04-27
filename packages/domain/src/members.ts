import type { MemberInviteRequestStatus, MemberRole } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { prisma, hashPassword, randomOpaqueToken, sha256 } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { appendEvents } from "./events";
import { isGlobalOperator, requireWorkspaceMembership } from "./auth";

export type MemberInvitePolicy = "ADMINS_ONLY" | "MEMBERS_CAN_INVITE" | "MEMBERS_CAN_REQUEST";

const MEMBER_INVITE_SETTINGS_FLAG = "MEMBER_INVITES";
const SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeDisplayName(displayName?: string | null) {
  return displayName?.trim() || null;
}

function parseInvitePolicy(config: unknown): MemberInvitePolicy {
  if (
    config &&
    typeof config === "object" &&
    "policy" in config &&
    (config as { policy?: unknown }).policy === "MEMBERS_CAN_INVITE"
  ) {
    return "MEMBERS_CAN_INVITE";
  }
  if (
    config &&
    typeof config === "object" &&
    "policy" in config &&
    (config as { policy?: unknown }).policy === "MEMBERS_CAN_REQUEST"
  ) {
    return "MEMBERS_CAN_REQUEST";
  }
  return "ADMINS_ONLY";
}

async function issueSetupToken(tx: any, userId: string) {
  await tx.passwordResetToken.updateMany({
    where: {
      userId,
      usedAt: null,
    },
    data: {
      usedAt: new Date(),
    },
  });

  const token = randomOpaqueToken();
  await tx.passwordResetToken.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + SETUP_TOKEN_TTL_MS),
    },
  });
  return token;
}

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

export async function getMemberInvitePolicy(workspaceId: string): Promise<MemberInvitePolicy> {
  const settings = await prisma.workspaceFeatureFlag.findUnique({
    where: {
      workspaceId_flag: {
        workspaceId,
        flag: MEMBER_INVITE_SETTINGS_FLAG,
      },
    },
    select: {
      config: true,
    },
  });

  return parseInvitePolicy(settings?.config);
}

export async function updateMemberInvitePolicy(actor: AppActor, params: {
  workspaceId: string;
  policy: MemberInvitePolicy;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  return prisma.workspaceFeatureFlag.upsert({
    where: {
      workspaceId_flag: {
        workspaceId: params.workspaceId,
        flag: MEMBER_INVITE_SETTINGS_FLAG,
      },
    },
    update: {
      enabled: true,
      config: { policy: params.policy },
    },
    create: {
      workspaceId: params.workspaceId,
      flag: MEMBER_INVITE_SETTINGS_FLAG,
      enabled: true,
      config: { policy: params.policy },
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

  const email = normalizeEmail(params.email);
  invariant(email.length > 0, 400, "INVALID_INPUT", "Email is required.");

  return prisma.$transaction(async (tx) => {
    const randomPassword = randomOpaqueToken();
    const user = await tx.user.upsert({
      where: { email },
      update: {
        displayName: normalizeDisplayName(params.displayName) || undefined,
      },
      create: {
        email,
        displayName: normalizeDisplayName(params.displayName),
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

    const token = await issueSetupToken(tx, user.id);

    return { user, member, token };
  });
}

export async function inviteMember(actor: AppActor, params: {
  workspaceId: string;
  email: string;
  displayName?: string | null;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  invariant(membership, 403, "FORBIDDEN", "Only workspace members can invite members.");

  if (membership?.role !== "ADMIN") {
    const policy = await getMemberInvitePolicy(params.workspaceId);
    if (policy !== "MEMBERS_CAN_INVITE") {
      throw new AppError(403, "FORBIDDEN", "Only admins can invite members in this workspace.");
    }
  }

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
  email?: string | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUnique({
      where: { id: params.memberId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            ssoIdentities: { select: { id: true } },
            _count: { select: { memberships: true } },
          },
        },
      },
    });

    invariant(member && member.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Member not found.");

    const memberData: Record<string, unknown> = {};
    if (params.role !== undefined) memberData.role = params.role;
    if (params.isActive !== undefined) memberData.isActive = params.isActive;
    if (params.isActive === false && !member.isActive) {
      throw new AppError(400, "INVALID_STATE", "Member is already deactivated.");
    }

    const nextRole = params.role ?? member.role;
    const nextActive = params.isActive ?? member.isActive;
    if (member.role === "ADMIN" && member.isActive && (nextRole !== "ADMIN" || !nextActive)) {
      const otherAdminCount = await tx.member.count({
        where: {
          workspaceId: params.workspaceId,
          role: "ADMIN",
          isActive: true,
          id: { not: member.id },
        },
      });
      invariant(otherAdminCount > 0, 400, "LAST_ADMIN", "Workspace must keep at least one active admin.");
    }

    const normalizedEmail = params.email !== undefined && params.email !== null
      ? normalizeEmail(params.email)
      : undefined;
    if (normalizedEmail !== undefined) {
      invariant(normalizedEmail.length > 0, 400, "INVALID_INPUT", "Email is required.");
    }

    const emailChanged = normalizedEmail !== undefined && normalizedEmail !== member.user.email;
    if (emailChanged) {
      const existingUser = await tx.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true },
      });
      invariant(!existingUser || existingUser.id === member.userId, 409, "ALREADY_EXISTS", "A user with that email already exists.");

      if (!isGlobalOperator(actor)) {
        invariant(
          member.user._count.memberships === 1,
          400,
          "SHARED_ACCOUNT",
          "This user belongs to multiple workspaces. A platform operator must change their email.",
        );
        invariant(
          member.user.ssoIdentities.length === 0,
          400,
          "SSO_ACCOUNT",
          "This user signs in with SSO. A platform operator must change their email.",
        );
      }
    }

    const userData: Record<string, unknown> = {};
    const nextDisplayName = params.displayName !== undefined ? normalizeDisplayName(params.displayName) : undefined;
    if (params.displayName !== undefined) {
      userData.displayName = nextDisplayName;
    }
    if (emailChanged) {
      userData.email = normalizedEmail;
    }

    if (Object.keys(userData).length > 0) {
      await tx.user.update({
        where: { id: member.userId },
        data: userData,
      });
    }

    if (emailChanged) {
      await tx.session.deleteMany({ where: { userId: member.userId } });
    }

    const updated = Object.keys(memberData).length > 0
      ? await tx.member.update({
        where: { id: params.memberId },
        data: memberData,
        include: { user: { select: { id: true, email: true, displayName: true } } },
      })
      : await tx.member.findUnique({
        where: { id: params.memberId },
        include: { user: { select: { id: true, email: true, displayName: true } } },
      });
    invariant(updated, 404, "NOT_FOUND", "Member not found.");

    const setupToken = emailChanged ? await issueSetupToken(tx, member.userId) : undefined;
    const fields = [
      ...Object.keys(memberData),
      ...(params.displayName !== undefined ? ["displayName"] : []),
      ...(emailChanged ? ["email"] : []),
    ];
    const action = params.isActive === false
      ? "member.deactivated"
      : params.isActive === true && !member.isActive
        ? "member.reactivated"
        : "member.updated";

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action,
        entityType: "Member",
        entityId: updated.id,
        meta: {
          fields,
          ...(emailChanged ? { oldEmail: member.user.email, newEmail: normalizedEmail } : {}),
          ...(params.displayName !== undefined ? { oldDisplayName: member.user.displayName, newDisplayName: nextDisplayName } : {}),
        },
      },
    });

    return { ...updated, setupToken };
  });
}

export async function deactivateMember(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
}) {
  return updateMember(actor, { ...params, isActive: false });
}

export async function resendMemberAccessLink(actor: AppActor, params: {
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
      include: { user: { select: { id: true, email: true, displayName: true } } },
    });
    invariant(member && member.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Member not found.");

    const token = await issueSetupToken(tx, member.userId);
    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "member.access_link.created",
        entityType: "Member",
        entityId: member.id,
        meta: { email: member.user.email },
      },
    });

    return { user: member.user, member, token };
  });
}

export async function requestMemberInvite(actor: AppActor, params: {
  workspaceId: string;
  email: string;
  displayName?: string | null;
}) {
  const requesterMembership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  invariant(requesterMembership, 403, "FORBIDDEN", "Only workspace members can request invites.");

  if (requesterMembership.role === "ADMIN") {
    throw new AppError(400, "INVALID_STATE", "Admins can invite members directly.");
  }

  const policy = await getMemberInvitePolicy(params.workspaceId);
  if (policy !== "MEMBERS_CAN_REQUEST") {
    throw new AppError(403, "FORBIDDEN", "Invite requests are not enabled for this workspace.");
  }

  const email = normalizeEmail(params.email);
  invariant(email.length > 0, 400, "INVALID_INPUT", "Email is required.");

  const [existingActiveMember, existingPendingRequest] = await Promise.all([
    prisma.member.findFirst({
      where: {
        workspaceId: params.workspaceId,
        isActive: true,
        user: { email },
      },
      select: { id: true },
    }),
    prisma.memberInviteRequest.findFirst({
      where: {
        workspaceId: params.workspaceId,
        email,
        status: "PENDING",
      },
      select: { id: true },
    }),
  ]);
  invariant(!existingActiveMember, 409, "ALREADY_EXISTS", "That email is already an active member.");
  invariant(!existingPendingRequest, 409, "ALREADY_EXISTS", "There is already a pending invite request for that email.");

  return prisma.memberInviteRequest.create({
    data: {
      workspaceId: params.workspaceId,
      requesterMemberId: requesterMembership.id,
      email,
      displayName: normalizeDisplayName(params.displayName),
    },
  });
}

export async function listMemberInviteRequests(actor: AppActor, params: {
  workspaceId: string;
  status?: MemberInviteRequestStatus;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  return prisma.memberInviteRequest.findMany({
    where: {
      workspaceId: params.workspaceId,
      ...(params.status ? { status: params.status } : {}),
    },
    include: {
      requesterMember: { include: { user: { select: { email: true, displayName: true } } } },
      deciderMember: { include: { user: { select: { email: true, displayName: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function approveMemberInviteRequest(actor: AppActor, params: {
  workspaceId: string;
  requestId: string;
}) {
  const deciderMembership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  const request = await prisma.memberInviteRequest.findUnique({
    where: { id: params.requestId },
  });
  invariant(request && request.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Invite request not found.");
  invariant(request.status === "PENDING", 400, "INVALID_STATE", "Invite request is already decided.");

  const result = await createMember(actor, {
    workspaceId: params.workspaceId,
    email: request.email,
    displayName: request.displayName,
    role: "CONTRIBUTOR",
  });

  await prisma.memberInviteRequest.update({
    where: { id: params.requestId },
    data: {
      status: "APPROVED",
      deciderMemberId: deciderMembership?.id === "global-operator" ? null : deciderMembership?.id ?? null,
      decidedAt: new Date(),
    },
  });

  return result;
}

export async function rejectMemberInviteRequest(actor: AppActor, params: {
  workspaceId: string;
  requestId: string;
}) {
  const deciderMembership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  const request = await prisma.memberInviteRequest.findUnique({
    where: { id: params.requestId },
  });
  invariant(request && request.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Invite request not found.");
  invariant(request.status === "PENDING", 400, "INVALID_STATE", "Invite request is already decided.");

  return prisma.memberInviteRequest.update({
    where: { id: params.requestId },
    data: {
      status: "REJECTED",
      deciderMemberId: deciderMembership?.id === "global-operator" ? null : deciderMembership?.id ?? null,
      decidedAt: new Date(),
    },
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
        where: { status: "OPEN" },
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
      status: "OPEN",
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
