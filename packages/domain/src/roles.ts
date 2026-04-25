import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";

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

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "Role",
    entityId: params.roleId,
    reason: "Archived from role delete path.",
  });

  return { id: params.roleId };
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
      include: { circle: { select: { workspaceId: true } } },
    });
    invariant(role && role.circle.workspaceId === params.workspaceId && !role.archivedAt, 404, "NOT_FOUND", "Role not found.");

    const member = await tx.member.findUnique({
      where: { id: params.memberId },
    });
    invariant(member && member.workspaceId === params.workspaceId && member.isActive, 404, "NOT_FOUND", "Member not found.");

    const assignment = await tx.roleAssignment.upsert({
      where: {
        roleId_memberId: {
          roleId: params.roleId,
          memberId: params.memberId,
        },
      },
      update: {},
      create: {
        roleId: params.roleId,
        memberId: params.memberId,
      },
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
