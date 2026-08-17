import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, ensureCanonicalWorkspaceMock, assertNonReservedWorkspaceSystemEmailMock, baselineTx } = vi.hoisted(() => ({
  baselineTx: { label: "baseline-tx" },
  ensureCanonicalWorkspaceMock: vi.fn(),
  assertNonReservedWorkspaceSystemEmailMock: vi.fn(),
  prismaMock: {
    disconnect: vi.fn(),
    transaction: vi.fn(),
    userFindUnique: vi.fn(),
    userCreate: vi.fn(),
    memberUpsert: vi.fn(),
    auditLogFindFirst: vi.fn(),
    auditLogCreate: vi.fn(),
  },
}));

vi.mock("../../packages/domain/src/workspaces.ts", () => ({
  assertNonReservedWorkspaceSystemEmail: assertNonReservedWorkspaceSystemEmailMock,
  ensureCanonicalWorkspace: ensureCanonicalWorkspaceMock,
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn().mockImplementation(function PrismaClient() {
    return {
      $disconnect: prismaMock.disconnect,
      $transaction: prismaMock.transaction,
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
    ensureCanonicalWorkspaceMock.mockResolvedValue({ id: "workspace-1", slug: "validation" });
    prismaMock.transaction.mockImplementation(async (callback) => callback(baselineTx));
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

  it("uses one short canonical baseline transaction before idempotent fixture writes", async () => {
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

    expect(prismaMock.transaction).toHaveBeenCalledTimes(1);
    expect(assertNonReservedWorkspaceSystemEmailMock).toHaveBeenCalledWith("validation@example.com");
    expect(ensureCanonicalWorkspaceMock).toHaveBeenCalledWith(baselineTx, {
      slug: "validation",
      name: "Validation Workspace",
      description: "Synthetic validation workspace",
      update: {
        name: "Validation Workspace",
        description: "Synthetic validation workspace",
      },
    });
    expect(prismaMock.auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        action: "validation.seeded",
      }),
    }));
    expect(prismaMock.disconnect).toHaveBeenCalled();
  });
});
