import { describe, expect, it, vi } from "vitest";
import { checkArtifactPermission } from "./artifact-permissions";
import { prisma } from "@corgtex/shared";

vi.mock("@corgtex/shared", () => ({
  prisma: {
    role: {
      findMany: vi.fn(),
    },
  },
}));

describe("checkArtifactPermission", () => {
  const workspaceId = "ws-1";
  const artifactName = "website_admin";

  it("allows action when no role claims the artifact", async () => {
    vi.mocked(prisma.role.findMany).mockResolvedValueOnce([]);

    const result = await checkArtifactPermission({
      workspaceId,
      artifactName,
      actorMemberId: "member-1",
    });

    expect(result.allowed).toBe(true);
    expect(result.gatekeeperRoleId).toBeUndefined();
  });

  it("allows action when actor holds the role with the artifact", async () => {
    vi.mocked(prisma.role.findMany).mockResolvedValueOnce([
      {
        id: "role-1",
        circleId: "circle-1",
        name: "Webmaster",
        purposeMd: null,
        accountabilities: [],
        artifacts: ["website_admin"],
        metricsMd: null,
        isCoreRole: false,
        coreRoleType: null,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        assignments: [
          { memberId: "member-1" },
        ],
      } as any,
    ]);

    const result = await checkArtifactPermission({
      workspaceId,
      artifactName,
      actorMemberId: "member-1",
    });

    expect(result.allowed).toBe(true);
  });

  it("blocks action when artifact is owned by a different role", async () => {
    vi.mocked(prisma.role.findMany).mockResolvedValueOnce([
      {
        id: "role-1",
        circleId: "circle-1",
        name: "Webmaster",
        purposeMd: null,
        accountabilities: [],
        artifacts: ["website_admin"],
        metricsMd: null,
        isCoreRole: false,
        coreRoleType: null,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        assignments: [
          { memberId: "member-2" }, // Gatekeeper is someone else
        ],
      } as any,
    ]);

    const result = await checkArtifactPermission({
      workspaceId,
      artifactName,
      actorMemberId: "member-1", // Not the gatekeeper
    });

    expect(result.allowed).toBe(false);
    expect(result.gatekeeperRoleId).toBe("role-1");
    expect(result.gatekeeperMemberIds).toEqual(["member-2"]);
  });
});
