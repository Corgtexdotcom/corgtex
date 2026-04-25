import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    role: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    circle: {
      findUnique: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
    },
    roleAssignment: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
  };
  return { prismaMock: prisma };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  env: {
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
  },
}));

const actor: AppActor = {
  kind: "user" as const,
  user: {
    id: "operator-1",
    email: "operator@example.com",
    displayName: "Operator",
    globalRole: "OPERATOR",
  },
};

describe("roles domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
  });

  it("listRoles scopes roles by workspace through circles", async () => {
    prismaMock.role.findMany.mockResolvedValue([{ id: "role-1" }]);

    const { listRoles } = await import("./roles");
    await expect(listRoles("workspace-1")).resolves.toEqual([{ id: "role-1" }]);
    expect(prismaMock.role.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        circle: {
          workspaceId: "workspace-1",
        },
      },
    }));
  });

  it("createRole creates a role with trimmed fields", async () => {
    prismaMock.circle.findUnique.mockResolvedValue({ id: "circle-1", workspaceId: "workspace-1" });
    prismaMock.role.count.mockResolvedValue(2);
    prismaMock.role.create.mockResolvedValue({ id: "role-1", name: "Lead", circle: { id: "circle-1", name: "Circle" } });

    const { createRole } = await import("./roles");
    await expect(createRole(actor, {
      workspaceId: "workspace-1",
      circleId: "circle-1",
      name: " Lead ",
      purposeMd: " Purpose ",
      accountabilities: [" A ", " "],
      artifacts: [" Artifact "],
      coreRoleType: " Core ",
    })).resolves.toMatchObject({ id: "role-1", name: "Lead" });

    expect(prismaMock.role.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: "Lead",
        purposeMd: "Purpose",
        accountabilities: ["A"],
        artifacts: ["Artifact"],
        coreRoleType: "Core",
        sortOrder: 2,
      }),
    }));
  });

  it("createRole rejects a blank name", async () => {
    const { createRole } = await import("./roles");
    await expect(createRole(actor, {
      workspaceId: "workspace-1",
      circleId: "circle-1",
      name: " ",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
  });

  it("createRole rejects a circle outside the workspace", async () => {
    prismaMock.circle.findUnique.mockResolvedValue(null);

    const { createRole } = await import("./roles");
    await expect(createRole(actor, {
      workspaceId: "workspace-1",
      circleId: "missing-circle",
      name: "Lead",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("updateRole updates provided fields", async () => {
    prismaMock.role.findUnique.mockResolvedValue({ id: "role-1", circle: { workspaceId: "workspace-1" } });
    prismaMock.role.update.mockResolvedValue({ id: "role-1", name: "Updated" });

    const { updateRole } = await import("./roles");
    await expect(updateRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
      name: " Updated ",
    })).resolves.toEqual({ id: "role-1", name: "Updated" });
    expect(prismaMock.role.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { name: "Updated" },
    }));
  });

  it("deleteRole deletes an existing role", async () => {
    prismaMock.role.findUnique.mockResolvedValue({ id: "role-1", name: "Lead", circle: { workspaceId: "workspace-1" } });
    prismaMock.role.delete.mockResolvedValue({ id: "role-1" });

    const { deleteRole } = await import("./roles");
    await expect(deleteRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
    })).resolves.toEqual({ id: "role-1" });
  });

  it("deleteRole rejects a missing role", async () => {
    prismaMock.role.findUnique.mockResolvedValue(null);

    const { deleteRole } = await import("./roles");
    await expect(deleteRole(actor, {
      workspaceId: "workspace-1",
      roleId: "missing-role",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("assignRole upserts an assignment", async () => {
    prismaMock.role.findUnique.mockResolvedValue({ id: "role-1", circle: { workspaceId: "workspace-1" } });
    prismaMock.member.findUnique.mockResolvedValue({ id: "member-1", workspaceId: "workspace-1", isActive: true });
    prismaMock.roleAssignment.upsert.mockResolvedValue({ id: "assignment-1" });

    const { assignRole } = await import("./roles");
    await expect(assignRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
      memberId: "member-1",
    })).resolves.toEqual({ id: "assignment-1" });
  });

  it("assignRole rejects a missing member", async () => {
    prismaMock.role.findUnique.mockResolvedValue({ id: "role-1", circle: { workspaceId: "workspace-1" } });
    prismaMock.member.findUnique.mockResolvedValue(null);

    const { assignRole } = await import("./roles");
    await expect(assignRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
      memberId: "missing-member",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("unassignRole deletes an existing assignment", async () => {
    prismaMock.role.findUnique.mockResolvedValue({ id: "role-1", circle: { workspaceId: "workspace-1" } });
    prismaMock.roleAssignment.findUnique.mockResolvedValue({ id: "assignment-1" });
    prismaMock.roleAssignment.delete.mockResolvedValue({ id: "assignment-1" });

    const { unassignRole } = await import("./roles");
    await expect(unassignRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
      memberId: "member-1",
    })).resolves.toEqual({ id: "assignment-1" });
  });

  it("listRoleAssignments returns assignments for workspace roles", async () => {
    prismaMock.roleAssignment.findMany.mockResolvedValue([{ id: "assignment-1" }]);

    const { listRoleAssignments } = await import("./roles");
    await expect(listRoleAssignments("workspace-1")).resolves.toEqual([{ id: "assignment-1" }]);
    expect(prismaMock.roleAssignment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        role: {
          circle: {
            workspaceId: "workspace-1",
          },
        },
      },
    }));
  });
});
