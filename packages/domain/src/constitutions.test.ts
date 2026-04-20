import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, requireWorkspaceMembershipMock } = vi.hoisted(() => ({
  prismaMock: {
    constitution: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    approvalPolicy: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  requireWorkspaceMembershipMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

import { createConstitutionVersion, updateApprovalPolicy } from "./constitutions";

describe("createConstitutionVersion", () => {
  beforeEach(() => {
    prismaMock.constitution.findFirst.mockReset().mockResolvedValue(null);
    prismaMock.constitution.create.mockReset();
  });

  it("retries when version allocation races on the workspace/version unique key", async () => {
    prismaMock.constitution.findFirst
      .mockResolvedValueOnce({ version: 1 })
      .mockResolvedValueOnce({ version: 2 });

    prismaMock.constitution.create
      .mockRejectedValueOnce({
        code: "P2002",
        meta: {
          target: ["workspaceId", "version"],
        },
      })
      .mockResolvedValueOnce({
        id: "constitution-3",
        version: 3,
      });

    await expect(createConstitutionVersion({
      workspaceId: "ws-1",
      bodyMd: "# Constitution",
      modelUsed: "gpt-test",
    })).resolves.toEqual({
      id: "constitution-3",
      version: 3,
    });

    expect(prismaMock.constitution.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        workspaceId: "ws-1",
        version: 2,
      }),
    });
    expect(prismaMock.constitution.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        workspaceId: "ws-1",
        version: 3,
      }),
    });
  });
});

describe("updateApprovalPolicy", () => {
  beforeEach(() => {
    requireWorkspaceMembershipMock.mockReset().mockResolvedValue({
      workspaceId: "ws-1",
      userId: "user-1",
      role: "ADMIN",
      isActive: true,
    });
    prismaMock.approvalPolicy.findUnique.mockReset().mockResolvedValue({
      id: "policy-1",
    });
    prismaMock.approvalPolicy.update.mockReset().mockResolvedValue({
      id: "policy-1",
      mode: "MAJORITY",
    });
  });

  it("requires facilitator or admin membership before mutating governance policy", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "admin@example.com",
        displayName: "Admin",
      },
    };

    await updateApprovalPolicy(actor, {
      workspaceId: "ws-1",
      subjectType: "PROPOSAL",
      mode: "MAJORITY",
    });

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor,
      workspaceId: "ws-1",
      allowedRoles: ["FACILITATOR", "ADMIN"],
    });
  });
});
