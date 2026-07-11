import { Prisma, type RoleOnboardingStatus } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { activeRoleAssignmentWhere, isRoleAssignmentActive } from "./role-assignment-activity";

const ACTIVE_ONBOARDING_STATUSES: RoleOnboardingStatus[] = ["PENDING", "ACTIVE"];
const ONBOARDING_START_MESSAGE = "Start my role onboarding.";

type RoleSnapshotInput = {
  id: string;
  circleId: string;
  name: string;
  purposeMd: string | null;
  accountabilities: string[];
  artifacts: string[];
  metricsMd: string | null;
  coreRoleType: string | null;
};

type RoleForOnboarding = RoleSnapshotInput & {
  circle: {
    id: string;
    name: string;
    purposeMd?: string | null;
    domainMd?: string | null;
  };
};

type MemberForOnboarding = {
  id: string;
  userId: string;
  user?: {
    displayName?: string | null;
    email?: string | null;
  } | null;
};

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

export async function createRoleVersionSnapshot(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    role: RoleSnapshotInput;
    changeType: "created" | "updated";
    actor: AppActor;
  },
) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext('role_version'), hashtext(${params.role.id}))
  `;
  const latestVersion = await tx.roleVersion.aggregate({
    where: { roleId: params.role.id },
    _max: { version: true },
  });
  const version = (latestVersion._max.version ?? 0) + 1;

  return tx.roleVersion.create({
    data: {
      workspaceId: params.workspaceId,
      roleId: params.role.id,
      circleId: params.role.circleId,
      version,
      name: params.role.name,
      purposeMd: params.role.purposeMd,
      accountabilities: params.role.accountabilities,
      artifacts: params.role.artifacts,
      metricsMd: params.role.metricsMd,
      coreRoleType: params.role.coreRoleType,
      changeType: params.changeType,
      changedByUserId: actorUserId(params.actor),
    },
  });
}

export async function startRoleHolderHistory(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    roleId: string;
    memberId?: string | null;
    agentIdentityId?: string | null;
    assignmentId?: string | null;
    actor: AppActor;
  },
) {
  const holderKind = params.memberId ? "MEMBER" : "AGENT";
  await tx.roleHolderHistory.create({
    data: {
      workspaceId: params.workspaceId,
      roleId: params.roleId,
      holderKind,
      memberId: params.memberId ?? null,
      agentIdentityId: params.agentIdentityId ?? null,
      assignmentId: params.assignmentId ?? null,
      startedByUserId: actorUserId(params.actor),
    },
  });
}

export async function endRoleHolderHistory(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    roleId: string;
    memberId?: string | null;
    agentIdentityId?: string | null;
    actor: AppActor;
  },
) {
  await tx.roleHolderHistory.updateMany({
    where: {
      workspaceId: params.workspaceId,
      roleId: params.roleId,
      memberId: params.memberId ?? null,
      agentIdentityId: params.agentIdentityId ?? null,
      endedAt: null,
    },
    data: {
      endedAt: new Date(),
      endedByUserId: actorUserId(params.actor),
    },
  });
}

export async function ensureRoleOnboardingForAssignment(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    role: RoleForOnboarding;
    member: MemberForOnboarding;
  },
) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext('role_onboarding'), hashtext(${`${params.role.id}:${params.member.id}`}))
  `;
  const existing = await tx.roleOnboardingSession.findFirst({
    where: {
      workspaceId: params.workspaceId,
      roleId: params.role.id,
      memberId: params.member.id,
      status: { in: ACTIVE_ONBOARDING_STATUSES },
    },
    include: { conversation: true },
  });
  if (existing) {
    return { ...existing, wasCreated: false };
  }

  const assigneeName = params.member.user?.displayName ?? params.member.user?.email ?? "New role holder";
  const conversation = await tx.conversationSession.create({
    data: {
      workspaceId: params.workspaceId,
      userId: params.member.userId,
      agentKey: "role-onboarding",
      topic: `Onboarding: ${params.role.name}`,
      systemPrompt: null,
    },
  });

  const session = await tx.roleOnboardingSession.create({
    data: {
      workspaceId: params.workspaceId,
      roleId: params.role.id,
      memberId: params.member.id,
      conversationId: conversation.id,
    },
    include: { conversation: true },
  });

  await tx.notification.create({
    data: {
      workspaceId: params.workspaceId,
      userId: params.member.userId,
      type: "role-onboarding.assigned",
      entityType: "ConversationSession",
      entityId: conversation.id,
      title: `Role onboarding: ${params.role.name}`,
      bodyMd: `${assigneeName}, your guided onboarding chat for **${params.role.name}** is ready.`,
    },
  });

  return { ...session, wasCreated: true };
}

