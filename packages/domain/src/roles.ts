import { prisma } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";
import {
  closeRoleLifecycleForRoles,
  createRoleVersionSnapshot,
  dismissRoleOnboardingForAssignment,
  endRoleHolderHistory,
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

export async function listRoles(workspaceId: string, opts?: { archiveFilter?: ArchiveFilter }) {
  return prisma.role.findMany({
    where: {
      ...archiveFilterWhere(opts?.archiveFilter),
      circle: {
        workspaceId,
        archivedAt: null,
      },
    },
    include: {
      circle: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: [{ circle: { sortOrder: "asc" } }, { sortOrder: "asc" }, { createdAt: "asc" }],
  });
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
      circle: {
        select: {
          id: true,
          name: true,
          purposeMd: true,
          domainMd: true,
          maturityStage: true,
        },
      },
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
        orderBy: { assignedAt: "desc" },
      },
    },
  });

  invariant(role, 404, "NOT_FOUND", "Role not found.");
  return role;
}

export async function createRole(actor: AppActor, params: {
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
        circle: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

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

    return role;
  });
}

export async function updateRole(actor: AppActor, params: {
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
        include: { circle: { select: { id: true, name: true } } },
      });
      invariant(unchanged, 404, "NOT_FOUND", "Role not found.");
      return unchanged;
    }

    const updated = await tx.role.update({
      where: { id: params.roleId },
      data,
      include: { circle: { select: { id: true, name: true } } },
    });

    if (movedRole) {
      const now = new Date();
      await tx.roleHolderHistory.updateMany({
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

    return updated;
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

export async function listRoleAssignments(workspaceId: string) {
  return prisma.roleAssignment.findMany({
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
        select: { id: true, name: true, circle: { select: { id: true, name: true } } },
      },
      member: {
        include: {
          user: { select: { id: true, email: true, displayName: true } },
        },
      },
    },
    orderBy: { assignedAt: "desc" },
  });
}
