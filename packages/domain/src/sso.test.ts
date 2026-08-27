import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    userSsoIdentity: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    member: {
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@corgtex/shared", () => ({
  env: { DEPLOYMENT_WORKSPACE_SCOPE_SLUG: undefined },
  hashPassword: vi.fn(),
  normalizeWorkspaceSlug: (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-"),
  prisma: prismaMock,
  randomOpaqueToken: vi.fn(),
  sha256: vi.fn(),
  verifyPassword: vi.fn(),
}));

describe("SSO user provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a reserved canonical victim email before linking identity, membership, or user", async () => {
    const { linkOrProvisionSsoUser } = await import("./sso");

    await expect(linkOrProvisionSsoUser({
      workspaceId: "workspace-b",
      provider: "GOOGLE",
      providerSubjectId: "attacker-subject",
      email: "SYSTEM+WORKSPACE-A@CORGTEX.LOCAL",
      displayName: "Not System",
    })).rejects.toMatchObject({ code: "CANONICAL_SYSTEM_ACTOR_COLLISION" });

    expect(prismaMock.userSsoIdentity.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.userSsoIdentity.upsert).not.toHaveBeenCalled();
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.user.create).not.toHaveBeenCalled();
    expect(prismaMock.member.upsert).not.toHaveBeenCalled();
  });
});