export async function dismissRoleOnboardingForAssignment(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    roleId: string;
    memberId: string;
  },
) {
  await tx.roleOnboardingSession.updateMany({
    where: {
      workspaceId: params.workspaceId,
      roleId: params.roleId,
      memberId: params.memberId,
      status: { in: ACTIVE_ONBOARDING_STATUSES },
    },
    data: {
      status: "DISMISSED",
      dismissedAt: new Date(),
    },
  });
}

export async function closeRoleLifecycleForRoles(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    roleIds: string[];
    actor: AppActor;
    now?: Date;
  },
) {
  if (params.roleIds.length === 0) return;
  const now = params.now ?? new Date();

  await tx.roleHolderHistory.updateMany({
    where: {
      workspaceId: params.workspaceId,
      roleId: { in: params.roleIds },
      endedAt: null,
    },
    data: {
      endedAt: now,
      endedByUserId: actorUserId(params.actor),
    },
  });

  await tx.roleOnboardingSession.updateMany({
    where: {
      workspaceId: params.workspaceId,
      roleId: { in: params.roleIds },
      status: { in: ACTIVE_ONBOARDING_STATUSES },
    },
    data: {
      status: "DISMISSED",
      dismissedAt: now,
    },
  });

  await tx.roleAssignment.deleteMany({
    where: { roleId: { in: params.roleIds } },
  });

  await tx.circleAgentAssignment.updateMany({
    where: { roleId: { in: params.roleIds } },
    data: { roleId: null },
  });
}

export async function closeRoleLifecycleForMember(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    memberId: string;
    actor: AppActor;
    now?: Date;
  },
) {
  const now = params.now ?? new Date();

  await tx.roleHolderHistory.updateMany({
    where: {
      workspaceId: params.workspaceId,
      memberId: params.memberId,
      endedAt: null,
    },
    data: {
      endedAt: now,
      endedByUserId: actorUserId(params.actor),
    },
  });

  await tx.roleOnboardingSession.updateMany({
    where: {
      workspaceId: params.workspaceId,
      memberId: params.memberId,
      status: { in: ACTIVE_ONBOARDING_STATUSES },
    },
    data: {
      status: "DISMISSED",
      dismissedAt: now,
    },
  });

  await tx.roleAssignment.deleteMany({
    where: {
      memberId: params.memberId,
      role: { circle: { workspaceId: params.workspaceId } },
    },
  });
}

export async function closeRoleLifecycleForAgent(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    agentIdentityId: string;
    actor: AppActor;
    now?: Date;
  },
) {
  const now = params.now ?? new Date();

  await tx.roleHolderHistory.updateMany({
    where: {
      workspaceId: params.workspaceId,
      agentIdentityId: params.agentIdentityId,
      endedAt: null,
    },
    data: {
      endedAt: now,
      endedByUserId: actorUserId(params.actor),
    },
  });

  await tx.circleAgentAssignment.updateMany({
    where: {
      agentIdentityId: params.agentIdentityId,
      circle: { workspaceId: params.workspaceId },
      roleId: { not: null },
    },
    data: { roleId: null },
  });
}

export async function closeRoleLifecycleForCircleTree(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    circleId: string;
    actor: AppActor;
    now?: Date;
  },
) {
  const roles = await tx.role.findMany({
    where: {
      circleId: params.circleId,
      archivedAt: null,
    },
    select: { id: true },
  });

  await closeRoleLifecycleForRoles(tx, {
    workspaceId: params.workspaceId,
    roleIds: roles.map((role) => role.id),
    actor: params.actor,
    now: params.now,
  });
}

function listBlock(title: string, items: string[]) {
  if (items.length === 0) return `## ${title}\nNo current records found.`;
  return `## ${title}\n${items.map((item) => `- ${item}`).join("\n")}`;
}

