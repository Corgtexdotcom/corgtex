import { prepareProducerLineage, finishProducerLineage, type ProducerLineageParams } from "./producer-lineage";
import { prisma } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { lockWorkspaceMembership } from "./workspace-support-access";
import { archiveFilterWhere, type ArchiveFilter } from "./archive";
import { AppError, invariant } from "./errors";
import { captureArtifactInputProof, readableArtifactIds } from "./source-lineage";
import {
  closeRoleLifecycleForRoles,
  createRoleVersionSnapshot,
  dismissRoleOnboardingForAssignment,
  endRoleHolderHistory,
  endVerifiedRoleHolderHistories,
  ensureRoleOnboardingForAssignment,
  startRoleHolderHistory,
} from "./role-onboarding";

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

function actorLabel(actor: AppActor) {
  if (actor.kind === "user") return actor.user.displayName ?? actor.user.email;
  return actor.label ?? actor.authProvider ?? "agent";
}

function jsonSnapshot(record: unknown) {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

function sameStringList(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

const ROLE_ASSIGNMENT_ROLE_INCLUDE = {
  circle: {
    select: {
      id: true,
      workspaceId: true,
      name: true,
      purposeMd: true,
      domainMd: true,
    },
  },
} satisfies Prisma.RoleInclude;

type RoleForAssignment = Prisma.RoleGetPayload<{ include: typeof ROLE_ASSIGNMENT_ROLE_INCLUDE }>;

const ROLE_ASSIGNMENT_MEMBER_INCLUDE = {
  user: {
    select: {
      displayName: true,
      email: true,
    },
  },
} satisfies Prisma.MemberInclude;

type MemberForAssignment = Prisma.MemberGetPayload<{ include: typeof ROLE_ASSIGNMENT_MEMBER_INCLUDE }>;

export { activeRoleAssignmentWhere, isRoleAssignmentActive } from "./role-assignment-activity";

export async function listRoles(actor: AppActor, workspaceId: string, opts?: { archiveFilter?: ArchiveFilter }) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const roles = await prisma.role.findMany({
    where: {
      ...archiveFilterWhere(opts?.archiveFilter),
      circle: {
        workspaceId,
        archivedAt: null,
      },
    },
    include: {
      circle: true,
    },
  });
  const visibleRoles = await readableArtifactIds(actor, workspaceId, "Role", roles);
  const admitted = roles.filter((role) => visibleRoles.has(role.id));
  const visibleCircles = await readableArtifactIds(actor, workspaceId, "Circle", admitted.map((role) => role.circle));
  return admitted
    .sort((left, right) => {
      // Withheld circle metadata must not influence grouping or ranking.
      const leftOrder = visibleCircles.has(left.circleId) ? left.circle.sortOrder : 0;
      const rightOrder = visibleCircles.has(right.circleId) ? right.circle.sortOrder : 0;
      return leftOrder - rightOrder || left.sortOrder - right.sortOrder || left.createdAt.getTime() - right.createdAt.getTime();
    })
    .map((role) => ({ ...role,
      circleId: visibleCircles.has(role.circleId) ? role.circleId : null,
      circle: visibleCircles.has(role.circleId) ? { id: role.circle.id, name: role.circle.name } : null,
    }));
}

/** Gate association and profile content before exposing role filler counts. */
export async function filterReadableRoleAssignments<T extends {
  id: string;
  member: { id: string; user: { id: string; email: string; displayName: string | null; bio?: string | null } };
}>(actor: AppActor, workspaceId: string, assignments: T[]): Promise<T[]> {
  const visibleAssignments = await readableArtifactIds(actor, workspaceId, "RoleAssignment", assignments);
  const admitted = assignments.filter((assignment) => visibleAssignments.has(assignment.id));
  const visibleMembers = await readableArtifactIds(actor, workspaceId, "Member", admitted.map(({ member }) => ({
    ...member, user: { id: member.user.id, email: member.user.email, displayName: member.user.displayName },
  })));
  const visibleProfiles = new Set<string>();
  for (const assignment of admitted) {
    if (!visibleMembers.has(assignment.member.id)) continue;
    try {
      // Label projections omit profile fields. Capture the authoritative User
      // receipt and verify only observed fields, without inventing null values.
      await captureArtifactInputProof(actor, workspaceId, [{ kind: "User", id: assignment.member.user.id,
        snapshot: assignment.member.user }]);
      visibleProfiles.add(assignment.id);
    } catch (error) {
      if (!(error instanceof AppError) || !["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(error.code)) throw error;
    }
  }
  return admitted.filter((assignment) => visibleProfiles.has(assignment.id));
}

async function roleMutationResult(tx: Prisma.TransactionClient, actor: AppActor, workspaceId: string,
  role: Prisma.RoleGetPayload<{ include: { circle: true } }>) {
  const visible = await readableArtifactIds(actor, workspaceId, "Role", [role], tx);
  if (!visible.has(role.id)) return { id: role.id, contentWithheld: true as const };
  const visibleCircles = await readableArtifactIds(actor, workspaceId, "Circle", [role.circle], tx);
  const circleVisible = visibleCircles.has(role.circle.id);
  return { ...role, circleId: circleVisible ? role.circleId : null,
    circle: circleVisible ? { id: role.circle.id, name: role.circle.name } : null };
}

export async function getRole(actor: AppActor, params: {
  workspaceId: string;
  roleId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const role = await prisma.role.findFirst({
    where: {
      id: params.roleId,
      archivedAt: null,
      circle: {
        workspaceId: params.workspaceId,
        archivedAt: null,
      },
    },
    include: {
      circle: true,
      assignments: {
        include: {
          member: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  displayName: true,
                  avatarUrl: true,
                  bio: true,
                },
              },
            },
          },
        },
      },
    },
  });

  invariant(role, 404, "NOT_FOUND", "Role not found.");
  const visible = await readableArtifactIds(actor, params.workspaceId, "Role", [role]);
  invariant(visible.has(role.id), 404, "NOT_FOUND", "Role not found.");
  const visibleCircles = await readableArtifactIds(actor, params.workspaceId, "Circle", [role.circle]);
  const assignments = await filterReadableRoleAssignments(actor, params.workspaceId, role.assignments);
  return { ...role,
    circleId: visibleCircles.has(role.circleId) ? role.circleId : null,
    circle: visibleCircles.has(role.circleId) ? {
      id: role.circle.id, name: role.circle.name, purposeMd: role.circle.purposeMd,
      domainMd: role.circle.domainMd, maturityStage: role.circle.maturityStage,
    } : null,
    assignments: assignments.sort((left, right) => right.assignedAt.getTime() - left.assignedAt.getTime()),
  };
}

