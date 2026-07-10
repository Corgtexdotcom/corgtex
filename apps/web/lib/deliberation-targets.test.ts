import { describe, expect, it, vi } from "vitest";

const { prismaMock, humanMemberIdentityWhereMock } = vi.hoisted(() => ({
  prismaMock: {
    circle: {
      findMany: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
  humanMemberIdentityWhereMock: vi.fn(() => ({ NOT: [{ kind: "SYSTEM" }] })),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("@corgtex/domain", () => ({
  humanMemberIdentityWhere: humanMemberIdentityWhereMock,
}));

describe("getDeliberationTargets", () => {
  it("filters member targets through the shared human identity helper", async () => {
    prismaMock.circle.findMany.mockResolvedValue([{ id: "circle-1", name: "General" }]);
    prismaMock.member.findMany.mockResolvedValue([
      {
        id: "member-1",
        user: {
          displayName: "Human Member",
          email: "human@example.com",
        },
      },
    ]);
    prismaMock.member.findUnique.mockResolvedValue(null);

    const { getDeliberationTargets } = await import("./deliberation-targets");
    const result = await getDeliberationTargets({
      actor: {
        kind: "user",
        user: {
          id: "user-1",
          email: "user@example.com",
          displayName: "Requester",
          globalRole: "USER",
        },
      },
      workspaceId: "workspace-1",
    });

    expect(humanMemberIdentityWhereMock).toHaveBeenCalled();
    expect(prismaMock.member.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        isActive: true,
        NOT: [{ kind: "SYSTEM" }],
      }),
    }));
    expect(result.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "member:member-1", kind: "member", name: "Human Member" }),
    ]));
  });
});