async function loadRoleOnboardingContext(params: {
  workspaceId: string;
  conversationId: string;
  userId: string;
}) {
  const session = await prisma.roleOnboardingSession.findFirst({
    where: {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      conversation: { userId: params.userId },
    },
    include: {
      role: {
        include: {
          circle: {
            select: {
              id: true,
              name: true,
              purposeMd: true,
              domainMd: true,
            },
          },
          assignments: {
            where: activeRoleAssignmentWhere(),
            include: {
              member: {
                include: {
                  user: {
                    select: { displayName: true, email: true },
                  },
                },
              },
            },
            orderBy: { assignedAt: "desc" },
          },
          agentAssignments: {
            include: {
              agentIdentity: {
                select: { displayName: true, memberType: true },
              },
            },
            orderBy: { assignedAt: "desc" },
          },
          versions: {
            orderBy: { createdAt: "desc" },
            take: 3,
          },
        },
      },
      member: {
        include: {
          user: {
            select: { displayName: true, email: true, bio: true },
          },
        },
      },
    },
  });

  if (!session) return null;

  const privateDraftVisibility = session.member.role === "ADMIN"
    ? [
      { isPrivate: false },
      { isPrivate: true, status: "DRAFT" as const },
    ]
    : [
      { isPrivate: false },
      { isPrivate: true, status: "DRAFT" as const, authorUserId: params.userId },
    ];

  const [policies, actions, tensions, proposals, meetings] = await Promise.all([
    prisma.policyCorpus.findMany({
      where: {
        workspaceId: params.workspaceId,
        OR: [
          { circleId: null },
          { circleId: session.role.circleId },
        ],
      },
      select: { title: true, bodyMd: true, acceptedAt: true },
      orderBy: { acceptedAt: "desc" },
      take: 5,
    }),
    prisma.action.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        status: { not: "COMPLETED" },
        AND: [
          { OR: privateDraftVisibility },
          {
            OR: [
              { assigneeMemberId: session.memberId },
              { circleId: session.role.circleId },
            ],
          },
        ],
      },
      select: { title: true, status: true, dueAt: true },
      orderBy: { updatedAt: "desc" },
      take: 8,
    }),
    prisma.tension.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        status: "OPEN",
        AND: [
          { OR: privateDraftVisibility },
          {
            OR: [
              { assigneeMemberId: session.memberId },
              { raisedByMemberId: session.memberId },
              { circleId: session.role.circleId },
            ],
          },
        ],
      },
      select: { title: true, priority: true },
      orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
      take: 8,
    }),
    prisma.proposal.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        status: "OPEN",
        circleId: session.role.circleId,
        OR: privateDraftVisibility,
      },
      select: { title: true, summary: true },
      orderBy: { updatedAt: "desc" },
      take: 5,
    }),
    prisma.meeting.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        OR: [
          { participantIds: { has: session.memberId } },
          { participantIds: { has: params.userId } },
        ],
      },
      select: { title: true, recordedAt: true, summaryMd: true },
      orderBy: { recordedAt: "desc" },
      take: 5,
    }),
  ]);

  return { session, policies, actions, tensions, proposals, meetings };
}

export async function buildRoleOnboardingContextForConversation(params: {
  workspaceId: string;
  conversationId: string;
  userId: string;
}) {
  const context = await loadRoleOnboardingContext(params);
  if (!context) return null;

  const role = context.session.role;
  const member = context.session.member;
  const humanHolders = role.assignments
    .filter((assignment) => isRoleAssignmentActive(assignment))
    .map((assignment) => (
      assignment.member.user.displayName ?? assignment.member.user.email
    ));
  const agentHolders = role.agentAssignments.map((assignment) => (
    `${assignment.agentIdentity.displayName} (${assignment.agentIdentity.memberType})`
  ));
  const holderNames = [...humanHolders, ...agentHolders];

  return [
    "ROLE ONBOARDING CONTEXT",
    `Session status: ${context.session.status}`,
    `Role: ${role.name}`,
    `Circle: ${role.circle.name}`,
    `Role holder being onboarded: ${member.user.displayName ?? member.user.email}`,
    `Role purpose: ${role.purposeMd ?? "No role purpose recorded."}`,
    `Circle purpose: ${role.circle.purposeMd ?? "No circle purpose recorded."}`,
    `Circle domain: ${role.circle.domainMd ?? "No circle domain recorded."}`,
    listBlock("Accountabilities", role.accountabilities),
    listBlock("Artifacts / dashboards to watch", role.artifacts),
    listBlock("Current role holders", holderNames),
    listBlock(
      "Recent role definition versions",
      role.versions.map((version) => `v${version.version} ${version.changeType} at ${version.createdAt.toISOString()}: ${version.name}`),
    ),
    listBlock(
      "Relevant policies and working agreements",
      context.policies.map((policy) => `${policy.title}: ${policy.bodyMd.slice(0, 400)}`),
    ),
    listBlock(
      "Current commitments",
      context.actions.map((action) => `${action.title} (${action.status}${action.dueAt ? `, due ${action.dueAt.toISOString()}` : ""})`),
    ),
    listBlock(
      "Open tensions",
      context.tensions.map((tension) => `${tension.title} (priority ${tension.priority})`),
    ),
    listBlock(
      "Open circle proposals",
      context.proposals.map((proposal) => `${proposal.title}${proposal.summary ? `: ${proposal.summary}` : ""}`),
    ),
    listBlock(
      "Recent meetings involving this person",
      context.meetings.map((meeting) => `${meeting.title ?? "Untitled meeting"} at ${meeting.recordedAt.toISOString()}${meeting.summaryMd ? `: ${meeting.summaryMd.slice(0, 300)}` : ""}`),
    ),
    "Use this context to introduce the role, answer follow-up questions, and explain why the work matters. If the user asks about current state, stay grounded in this context and the available workspace tools.",
  ].join("\n\n");
}