export async function createRole(actor: AppActor, params: ProducerLineageParams & {
  workspaceId: string;
  circleId: string;
  name: string;
  purposeMd?: string | null;
  accountabilities?: string[];
  artifacts?: string[];
  coreRoleType?: string | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["FACILITATOR", "ADMIN"],
  });

  const name = params.name.trim();
  invariant(name.length > 0, 400, "INVALID_INPUT", "Role name is required.");

  return prisma.$transaction(async (tx) => {
    const circle = await tx.circle.findUnique({
      where: { id: params.circleId },
      select: {
        id: true,
        workspaceId: true,
        archivedAt: true,
      },
    });

    invariant(circle && circle.workspaceId === params.workspaceId && !circle.archivedAt, 404, "NOT_FOUND", "Circle not found.");

    const sortOrder = await tx.role.count({
      where: { circleId: circle.id },
    });

    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId, capture: params });
    const role = await tx.role.create({
      data: {
        circleId: circle.id,
        name,
        purposeMd: params.purposeMd?.trim() || null,
        accountabilities: (params.accountabilities ?? []).map((value) => value.trim()).filter(Boolean),
        artifacts: (params.artifacts ?? []).map((value) => value.trim()).filter(Boolean),
        coreRoleType: params.coreRoleType?.trim() || null,
        sortOrder,
      },
      include: {
        circle: true,
      },
    });
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Role", id: role.id }, content: role, receipt });


    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "role.created",
        entityType: "Role",
        entityId: role.id,
        meta: {
          circleId: circle.id,
          name: role.name,
        },
      },
    });

    await createRoleVersionSnapshot(tx, {
      workspaceId: params.workspaceId,
      role,
      changeType: "created",
      actor,
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "role.created",
        aggregateType: "Role",
        aggregateId: role.id,
        payload: {
          roleId: role.id,
          circleId: circle.id,
          name: role.name,
        },
      },
    ]);

    return roleMutationResult(tx, actor, params.workspaceId, role);
  });
}

