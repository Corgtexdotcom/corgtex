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
      notificationPreference: {
        upsert: vi.fn(),
        deleteMany: vi.fn(),
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
        linkedinUrl: "https://www.linkedin.com/in/test",
        websiteUrl: "https://example.com",
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
      expect(profile.user.linkedinUrl).toBe("https://www.linkedin.com/in/test");
      expect(profile.user.websiteUrl).toBe("https://example.com");
      expect(profile.member!.role).toBe("ADMIN");
    });
  });

  describe("updateUserProfile", () => {
    it("updates display name and bio", async () => {
      vi.mocked(prisma.user.update).mockResolvedValue({
        id: "u1",
        displayName: "New Name",
        bio: "New Bio",
        linkedinUrl: null,
        websiteUrl: null,
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
          linkedinUrl: true,
          websiteUrl: true,
        },
      });
      expect(result.displayName).toBe("New Name");
    });

    it("saves valid profile links", async () => {
      vi.mocked(prisma.user.update).mockResolvedValue({
        id: "u1",
        linkedinUrl: "https://www.linkedin.com/in/test",
        websiteUrl: "https://example.com/about",
      } as any);

      await updateUserProfile(mockActor as any, {
        linkedinUrl: " https://www.linkedin.com/in/test ",
        websiteUrl: "https://example.com/about",
      });

      expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
        data: {
          linkedinUrl: "https://www.linkedin.com/in/test",
          websiteUrl: "https://example.com/about",
        },
      }));
    });

    it("clears blank profile links", async () => {
      vi.mocked(prisma.user.update).mockResolvedValue({
        id: "u1",
        linkedinUrl: null,
        websiteUrl: null,
      } as any);

      await updateUserProfile(mockActor as any, {
        linkedinUrl: " ",
        websiteUrl: "",
      });

      expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
        data: {
          linkedinUrl: null,
          websiteUrl: null,
        },
      }));
    });

    it("rejects non-https profile links", async () => {
      await expect(updateUserProfile(mockActor as any, {
        linkedinUrl: "http://www.linkedin.com/in/test",
      })).rejects.toMatchObject({
        status: 400,
        code: "INVALID_PROFILE_URL",
      });

      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe("updateNotificationPreference", () => {
    it("deletes the override when channel is USE_DEFAULT", async () => {
      const { updateNotificationPreference } = await import("./user-profile");
      await expect(updateNotificationPreference(mockActor as any, {
        notifType: "deliberation.mention",
        channel: "USE_DEFAULT",
      })).resolves.toBeNull();

      expect(prisma.notificationPreference.deleteMany).toHaveBeenCalledWith({
        where: {
          userId: "u1",
          notifType: "deliberation.mention",
        },
      });
      expect(prisma.notificationPreference.upsert).not.toHaveBeenCalled();
    });

    it("stores valid notification preference channels", async () => {
      vi.mocked(prisma.notificationPreference.upsert).mockResolvedValue({
        id: "pref-1",
        userId: "u1",
        notifType: "deliberation.mention",
        channel: "IN_APP",
      } as any);

      const { updateNotificationPreference } = await import("./user-profile");
      await expect(updateNotificationPreference(mockActor as any, {
        notifType: "deliberation.mention",
        channel: "IN_APP",
      })).resolves.toMatchObject({ id: "pref-1" });

      expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          userId_notifType: {
            userId: "u1",
            notifType: "deliberation.mention",
          },
        },
      }));
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

    it("stores an off newspaper cadence override", async () => {
      vi.mocked(prisma.member.update).mockResolvedValue({
        id: "m1",
        newspaperCadence: "OFF",
      } as any);

      await expect(updateMemberNewspaperCadencePreference(mockActor as any, {
        workspaceId: "w1",
        cadence: "OFF",
      })).resolves.toEqual({
        id: "m1",
        newspaperCadence: "OFF",
      });

      expect(prisma.member.update).toHaveBeenCalledWith({
        where: { id: "m1" },
        data: { newspaperCadence: "OFF" },
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
