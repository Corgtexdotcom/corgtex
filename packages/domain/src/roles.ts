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
    if (params.name !== undefined) {
      const name = params.name.trim();
      invariant(name.length > 0, 400, "INVALID_INPUT", "Role name is required.");
      data.name = name;
    }
    if (params.purposeMd !== undefined) data.purposeMd = params.purposeMd?.trim() || null;
    if (params.accountabilities !== undefined) {
      data.accountabilities = params.accountabilities.map((v) => v.trim()).filter(Boolean);
    }
    if (params.artifacts !== undefined) {
      data.artifacts = params.artifacts.map((v) => v.trim()).filter(Boolean);
    }
    if (params.coreRoleType !== undefined) {
      data.coreRoleType = params.coreRoleType?.trim() || null;
    }

    const updated = await tx.role.update({
      where: { id: params.roleId },
      data,
      include: { circle: { select: { id: true, name: true } } },
    });

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
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["FACILITATOR", "ADMIN"],
  });

  return prisma.$transaction(async (tx) => {
    const role = await tx.role.findUnique({
      where: { id: params.roleId },
      include: {
        circle: {
          select: {
            id: true,
            workspaceId: true,
            name: true,
            purposeMd: true,
            domainMd: true,
          },
        },
      },
    });
    invariant(role && role.circle.workspaceId === params.workspaceId && !role.archivedAt, 404, "NOT_FOUND", "Role not found.");

    const member = await tx.member.findUnique({
      where: { id: params.memberId },
      include: {
        user: {
          select: {
            displayName: true,
            email: true,
          },
        },
      },
    });
    invariant(member && member.workspaceId === params.workspaceId && member.isActive, 404, "NOT_FOUND", "Member not found.");

    const assignmentKey = {
      roleId: params.roleId,
      memberId: params.memberId,
    };
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext('role_assignment'), hashtext(${`${assignmentKey.roleId}:${assignmentKey.memberId}`}))
    `;
    const existingAssignment = await tx.roleAssignment.findUnique({
      where: {
        roleId_memberId: assignmentKey,
      },
    });

    const assignment = await tx.roleAssignment.upsert({
      where: {
        roleId_memberId: assignmentKey,
      },
      update: {},
      create: assignmentKey,
    });

    if (!existingAssignment) {
      await startRoleHolderHistory(tx, {
        workspaceId: params.workspaceId,
        roleId: params.roleId,
        memberId: params.memberId,
        assignmentId: assignment.id,
        actor,
      });
    }

    const onboarding = await ensureRoleOnboardingForAssignment(tx, {
      workspaceId: params.workspaceId,
      role,
      member,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "role.assigned",
        entityType: "RoleAssignment",
        entityId: assignment.id,
        meta: { roleId: params.roleId, memberId: params.memberId },
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
            roleId: params.roleId,
            memberId: params.memberId,
            assignmentId: assignment.id,
            onboardingSessionId: onboarding.id,
            conversationId: onboarding.conversationId,
          },
        },
      ]);
    }

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
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext('role_assignment'), hashtext(${`${params.roleId}:${params.memberId}`}))
    `;
    const role = await tx.role.findUnique({
      where: { id: params.roleId },
      include: { circle: { select: { workspaceId: true } } },
    });
    invariant(role && role.circle.workspaceId === params.workspaceId && !role.archivedAt, 404, "NOT_FOUND", "Role not found.");

    const assignment = await tx.roleAssignment.findUnique({
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
        actorUserId: actor.kind === "user" ? actor.user.id : null,
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
  });
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