export async function createRoleOnboardingIntro(params: {
  workspaceId: string;
  onboardingSessionId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const onboarding = await tx.roleOnboardingSession.findFirst({
      where: {
        id: params.onboardingSessionId,
        workspaceId: params.workspaceId,
      },
      include: {
        conversation: true,
        role: {
          include: {
            circle: { select: { name: true, purposeMd: true, domainMd: true } },
          },
        },
        member: {
          include: {
            user: { select: { displayName: true, email: true } },
          },
        },
      },
    });
    invariant(onboarding, 404, "NOT_FOUND", "Role onboarding session not found.");
    if (onboarding.status === "COMPLETED" || onboarding.status === "DISMISSED") {
      return onboarding;
    }
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext('conversation_turn'), hashtext(${onboarding.conversationId}))
    `;

    const assigneeName = onboarding.member.user.displayName ?? onboarding.member.user.email;
    const intro = [
      `Welcome to your **${onboarding.role.name}** onboarding, ${assigneeName}.`,
      `This role sits in the **${onboarding.role.circle.name}** circle.`,
      onboarding.role.purposeMd ? `The role purpose is: ${onboarding.role.purposeMd}` : "No role purpose has been recorded yet.",
      onboarding.role.accountabilities.length > 0
        ? `Your current accountabilities are:\n${onboarding.role.accountabilities.map((item) => `- ${item}`).join("\n")}`
        : "No accountabilities have been recorded yet.",
      "Ask me anything about the role, the circle, current commitments, policies, meetings, or how to approach the first week. I will use live workspace context as you ask follow-up questions.",
    ].join("\n\n");

    const lastTurn = await tx.conversationTurn.findFirst({
      where: { conversationId: onboarding.conversationId },
      orderBy: { sequenceNumber: "desc" },
      select: { sequenceNumber: true },
    });

    if (!lastTurn) {
      await tx.conversationTurn.create({
        data: {
          conversationId: onboarding.conversationId,
          sequenceNumber: 1,
          userMessage: ONBOARDING_START_MESSAGE,
          assistantMessage: intro,
        },
      });
    }

    const startedAt = onboarding.startedAt ?? new Date();
    const updated = await tx.roleOnboardingSession.updateMany({
      where: {
        id: onboarding.id,
        status: { in: ACTIVE_ONBOARDING_STATUSES },
      },
      data: {
        status: "ACTIVE",
        startedAt,
      },
    });
    if (updated.count === 0) {
      const current = await tx.roleOnboardingSession.findFirst({
        where: {
          id: onboarding.id,
          workspaceId: params.workspaceId,
        },
      });
      invariant(current, 404, "NOT_FOUND", "Role onboarding session not found.");
      return current;
    }

    return { ...onboarding, status: "ACTIVE" as const, startedAt };
  });
}

export async function updateRoleOnboardingStatusByConversation(
  actor: AppActor,
  params: {
    workspaceId: string;
    conversationId: string;
    status: Extract<RoleOnboardingStatus, "COMPLETED" | "DISMISSED">;
  },
) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  invariant(userId, 401, "AUTH_REQUIRED", "Role onboarding status requires a user actor.");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const onboarding = await prisma.roleOnboardingSession.findFirst({
    where: {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      conversation: { userId },
      status: { in: ACTIVE_ONBOARDING_STATUSES },
    },
    select: { id: true },
  });
  invariant(onboarding, 404, "NOT_FOUND", "Role onboarding session not found.");

  const now = new Date();
  return prisma.roleOnboardingSession.update({
    where: { id: onboarding.id },
    data: {
      status: params.status,
      completedAt: params.status === "COMPLETED" ? now : null,
      dismissedAt: params.status === "DISMISSED" ? now : null,
    },
  });
}
