import { captureArtifactInputProof, readableArtifactIds, type LineageInput, type LineageRoot } from "./source-lineage";
import { prepareProducerLineage, finishProducerLineage } from "./producer-lineage";
import { Prisma, type RoleOnboardingStatus } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { createNotificationIntent } from "./notifications";
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

  const receipt = await prepareProducerLineage({ tx, actor: params.actor, workspaceId: params.workspaceId,
    completeCopy: true, copied: true, dependencies: [{ kind: "Role", id: params.role.id }],
    snapshotDependencies: [{ kind: "Role", id: params.role.id }] });
  const snapshot = await tx.roleVersion.create({
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
  await finishProducerLineage({ tx, actor: params.actor, workspaceId: params.workspaceId,
    artifact: { kind: "RoleVersion", id: snapshot.id }, content: snapshot, receipt });
  return snapshot;
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
  const receipt = await prepareProducerLineage({ tx, actor: params.actor, workspaceId: params.workspaceId,
    completeCopy: true, dependencies: [
      { kind: "Role", id: params.roleId },
      ...(params.memberId ? [{ kind: "Member" as const, id: params.memberId }] : []),
      ...(params.agentIdentityId ? [{ kind: "AgentIdentity" as const, id: params.agentIdentityId }] : []),
      ...(params.assignmentId ? [{ kind: "RoleAssignment" as const, id: params.assignmentId }] : []),
    ], snapshotDependencies: [{ kind: "Role", id: params.roleId }] });
  const history = await tx.roleHolderHistory.create({
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
  await finishProducerLineage({ tx, actor: params.actor, workspaceId: params.workspaceId,
    artifact: { kind: "RoleHolderHistory", id: history.id }, content: history, receipt });
}


export async function endVerifiedRoleHolderHistories(tx: Prisma.TransactionClient, params: {
  workspaceId: string;
  actor: AppActor;
  where: Prisma.RoleHolderHistoryWhereInput;
  data: Prisma.RoleHolderHistoryUncheckedUpdateManyInput;
}) {
  const histories = await tx.roleHolderHistory.findMany({ where: params.where });
  const receipts = await Promise.all(histories.map((history) => prepareProducerLineage({
    tx, actor: params.actor, workspaceId: params.workspaceId,
    artifact: { kind: "RoleHolderHistory", id: history.id }, before: history, allowSystemTransition: true,
  })));
  await tx.roleHolderHistory.updateMany({ where: params.where, data: params.data });
  const updated = await tx.roleHolderHistory.findMany({ where: { id: { in: histories.map((history) => history.id) } } });
  for (const history of updated) {
    const index = histories.findIndex((prior) => prior.id === history.id);
    await finishProducerLineage({ tx, actor: params.actor, workspaceId: params.workspaceId,
      artifact: { kind: "RoleHolderHistory", id: history.id }, content: history, receipt: receipts[index] });
  }
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
  await endVerifiedRoleHolderHistories(tx, {
    workspaceId: params.workspaceId, actor: params.actor,
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
    actor: AppActor;
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
  const receipt = await prepareProducerLineage({ tx, actor: params.actor, workspaceId: params.workspaceId,
    completeCopy: true, dependencies: [
      { kind: "Role", id: params.role.id, snapshot: params.role },
      { kind: "Member", id: params.member.id, snapshot: params.member },
    ] });
  const conversation = await tx.conversationSession.create({
    data: {
      workspaceId: params.workspaceId,
      userId: params.member.userId,
      agentKey: "role-onboarding",
      topic: `Onboarding: ${params.role.name}`,
      systemPrompt: null,
    },
  });
  await finishProducerLineage({ tx, actor: params.actor, workspaceId: params.workspaceId,
    artifact: { kind: "ConversationSession", id: conversation.id }, content: conversation, receipt });


  const session = await tx.roleOnboardingSession.create({
    data: {
      workspaceId: params.workspaceId,
      roleId: params.role.id,
      memberId: params.member.id,
      conversationId: conversation.id,
    },
    include: { conversation: true },
  });
  await finishProducerLineage({ tx, actor: params.actor, workspaceId: params.workspaceId,
    artifact: { kind: "RoleOnboardingSession", id: session.id }, content: session, receipt });


  let notificationRoots: LineageRoot[] = [];
  try {
    notificationRoots = await captureArtifactInputProof(params.actor, params.workspaceId, [
      { kind: "Role", id: params.role.id, snapshot: params.role },
      { kind: "Member", id: params.member.id, snapshot: params.member },
    ], tx);
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error)
      || !["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(String(error.code))) throw error;
  }
  await createNotificationIntent(tx, {
    lineageActor: params.actor, lineageRoots: notificationRoots,
    workspaceId: params.workspaceId,
    type: "role-onboarding.assigned",
    recipientUserIds: [params.member.userId],
    entityType: "ConversationSession",
    entityId: conversation.id,
    title: `Role onboarding: ${params.role.name}`,
    bodyMd: `${assigneeName}, your guided onboarding chat for **${params.role.name}** is ready.`,
    priority: "HIGH",
  });

  return { ...session, wasCreated: true };
}


async function transitionRoleOnboardingSessions(tx: Prisma.TransactionClient, params: {
  workspaceId: string;
  actor?: AppActor;
  where: Prisma.RoleOnboardingSessionWhereInput;
  data: Prisma.RoleOnboardingSessionUpdateManyMutationInput;
}) {
  const actor: AppActor = params.actor ?? { kind: "agent", authProvider: "bootstrap",
    label: "role-onboarding-lifecycle", workspaceIds: [params.workspaceId] };
  const sessions = await tx.roleOnboardingSession.findMany({ where: params.where });
  const receipts = await Promise.all(sessions.map((session) => prepareProducerLineage({ tx, actor,
    workspaceId: params.workspaceId, artifact: { kind: "RoleOnboardingSession", id: session.id },
    before: session, allowSystemTransition: true })));
  await tx.roleOnboardingSession.updateMany({ where: params.where, data: params.data });
  const after = await tx.roleOnboardingSession.findMany({ where: { id: { in: sessions.map((session) => session.id) } } });
  for (const session of after) {
    const index = sessions.findIndex((prior) => prior.id === session.id);
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "RoleOnboardingSession", id: session.id }, content: session, receipt: receipts[index] });
  }
}

export async function dismissRoleOnboardingForAssignment(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    roleId: string;
    memberId: string;
  },
) {
  await transitionRoleOnboardingSessions(tx, {
    workspaceId: params.workspaceId,
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

  await endVerifiedRoleHolderHistories(tx, {
    workspaceId: params.workspaceId, actor: params.actor,
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

  await transitionRoleOnboardingSessions(tx, {
    workspaceId: params.workspaceId,
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

  await endVerifiedRoleHolderHistories(tx, {
    workspaceId: params.workspaceId, actor: params.actor,
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

  await transitionRoleOnboardingSessions(tx, {
    workspaceId: params.workspaceId,
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

  await endVerifiedRoleHolderHistories(tx, {
    workspaceId: params.workspaceId, actor: params.actor,
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
  actor?: AppActor;
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
          circle: true,
          assignments: {
            where: activeRoleAssignmentWhere(),
            include: {
              member: {
                include: {
                  user: {
                    select: { id: true, displayName: true, email: true },
                  },
                },
              },
            },
            orderBy: { assignedAt: "desc" },
          },
          agentAssignments: {
            include: {
              agentIdentity: {
                select: { id: true, workspaceId: true, agentKey: true, memberType: true, displayName: true,
                  purposeMd: true, behaviorMd: true, isActive: true, archivedAt: true, createdAt: true, updatedAt: true },
              },
            },
            orderBy: { assignedAt: "desc" },
          },
          versions: {
            orderBy: { createdAt: "desc" },
          },
        },
      },
      member: {
        include: {
          user: {
            select: { id: true, displayName: true, email: true },
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

  const [candidatePolicies, candidateActions, candidateTensions, candidateProposals, candidateMeetings] = await Promise.all([
    prisma.policyCorpus.findMany({
      where: {
        workspaceId: params.workspaceId,
        OR: [
          { circleId: null },
          { circleId: session.role.circleId },
        ],
      },
      orderBy: { acceptedAt: "desc" },
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
      orderBy: { updatedAt: "desc" },
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
      orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
    }),
    prisma.proposal.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        status: "OPEN",
        circleId: session.role.circleId,
        OR: privateDraftVisibility,
      },
      orderBy: { updatedAt: "desc" },
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
      orderBy: { recordedAt: "desc" },
    }),
  ]);

  const actor: AppActor = params.actor ?? { kind: "user", user: {
    id: params.userId, email: session.member.user.email,
    displayName: session.member.user.displayName, globalRole: "USER",
  } };
  invariant(actor.kind === "user" && actor.user.id === params.userId, 403, "FORBIDDEN", "Onboarding context requires its owner.");
  async function admitted<T extends { id: string }>(kind: LineageInput["kind"], records: T[], take?: number) {
    const visible = await readableArtifactIds(actor, params.workspaceId, kind, records);
    return records.filter((record) => visible.has(record.id)).slice(0, take);
  }
  const [sessions, roles, circles, members] = await Promise.all([
    admitted("RoleOnboardingSession", [session]), admitted("Role", [session.role]),
    admitted("Circle", [session.role.circle]), admitted("Member", [session.member]),
  ]);
  if (!sessions.length || !roles.length || !circles.length || !members.length) return null;
  const [policies, actions, tensions, proposals, meetings, versions, humanAssignments, agentIdentities, agentAssignments] = await Promise.all([
    admitted("PolicyCorpus", candidatePolicies, 5), admitted("Action", candidateActions, 8),
    admitted("Tension", candidateTensions, 8), admitted("Proposal", candidateProposals, 5),
    admitted("Meeting", candidateMeetings, 5), admitted("RoleVersion", session.role.versions, 3),
    admitted("RoleAssignment", session.role.assignments.filter((assignment) => isRoleAssignmentActive(assignment))),
    admitted("AgentIdentity", session.role.agentAssignments.map((assignment) => assignment.agentIdentity)),
    admitted("CircleAgentAssignment", session.role.agentAssignments),
  ]);
  const holderMembers = await admitted("Member", humanAssignments.map((assignment) => assignment.member));
  const memberIds = new Set(holderMembers.map((member) => member.id));
  const identityIds = new Set(agentIdentities.map((identity) => identity.id));
  const assignments = humanAssignments.filter((assignment) => memberIds.has(assignment.member.id));
  const safeSession = { ...session, role: { ...session.role, assignments, versions,
    agentAssignments: agentAssignments.filter((assignment) => identityIds.has(assignment.agentIdentity.id)),
  } };
  const captured: Array<LineageInput & { snapshot: Record<string, unknown> }> = [];
  function append(kind: LineageInput["kind"], records: Array<{ id: string }>) {
    records.forEach((snapshot) => captured.push({ kind, id: snapshot.id, snapshot }));
  }
  append("RoleOnboardingSession", [session]); append("Role", [session.role]);
  append("Circle", [session.role.circle]); append("Member", [session.member, ...holderMembers]);
  append("RoleAssignment", assignments); append("AgentIdentity", agentIdentities);
  append("CircleAgentAssignment", safeSession.role.agentAssignments); append("RoleVersion", versions);
  append("PolicyCorpus", policies); append("Action", actions); append("Tension", tensions);
  append("Proposal", proposals); append("Meeting", meetings);
  try {
    const lineageRoots = await captureArtifactInputProof(actor, params.workspaceId, captured);
    return { session: safeSession, policies, actions, tensions, proposals, meetings,
      lineageInputs: captured.map(({ kind, id }) => ({ kind, id })), lineageRoots };
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error)
      || !["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(String(error.code))) throw error;
    return null;
  }
}

export async function buildRoleOnboardingContextWithLineageForConversation(params: {
  workspaceId: string;
  conversationId: string;
  userId: string;
  actor?: AppActor;
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

  const text = [
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
  return { context: text, lineageInputs: context.lineageInputs, lineageRoots: context.lineageRoots };
}

export async function buildRoleOnboardingContextForConversation(params: {
  workspaceId: string;
  conversationId: string;
  userId: string;
  actor?: AppActor;
}) {
  return (await buildRoleOnboardingContextWithLineageForConversation(params))?.context ?? null;
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
            circle: true,
          },
        },
        member: {
          include: {
            user: { select: { id: true, displayName: true, email: true } },
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

    const actor: AppActor = { kind: "agent", authProvider: "bootstrap", label: "role-onboarding-intro",
      workspaceIds: [params.workspaceId] };
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      completeCopy: true, copied: true, dependencies: [
        { kind: "RoleOnboardingSession", id: onboarding.id, snapshot: onboarding },
        { kind: "Role", id: onboarding.role.id, snapshot: onboarding.role },
        { kind: "Circle", id: onboarding.role.circle.id, snapshot: onboarding.role.circle },
        { kind: "Member", id: onboarding.member.id, snapshot: onboarding.member },
      ], snapshotDependencies: [{ kind: "RoleOnboardingSession", id: onboarding.id }] });
    const sessionReceipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "RoleOnboardingSession", id: onboarding.id }, before: onboarding, allowSystemTransition: true });
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
      const turn = await tx.conversationTurn.create({
        data: {
          conversationId: onboarding.conversationId,
          sequenceNumber: 1,
          userMessage: ONBOARDING_START_MESSAGE,
          assistantMessage: intro,
        },
      });
      await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "ConversationTurn", id: turn.id }, content: turn, receipt });

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

    const after = await tx.roleOnboardingSession.findFirst({ where: { id: onboarding.id, workspaceId: params.workspaceId } });
    invariant(after, 404, "NOT_FOUND", "Role onboarding session not found.");
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "RoleOnboardingSession", id: onboarding.id }, content: after, receipt: sessionReceipt });
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

  return prisma.$transaction(async (tx) => {
    const onboarding = await tx.roleOnboardingSession.findFirst({
      where: {
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        conversation: { userId },
        status: { in: ACTIVE_ONBOARDING_STATUSES },
      },
  });
  invariant(onboarding, 404, "NOT_FOUND", "Role onboarding session not found.");

  const now = new Date();
  const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
    artifact: { kind: "RoleOnboardingSession", id: onboarding.id }, before: onboarding, allowSystemTransition: true });
  const after = await tx.roleOnboardingSession.update({
    where: { id: onboarding.id },
    data: {
      status: params.status,
      completedAt: params.status === "COMPLETED" ? now : null,
      dismissedAt: params.status === "DISMISSED" ? now : null,
    },
  });
  await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
    artifact: { kind: "RoleOnboardingSession", id: after.id }, content: after, receipt });
  return after;
  });
}
