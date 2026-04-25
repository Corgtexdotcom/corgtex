import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    workspace: {
      findUnique: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
    },
    member: {
      create: vi.fn(),
    },
    approvalPolicy: {
      createMany: vi.fn(),
    },
  };
  return { prismaMock: prisma };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

const actor: AppActor = {
  kind: "user" as const,
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
  },
};

describe("workspaces domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.member.create.mockResolvedValue({});
    prismaMock.approvalPolicy.createMany.mockResolvedValue({ count: 2 });
  });

  it("createWorkspace creates a workspace with owner membership and default policies", async () => {
    prismaMock.workspace.findUnique.mockResolvedValue(null);
    prismaMock.workspace.create.mockResolvedValue({ id: "workspace-1", slug: "new-workspace", name: "New Workspace" });

    const { createWorkspace } = await import("./workspaces");
    await expect(createWorkspace(actor, {
      name: " New Workspace ",
      slug: "New Workspace!",
      description: " Description ",
    })).resolves.toEqual({ id: "workspace-1", slug: "new-workspace", name: "New Workspace" });

    expect(prismaMock.workspace.create).toHaveBeenCalledWith({
      data: {
        name: "New Workspace",
        slug: "new-workspace-",
        description: "Description",
      },
    });
    expect(prismaMock.member.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace-1",
        userId: "user-1",
        role: "ADMIN",
        isActive: true,
      },
    });
  });

  it("createWorkspace rejects a missing name", async () => {
    const { createWorkspace } = await import("./workspaces");
    await expect(createWorkspace(actor, {
      name: " ",
      slug: "workspace",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
  });

  it("listWorkspaces returns active user workspaces", async () => {
    prismaMock.workspace.findMany.mockResolvedValue([{ id: "workspace-1" }]);

    const { listWorkspaces } = await import("./workspaces");
    await expect(listWorkspaces(actor)).resolves.toEqual([{ id: "workspace-1" }]);
    expect(prismaMock.workspace.findMany).toHaveBeenCalledWith({
      where: {
        members: {
          some: {
            userId: "user-1",
            isActive: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  });
});