export async function updateRole(actor: AppActor, params: ProducerLineageParams & {
  workspaceId: string;
  roleId: string;
  circleId?: string;
  name?: string;
  purposeMd?: string | null;
  accountabilities?: string[];
  artifacts?: string[];
  coreRoleType?: string | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["FACILITATOR", "ADMIN"],
  });

  return prisma.$transaction(async (tx) => {
    const role = await tx.role.findUnique({
      where: { id: params.roleId },
      include: { circle: { select: { workspaceId: true } } },
    });

    invariant(role && role.circle.workspaceId === params.workspaceId && !role.archivedAt, 404, "NOT_FOUND", "Role not found.");

    const data: Record<string, unknown> = {};
    let movedRole = false;
    if (params.circleId !== undefined) {
      const circleId = params.circleId.trim();
      invariant(circleId.length > 0, 400, "INVALID_INPUT", "Circle is required.");
      if (circleId !== role.circleId) {
        const targetCircle = await tx.circle.findUnique({
          where: { id: circleId },
          select: {
            id: true,
            workspaceId: true,
            archivedAt: true,
          },
        });
        invariant(targetCircle && targetCircle.workspaceId === params.workspaceId && !targetCircle.archivedAt, 404, "NOT_FOUND", "Circle not found.");
        data.circleId = targetCircle.id;
        data.sortOrder = await tx.role.count({ where: { circleId: targetCircle.id } });
        movedRole = true;
      }
    }
    if (params.name !== undefined) {
      const name = params.name.trim();
      invariant(name.length > 0, 400, "INVALID_INPUT", "Role name is required.");
      if (name !== role.name) data.name = name;
    }
    if (params.purposeMd !== undefined) {
      const purposeMd = params.purposeMd?.trim() || null;
      if (purposeMd !== role.purposeMd) data.purposeMd = purposeMd;
    }
    if (params.accountabilities !== undefined) {
      const accountabilities = params.accountabilities.map((v) => v.trim()).filter(Boolean);
      if (!sameStringList(accountabilities, role.accountabilities)) data.accountabilities = accountabilities;
    }
    if (params.artifacts !== undefined) {
      const artifacts = params.artifacts.map((v) => v.trim()).filter(Boolean);
      if (!sameStringList(artifacts, role.artifacts)) data.artifacts = artifacts;
    }
    if (params.coreRoleType !== undefined) {
      const coreRoleType = params.coreRoleType?.trim() || null;
      if (coreRoleType !== role.coreRoleType) data.coreRoleType = coreRoleType;
    }

    if (Object.keys(data).length === 0) {
      const unchanged = await tx.role.findUnique({
        where: { id: params.roleId },
        include: { circle: true },
      });
      invariant(unchanged, 404, "NOT_FOUND", "Role not found.");
      return roleMutationResult(tx, actor, params.workspaceId, unchanged);
    }

    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Role", id: role.id }, before: role, capture: params });
    const updated = await tx.role.update({
      where: { id: params.roleId },
      data,
      include: { circle: true },
    });
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Role", id: updated.id }, content: updated, receipt });


    if (movedRole) {
      const now = new Date();
      await endVerifiedRoleHolderHistories(tx, {
        workspaceId: params.workspaceId, actor,
        where: {
          workspaceId: params.workspaceId,
          roleId: role.id,
          holderKind: "AGENT",
          endedAt: null,
        },
        data: {
          endedAt: now,
          endedByUserId: actorUserId(actor),
        },
      });
      await tx.circleAgentAssignment.updateMany({
        where: { roleId: role.id },
        data: { roleId: null },
      });
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "role.updated",
        entityType: "Role",
        entityId: updated.id,
        meta: { fields: Object.keys(data) },
      },
    });

    await createRoleVersionSnapshot(tx, {
      workspaceId: params.workspaceId,
      role: updated,
      changeType: "updated",
      actor,
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "role.updated",
        aggregateType: "Role",
        aggregateId: updated.id,
        payload: {
          roleId: updated.id,
          circleId: updated.circle.id,
          name: updated.name,
          fields: Object.keys(data),
        },
      },
    ]);

    return roleMutationResult(tx, actor, params.workspaceId, updated);
  });
}

