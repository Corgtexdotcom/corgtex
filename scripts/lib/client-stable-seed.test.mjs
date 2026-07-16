import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  disconnect: vi.fn(),
  transaction: vi.fn(),
  workspaceUpsert: vi.fn(),
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  memberUpsert: vi.fn(),
  auditLogFindFirst: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn().mockImplementation(function PrismaClient() {
    return {
      $disconnect: prismaMock.disconnect,
      $transaction: prismaMock.transaction,
      workspace: {
        upsert: prismaMock.workspaceUpsert,
      },
      user: {
        findUnique: prismaMock.userFindUnique,
        create: prismaMock.userCreate,
      },
      member: {
        upsert: prismaMock.memberUpsert,
      },
      auditLog: {
        findFirst: prismaMock.auditLogFindFirst,
        create: prismaMock.auditLogCreate,
      },
    };
  }),
}));

describe("seedStableClient", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.CLIENT_BOOTSTRAP_ADMIN_EMAIL = "validation@example.com";
    process.env.ADMIN_PASSWORD = "validation-password";
    process.env.CLIENT_SEED_SAMPLE_DATA = "false";

    prismaMock.disconnect.mockResolvedValue(undefined);
    prismaMock.transaction.mockRejectedValue(new Error("stable client seed must not use a broad transaction"));
    prismaMock.workspaceUpsert.mockResolvedValue({ id: "workspace-1", slug: "validation" });
    prismaMock.userFindUnique.mockResolvedValue(null);
    prismaMock.userCreate.mockResolvedValue({
      id: "user-1",
      email: "validation@example.com",
      displayName: "Validation Admin",
    });
    prismaMock.memberUpsert.mockResolvedValue({ id: "member-1", role: "ADMIN" });
    prismaMock.auditLogFindFirst.mockResolvedValue(null);
    prismaMock.auditLogCreate.mockResolvedValue({ id: "audit-1" });
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.env = originalEnv;
  });

  it("uses idempotent direct writes instead of one long interactive transaction", async () => {
    const { seedStableClient } = await import("./client-stable-seed.mjs");

    await seedStableClient({
      envPrefix: "CLIENT",
      defaultLocale: "en",
      workspace: {
        slug: "validation",
        name: "Validation Workspace",
        description: "Synthetic validation workspace",
      },
      invite: {
        subject: "Validation access",
        title: "Validation access",
        greeting: "Hi {name},",
        body: "Use the workspace for validation.",
        button: "Set up access",
        fallbackName: "there",
      },
      featureFlags: {},
      approvalPolicies: [],
      circles: [],
      roles: [],
      roleAssignmentsByMemberRole: {},
      auditAction: "validation.seeded",
    });

    expect(prismaMock.transaction).not.toHaveBeenCalled();
    expect(prismaMock.workspaceUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { slug: "validation" },
    }));
    expect(prismaMock.auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        action: "validation.seeded",
      }),
    }));
    expect(prismaMock.disconnect).toHaveBeenCalled();
  });
});
