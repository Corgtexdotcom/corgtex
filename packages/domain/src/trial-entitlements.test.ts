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

function storageTrial(status = "ACTIVE") {
  return {
    id: "trial-1",
    workspaceId: "workspace-1",
    agentCredentialId: null,
    status,
    trialExpiresAt: new Date(Date.now() + 60_000),
    memberLimit: 5,
    storageLimitMb: 1,
    mcpDailyCallLimit: 100,
  };
}

function storageTx(
  documents: Array<{ id: string; metadata: { size: number } }>,
  trial: ReturnType<typeof storageTrial> | null = storageTrial(),
  order?: string[],
) {
  return {
    procurementTrial: {
      findUnique: vi.fn(async () => {
        order?.push("trial");
        return trial;
      }),
    },
    $executeRaw: vi.fn(async () => {
      order?.push("lock");
      return 1;
    }),
    document: {
      findMany: vi.fn(async () => {
        order?.push("usage");
        return documents;
      }),
    },
  };
}

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

  it("excludes persisted and legacy system identities while counting ordinary active humans", async () => {
    const { assertTrialMemberCapacity } = await import("./trial-entitlements");

    await expect(assertTrialMemberCapacity("workspace-1")).resolves.toBeUndefined();

    expect(prismaMock.member.count).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        isActive: true,
        NOT: [{
          OR: [
            { kind: "SYSTEM" },
            { user: { email: { startsWith: "system+", mode: "insensitive" } } },
            { user: { email: { startsWith: "support+", mode: "insensitive" } } },
            { user: { displayName: { equals: "Corgtex Support", mode: "insensitive" } } },
          ],
        }],
      },
    });
  });

  it("rejects a new member when active human members have reached the trial limit", async () => {
    prismaMock.member.count.mockResolvedValueOnce(5);
    const { assertTrialMemberCapacity } = await import("./trial-entitlements");

    await expect(assertTrialMemberCapacity("workspace-1"))
      .rejects.toMatchObject({ code: "TRIAL_MEMBER_LIMIT_EXCEEDED" });
  });

  it("uses the caller transaction and locks before calculating trial storage usage", async () => {
    const order: string[] = [];
    const tx = storageTx([{ id: "document-1", metadata: { size: 512 * 1024 } }], storageTrial(), order);
    const { lockAndAssertTrialStorageCapacity } = await import("./trial-entitlements");

    await expect(lockAndAssertTrialStorageCapacity(tx as any, "workspace-1", 512 * 1024))
      .resolves.toBeUndefined();

    expect(order).toEqual(["trial", "lock", "usage"]);
    expect(prismaMock.procurementTrial.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.document.findMany).not.toHaveBeenCalled();
  });

  it("rejects storage above the exact trial limit", async () => {
    const tx = storageTx([{ id: "document-1", metadata: { size: 512 * 1024 } }]);
    const { lockAndAssertTrialStorageCapacity } = await import("./trial-entitlements");

    await expect(lockAndAssertTrialStorageCapacity(tx as any, "workspace-1", 512 * 1024 + 1))
      .rejects.toMatchObject({ code: "TRIAL_STORAGE_LIMIT_EXCEEDED" });
  });

  it("counts only the replacement document's net size change", async () => {
    const tx = storageTx([
      { id: "document-replaced", metadata: { size: 512 * 1024 } },
      { id: "document-other", metadata: { size: 256 * 1024 } },
    ]);
    const { lockAndAssertTrialStorageCapacity } = await import("./trial-entitlements");

    await expect(lockAndAssertTrialStorageCapacity(
      tx as any,
      "workspace-1",
      768 * 1024,
      { replacingDocumentId: "document-replaced" },
    )).resolves.toBeUndefined();
  });

  it("allows a replacement that shrinks an already over-limit workspace", async () => {
    const tx = storageTx([
      { id: "document-replaced", metadata: { size: 768 * 1024 } },
      { id: "document-other", metadata: { size: 512 * 1024 } },
    ]);
    const { lockAndAssertTrialStorageCapacity } = await import("./trial-entitlements");

    await expect(lockAndAssertTrialStorageCapacity(
      tx as any,
      "workspace-1",
      512 * 1024,
      { replacingDocumentId: "document-replaced" },
    )).resolves.toBeUndefined();

    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.document.findMany).toHaveBeenCalledOnce();
  });

  it("does not enforce trial storage after a workspace converts", async () => {
    const convertedTrial = storageTrial("CONVERTED");
    prismaMock.procurementTrial.findUnique.mockResolvedValueOnce(convertedTrial);
    const tx = storageTx([], convertedTrial);
    const {
      assertTrialStorageCapacity,
      lockAndAssertTrialStorageCapacity,
    } = await import("./trial-entitlements");

    await expect(assertTrialStorageCapacity("workspace-paid", 100)).resolves.toBeUndefined();
    await expect(lockAndAssertTrialStorageCapacity(
      tx as any,
      "workspace-paid",
      100,
    )).resolves.toBeUndefined();

    expect(prismaMock.document.findMany).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.document.findMany).not.toHaveBeenCalled();
  });

  it("does not lock or calculate usage for non-trial workspaces", async () => {
    const tx = storageTx([], null);
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