export async function deleteRole(actor: AppActor, params: {
  workspaceId: string;
  roleId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["FACILITATOR", "ADMIN"],
  });

  return prisma.$transaction(async (tx) => {
    const role = await tx.role.findFirst({
      where: {
        id: params.roleId,
        circle: {
          workspaceId: params.workspaceId,
        },
      },
    });
    invariant(role, 404, "NOT_FOUND", "Role not found.");

    const archiveReason = "Archived from role delete path.";
    const now = new Date();
    if (!role.archivedAt) {
      const previousState = jsonSnapshot(role);
      await tx.role.update({
        where: { id: role.id },
        data: {
          archivedAt: now,
          archivedByUserId: actorUserId(actor),
          archiveReason,
        },
      });

      await tx.workspaceArchiveRecord.create({
        data: {
          workspaceId: params.workspaceId,
          entityType: "Role",
          entityId: role.id,
          entityLabel: role.name,
          previousState: previousState as Prisma.InputJsonObject,
          archiveReason,
          archivedByUserId: actorUserId(actor),
          archivedByLabel: actorLabel(actor),
          archivedAt: now,
        },
      });

      await tx.auditLog.create({
        data: {
          workspaceId: params.workspaceId,
          actorUserId: actorUserId(actor),
          action: "workspace-artifact.archived",
          entityType: "Role",
          entityId: role.id,
          meta: {
            label: role.name,
            reason: archiveReason,
          },
        },
      });
    }

    await closeRoleLifecycleForRoles(tx, {
      workspaceId: params.workspaceId,
      roleIds: [params.roleId],
      actor,
      now,
    });

    return { id: params.roleId };
  });
}

export async function assignRole(actor: AppActor, params: {
  workspaceId: string;
  roleId: string;
  memberId: string;
  expiresAt?: Date | null;
  transferReason?: string | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["FACILITATOR", "ADMIN"],
  });

  return prisma.$transaction(async (tx) => {
    await lockWorkspaceMembership(tx, params.workspaceId);
    await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["FACILITATOR", "ADMIN"], tx });
    await lockRoleAssignments(tx, [{ roleId: params.roleId, memberId: params.memberId }]);

    const role = await loadRoleForAssignment(tx, params.workspaceId, params.roleId);
    const member = await loadMemberForAssignment(tx, params.workspaceId, params.memberId);
    const transfer = normalizeRoleAssignmentTransfer({
      expiresAt: params.expiresAt,
      transferReason: params.transferReason,
    });

    const { assignment } = await assignRoleInTransaction(tx, actor, {
      workspaceId: params.workspaceId,
      role,
      member,
      transfer,
    });

    return assignment;
  });
}

export async function unassignRole(actor: AppActor, params: {
  workspaceId: string;
  roleId: string;
  memberId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["FACILITATOR", "ADMIN"],
  });

  return prisma.$transaction(async (tx) => {
    await lockWorkspaceMembership(tx, params.workspaceId);
    await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["FACILITATOR", "ADMIN"], tx });
    await lockRoleAssignments(tx, [{ roleId: params.roleId, memberId: params.memberId }]);
    await loadRoleForAssignment(tx, params.workspaceId, params.roleId);

    return unassignRoleInTransaction(tx, actor, {
      workspaceId: params.workspaceId,
      roleId: params.roleId,
      memberId: params.memberId,
    });
  });
}

export async function reassignRole(actor: AppActor, params: {
  workspaceId: string;
  roleId: string;
  fromMemberId: string;
  toMemberId: string;
  expiresAt?: Date | null;
  transferReason?: string | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["FACILITATOR", "ADMIN"],
  });

  invariant(params.fromMemberId !== params.toMemberId, 400, "INVALID_INPUT", "Choose a different member to reassign this role.");

  return prisma.$transaction(async (tx) => {
    await lockWorkspaceMembership(tx, params.workspaceId);
    await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["FACILITATOR", "ADMIN"], tx });
    await lockRoleAssignments(tx, [
      { roleId: params.roleId, memberId: params.fromMemberId },
      { roleId: params.roleId, memberId: params.toMemberId },
    ]);

    const role = await loadRoleForAssignment(tx, params.workspaceId, params.roleId);
    const targetMember = await loadMemberForAssignment(tx, params.workspaceId, params.toMemberId);
    const transfer = normalizeRoleAssignmentTransfer({
      expiresAt: params.expiresAt,
      transferReason: params.transferReason,
    });
    const sourceAssignment = await tx.roleAssignment.findUnique({
      where: {
        roleId_memberId: {
          roleId: params.roleId,
          memberId: params.fromMemberId,
        },
      },
    });
    invariant(sourceAssignment, 404, "NOT_FOUND", "Role assignment not found.");

    const { assignment: targetAssignment } = await assignRoleInTransaction(tx, actor, {
      workspaceId: params.workspaceId,
      role,
      member: targetMember,
      transfer,
    });
    const removedAssignment = await unassignRoleInTransaction(tx, actor, {
      workspaceId: params.workspaceId,
      roleId: params.roleId,
      memberId: params.fromMemberId,
      assignment: sourceAssignment,
    });

    return {
      roleId: params.roleId,
      fromMemberId: params.fromMemberId,
      toMemberId: params.toMemberId,
      assignedAssignmentId: targetAssignment.id,
      removedAssignmentId: removedAssignment.id,
    };
  });
}

