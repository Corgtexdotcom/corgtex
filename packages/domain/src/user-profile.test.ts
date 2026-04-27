import { describe, expect, it, vi, beforeEach } from "vitest";
import { getUserProfile, updateUserProfile } from "./user-profile";
import { prisma } from "@corgtex/shared";

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
      },
    },
  };
});

describe("User Profile Domain", () => {
  const mockActor = {
    kind: "user" as const,
    user: { id: "u1", email: "test@example.com", displayName: "Test", globalRole: "USER" as any },
  };

  beforeEach(() => {
    vi.clearAllMocks();
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
        data: { displayName: "New Name", bio: "New Bio", avatarUrl: undefined },
      });
      expect(result.displayName).toBe("New Name");
    });
  });
});
