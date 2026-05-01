import { describe, expect, it, vi, beforeEach } from "vitest";
import { getUserProfile, updateMemberNewspaperCadencePreference, updateUserProfile } from "./user-profile";
import { prisma } from "@corgtex/shared";

const requireWorkspaceMembershipMock = vi.hoisted(() => vi.fn());

vi.mock("@corgtex/shared", async () => {
  const actual = await vi.importActual("@corgtex/shared");
  return {
    ...actual,
    prisma: {
      user: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      member: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    },
  };
});

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

describe("User Profile Domain", () => {
  const mockActor = {
    kind: "user" as const,
    user: { id: "u1", email: "test@example.com", displayName: "Test", globalRole: "USER" as any },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMembershipMock.mockResolvedValue({
      id: "m1",
      workspaceId: "w1",
      userId: "u1",
      role: "CONTRIBUTOR",
      isActive: true,
    });
  });

  describe("getUserProfile", () => {
    it("returns combined user and member profile data", async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: "u1",
        email: "test@example.com",
        displayName: "Test",
        bio: "Bio",
        avatarUrl: null,
        createdAt: new Date(),
        ssoIdentities: [],
      } as any);

      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        id: "m1",
        role: "ADMIN",
        joinedAt: new Date(),
        circles: [],
        expertiseTags: [],
        recognitions: [],
      } as any);

      const profile = await getUserProfile(mockActor as any, "w1");
      expect(profile.user.email).toBe("test@example.com");
      expect(profile.member!.role).toBe("ADMIN");
    });
  });

  describe("updateUserProfile", () => {
    it("updates display name and bio", async () => {
      vi.mocked(prisma.user.update).mockResolvedValue({
        id: "u1",
        displayName: "New Name",
        bio: "New Bio",
      } as any);

      const result = await updateUserProfile(mockActor as any, { displayName: "New Name", bio: "New Bio" });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: { displayName: "New Name", bio: "New Bio" },
        select: {
          id: true,
          email: true,
          displayName: true,
          bio: true,
          avatarUrl: true,
        },
      });
      expect(result.displayName).toBe("New Name");
    });
  });

  describe("updateMemberNewspaperCadencePreference", () => {
    it("stores a member newspaper cadence override", async () => {
      vi.mocked(prisma.member.update).mockResolvedValue({
        id: "m1",
        newspaperCadence: "WEEKLY",
      } as any);

      await expect(updateMemberNewspaperCadencePreference(mockActor as any, {
        workspaceId: "w1",
        cadence: "WEEKLY",
      })).resolves.toEqual({
        id: "m1",
        newspaperCadence: "WEEKLY",
      });

      expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
        actor: mockActor,
        workspaceId: "w1",
      });
      expect(prisma.member.update).toHaveBeenCalledWith({
        where: { id: "m1" },
        data: { newspaperCadence: "WEEKLY" },
        select: {
          id: true,
          newspaperCadence: true,
        },
      });
    });

    it("clears the override when the member chooses the workspace default", async () => {
      vi.mocked(prisma.member.update).mockResolvedValue({
        id: "m1",
        newspaperCadence: null,
      } as any);

      await updateMemberNewspaperCadencePreference(mockActor as any, {
        workspaceId: "w1",
        cadence: null,
      });

      expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
        data: { newspaperCadence: null },
      }));
    });
  });
});
