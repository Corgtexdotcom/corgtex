import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    procurementTrial: {
      findUnique: vi.fn(),
    },
    member: {
      count: vi.fn(),
    },
    document: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  checkRateLimit: vi.fn(),
}));

describe("trial entitlements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.procurementTrial.findUnique.mockResolvedValue({
      id: "trial-1",
      workspaceId: "workspace-1",
      agentCredentialId: null,
      status: "ACTIVE",
      trialExpiresAt: new Date(Date.now() + 60_000),
      memberLimit: 5,
      storageLimitMb: 100,
      mcpDailyCallLimit: 100,
    });
    prismaMock.member.count.mockResolvedValue(4);
    prismaMock.document.findMany.mockResolvedValue([]);
  });

  it("excludes internal support members from trial member capacity", async () => {
    const { assertTrialMemberCapacity } = await import("./trial-entitlements");

    await expect(assertTrialMemberCapacity("workspace-1")).resolves.toBeUndefined();

    expect(prismaMock.member.count).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        isActive: true,
        NOT: {
          user: {
            email: {
              startsWith: "support+",
              endsWith: "@corgtex.local",
            },
          },
        },
      },
    });
  });

  it("uses the caller transaction and locks before calculating trial storage usage", async () => {
    const order: string[] = [];
    const tx = {
      procurementTrial: {
        findUnique: vi.fn(async () => {
          order.push("trial");
          return {
            id: "trial-1",
            workspaceId: "workspace-1",
            agentCredentialId: null,
            status: "ACTIVE",
            trialExpiresAt: new Date(Date.now() + 60_000),
            memberLimit: 5,
            storageLimitMb: 1,
            mcpDailyCallLimit: 100,
          };
        }),
      },
      $executeRaw: vi.fn(async () => {
        order.push("lock");
        return 1;
      }),
      document: {
        findMany: vi.fn(async () => {
          order.push("usage");
          return [{ id: "document-1", metadata: { size: 512 * 1024 } }];
        }),
      },
    };
    const { lockAndAssertTrialStorageCapacity } = await import("./trial-entitlements");

    await expect(lockAndAssertTrialStorageCapacity(
      tx as any,
      "workspace-1",
      512 * 1024,
    )).resolves.toBeUndefined();

    expect(order).toEqual(["trial", "lock", "usage"]);
    expect(prismaMock.procurementTrial.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.document.findMany).not.toHaveBeenCalled();
  });

  it("rejects storage above the exact trial limit", async () => {
    const tx = {
      procurementTrial: {
        findUnique: vi.fn().mockResolvedValue({
          id: "trial-1",
          workspaceId: "workspace-1",
          agentCredentialId: null,
          status: "ACTIVE",
          trialExpiresAt: new Date(Date.now() + 60_000),
          memberLimit: 5,
          storageLimitMb: 1,
          mcpDailyCallLimit: 100,
        }),
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
      document: {
        findMany: vi.fn().mockResolvedValue([
          { id: "document-1", metadata: { size: 512 * 1024 } },
        ]),
      },
    };
    const { lockAndAssertTrialStorageCapacity } = await import("./trial-entitlements");

    await expect(lockAndAssertTrialStorageCapacity(
      tx as any,
      "workspace-1",
      512 * 1024 + 1,
    )).rejects.toMatchObject({ code: "TRIAL_STORAGE_LIMIT_EXCEEDED" });
  });

  it("counts only the replacement document's net size change", async () => {
    const tx = {
      procurementTrial: {
        findUnique: vi.fn().mockResolvedValue({
          id: "trial-1",
          workspaceId: "workspace-1",
          agentCredentialId: null,
          status: "ACTIVE",
          trialExpiresAt: new Date(Date.now() + 60_000),
          memberLimit: 5,
          storageLimitMb: 1,
          mcpDailyCallLimit: 100,
        }),
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
      document: {
        findMany: vi.fn().mockResolvedValue([
          { id: "document-replaced", metadata: { size: 512 * 1024 } },
          { id: "document-other", metadata: { size: 256 * 1024 } },
        ]),
      },
    };
    const { lockAndAssertTrialStorageCapacity } = await import("./trial-entitlements");

    await expect(lockAndAssertTrialStorageCapacity(
      tx as any,
      "workspace-1",
      768 * 1024,
      { replacingDocumentId: "document-replaced" },
    )).resolves.toBeUndefined();
  });

  it("does not lock or calculate usage for non-trial workspaces", async () => {
    const tx = {
      procurementTrial: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      $executeRaw: vi.fn(),
      document: {
        findMany: vi.fn(),
      },
    };
    const { lockAndAssertTrialStorageCapacity } = await import("./trial-entitlements");

    await expect(lockAndAssertTrialStorageCapacity(
      tx as any,
      "workspace-paid",
      100,
    )).resolves.toBeUndefined();

    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.document.findMany).not.toHaveBeenCalled();
  });
});