function assignmentKey(params: { roleId: string; memberId: string }) {
  return `${params.roleId}:${params.memberId}`;
}

type RoleAssignmentTransfer = {
  expiresAt: Date | null;
  transferReason: string | null;
};

function normalizeRoleAssignmentTransfer(params: {
  expiresAt?: Date | null;
  transferReason?: string | null;
  now?: Date;
}): RoleAssignmentTransfer {
  const expiresAt = params.expiresAt ?? null;
  if (expiresAt) {
    invariant(!Number.isNaN(expiresAt.getTime()), 400, "INVALID_INPUT", "Temporary role assignment expiry is invalid.");
    invariant(expiresAt.getTime() > (params.now ?? new Date()).getTime(), 400, "INVALID_INPUT", "Temporary role assignment expiry must be in the future.");
  }

  return {
    expiresAt,
    transferReason: expiresAt ? params.transferReason?.trim() || null : null,
  };
}

function sameNullableDate(left?: Date | null, right?: Date | null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.getTime() === right.getTime();
}

function transferEventPayload(transfer: RoleAssignmentTransfer) {
  return {
    expiresAt: transfer.expiresAt?.toISOString() ?? null,
    transferReason: transfer.transferReason,
  };
}

async function lockRoleAssignments(
  tx: Prisma.TransactionClient,
  assignments: Array<{ roleId: string; memberId: string }>,
) {
  const keys = Array.from(new Set(assignments.map(assignmentKey))).sort();
  for (const key of keys) {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext('role_assignment'), hashtext(${key}))
    `;
  }
}

async function loadRoleForAssignment(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  roleId: string,
): Promise<RoleForAssignment> {
  const role = await tx.role.findUnique({
    where: { id: roleId },
    include: ROLE_ASSIGNMENT_ROLE_INCLUDE,
  });
  invariant(role && role.circle.workspaceId === workspaceId && !role.archivedAt, 404, "NOT_FOUND", "Role not found.");
  return role;
}

async function loadMemberForAssignment(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  memberId: string,
): Promise<MemberForAssignment> {
  const member = await tx.member.findUnique({
    where: { id: memberId },
    include: ROLE_ASSIGNMENT_MEMBER_INCLUDE,
  });
  invariant(member && member.workspaceId === workspaceId && member.isActive, 404, "NOT_FOUND", "Member not found.");
  return member;
}

async function assignRoleInTransaction(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  params: {
    workspaceId: string;
    role: RoleForAssignment;
    member: MemberForAssignment;
    transfer: RoleAssignmentTransfer;
  },
) {
  const key = {
    roleId: params.role.id,
    memberId: params.member.id,
  };
  const existingAssignment = await tx.roleAssignment.findUnique({
    where: {
      roleId_memberId: key,
    },
  });
  const transferChanged = !sameNullableDate(existingAssignment?.expiresAt ?? null, params.transfer.expiresAt)
    || (existingAssignment?.transferReason ?? null) !== params.transfer.transferReason;

  const assignment = await tx.roleAssignment.upsert({
    where: {
      roleId_memberId: key,
    },
    update: {
      expiresAt: params.transfer.expiresAt,
      transferReason: params.transfer.transferReason,
    },
    create: {
      ...key,
      expiresAt: params.transfer.expiresAt,
      transferReason: params.transfer.transferReason,
    },
  });

  if (!existingAssignment) {
    await startRoleHolderHistory(tx, {
      workspaceId: params.workspaceId,
      roleId: params.role.id,
      memberId: params.member.id,
      assignmentId: assignment.id,
      actor,
    });
  }

  const onboarding = await ensureRoleOnboardingForAssignment(tx, {
    actor,
    workspaceId: params.workspaceId,
    role: params.role,
    member: params.member,
  });

  await tx.auditLog.create({
    data: {
      workspaceId: params.workspaceId,
      actorUserId: actorUserId(actor),
      action: "role.assigned",
      entityType: "RoleAssignment",
      entityId: assignment.id,
      meta: {
        roleId: params.role.id,
        memberId: params.member.id,
        ...transferEventPayload(params.transfer),
      },
    },
  });

  if (!existingAssignment || onboarding.wasCreated) {
    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "role.assigned",
        aggregateType: "RoleAssignment",
        aggregateId: assignment.id,
        payload: {
          roleId: params.role.id,
          memberId: params.member.id,
          assignmentId: assignment.id,
          onboardingSessionId: onboarding.id,
          conversationId: onboarding.conversationId,
          ...transferEventPayload(params.transfer),
        },
      },
    ]);
  } else if (transferChanged) {
    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "role.assignment.updated",
        aggregateType: "RoleAssignment",
        aggregateId: assignment.id,
        payload: {
          roleId: params.role.id,
          memberId: params.member.id,
          assignmentId: assignment.id,
          ...transferEventPayload(params.transfer),
        },
      },
    ]);
  }

  return { assignment, existingAssignment, onboarding };
}

async function unassignRoleInTransaction(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  params: {
    workspaceId: string;
    roleId: string;
    memberId: string;
    assignment?: { id: string };
  },
) {
  const assignment = params.assignment ?? await tx.roleAssignment.findUnique({
    where: {
      roleId_memberId: {
        roleId: params.roleId,
        memberId: params.memberId,
      },
    },
  });
  invariant(assignment, 404, "NOT_FOUND", "Role assignment not found.");

  await tx.roleAssignment.delete({
    where: { id: assignment.id },
  });

  await endRoleHolderHistory(tx, {
    workspaceId: params.workspaceId,
    roleId: params.roleId,
    memberId: params.memberId,
    actor,
  });

  await dismissRoleOnboardingForAssignment(tx, {
    workspaceId: params.workspaceId,
    roleId: params.roleId,
    memberId: params.memberId,
  });

  await tx.auditLog.create({
    data: {
      workspaceId: params.workspaceId,
      actorUserId: actorUserId(actor),
      action: "role.unassigned",
      entityType: "RoleAssignment",
      entityId: assignment.id,
      meta: { roleId: params.roleId, memberId: params.memberId },
    },
  });

  await appendEvents(tx, [
    {
      workspaceId: params.workspaceId,
      type: "role.unassigned",
      aggregateType: "RoleAssignment",
      aggregateId: assignment.id,
      payload: {
        roleId: params.roleId,
        memberId: params.memberId,
        assignmentId: assignment.id,
      },
    },
  ]);

  return { id: assignment.id };
}

export async function listRoleAssignments(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const assignments = await prisma.roleAssignment.findMany({
    where: {
      role: {
        circle: {
          workspaceId,
          archivedAt: null,
        },
        archivedAt: null,
      },
    },
    include: {
      role: {
        include: { circle: true },
      },
      member: {
        include: {
          user: { select: { id: true, email: true, displayName: true, bio: true } },
        },
      },
    },
  });
  const visibleRoles = await readableArtifactIds(actor, workspaceId, "Role", assignments.map((assignment) => assignment.role));
  const admitted = await filterReadableRoleAssignments(actor, workspaceId,
    assignments.filter((assignment) => visibleRoles.has(assignment.roleId)));
  const visibleCircles = await readableArtifactIds(actor, workspaceId, "Circle", admitted.map((assignment) => assignment.role.circle));
  return admitted
    .sort((left, right) => right.assignedAt.getTime() - left.assignedAt.getTime())
    .map((assignment) => ({ ...assignment,
      role: { id: assignment.role.id, name: assignment.role.name,
        circle: visibleCircles.has(assignment.role.circleId)
          ? { id: assignment.role.circle.id, name: assignment.role.circle.name } : null },
      member: { ...assignment.member, user: { id: assignment.member.user.id,
        email: assignment.member.user.email, displayName: assignment.member.user.displayName } },
    }));
}
