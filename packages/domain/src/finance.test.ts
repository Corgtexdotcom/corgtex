import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCurrencyCode, normalizeReconciliationStatusInput } from "./finance";

const { prismaMock, txMock } = vi.hoisted(() => {
  const spendRequest = {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  };
  const tx = {
    spendRequest,
    auditLog: { create: vi.fn() },
    deliberationEntry: { count: vi.fn() },
    spendComment: { count: vi.fn() },
  };
  const prisma = {
    member: { findFirst: vi.fn() },
    $transaction: vi.fn((cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
  };

  return { prismaMock: prisma, txMock: tx };
});

describe("normalizeCurrencyCode", () => {
  it("normalizes valid codes to uppercase", () => {
    expect(normalizeCurrencyCode("usd")).toBe("USD");
    expect(normalizeCurrencyCode("usdc")).toBe("USDC");
  });

  it("rejects invalid currency codes", () => {
    expect(() => normalizeCurrencyCode("u")).toThrowError("currency must be 3-10 uppercase letters.");
    expect(() => normalizeCurrencyCode("usd-coin")).toThrowError("currency must be 3-10 uppercase letters.");
  });
});

describe("normalizeReconciliationStatusInput", () => {
  it("accepts known statuses", () => {
    expect(normalizeReconciliationStatusInput("pending")).toBe("PENDING");
    expect(normalizeReconciliationStatusInput("RECONCILED")).toBe("RECONCILED");
  });

  it("rejects unknown statuses", () => {
    expect(() => normalizeReconciliationStatusInput("closed")).toThrowError("Invalid reconciliation status.");
  });
});

// ---- createSpend requesterEmail tests (needs mocked Prisma) ----------

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue({ id: "mem-1" }),
  actorUserIdForWorkspace: vi.fn().mockResolvedValue("usr-sys"),
}));

vi.mock("./events", () => ({
  appendEvents: vi.fn().mockResolvedValue(null),
}));

vi.mock("./approvals", () => ({
  ensureApprovalFlow: vi.fn().mockResolvedValue(null),
  getApprovalPolicy: vi.fn().mockResolvedValue(null),
}));

describe("createSpend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txMock.spendRequest.create.mockResolvedValue({
      id: "sp-1",
      amountCents: 1000,
      currency: "USD",
      category: "software",
      description: "copilot",
      vendor: null,
      ledgerAccountId: null,
    });
    txMock.auditLog.create.mockResolvedValue({});
  });

  it("uses looked-up user when agent provides requesterEmail", async () => {
    // Dynamic import so vi.mock() is applied before the module loads.
    const { createSpend } = await import("./finance");
    const { prisma } = await import("@corgtex/shared");

    vi.mocked(prisma.member.findFirst).mockResolvedValueOnce({
      userId: "usr-found",
    } as any);

    await createSpend(
      { kind: "agent", agentSettings: { workspaceId: "ws-1" } } as any,
      {
        workspaceId: "ws-1",
        amountCents: 1000,
        currency: "USD",
        category: "software",
        description: "copilot",
        requesterEmail: "test@corgtex.com",
      },
    );

    expect(prisma.member.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        isActive: true,
        user: { email: "test@corgtex.com" },
      },
      select: { userId: true },
    });

    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

describe("markSpendPaid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txMock.auditLog.create.mockResolvedValue({});
    txMock.deliberationEntry.count.mockResolvedValue(0);
    txMock.spendComment.count.mockResolvedValue(0);
  });

  function openSpend() {
    return {
      id: "sp-1",
      workspaceId: "ws-1",
      requesterUserId: "usr-requester",
      status: "OPEN",
      resolutionOutcome: null,
      amountCents: 1000,
      currency: "USD",
      category: "software",
      description: "copilot",
      vendor: null,
      receiptUrl: null,
      spentAt: null,
      ledgerAccountId: null,
      archivedAt: null,
      proposalLinks: [],
      comments: [],
    };
  }

  it("blocks payment when an open spend has an unresolved deliberation objection", async () => {
    const { markSpendPaid } = await import("./finance");

    txMock.spendRequest.findUnique.mockResolvedValue(openSpend());
    txMock.deliberationEntry.count.mockResolvedValue(1);

    await expect(markSpendPaid(
      { kind: "user", user: { id: "usr-finance" } } as any,
      { workspaceId: "ws-1", spendId: "sp-1", receiptUrl: "https://receipt.test/1" },
    )).rejects.toMatchObject({ code: "INVALID_STATE" });

    expect(txMock.spendRequest.update).not.toHaveBeenCalled();
  });

  it("blocks payment when an open spend has an unresolved legacy comment objection", async () => {
    const { markSpendPaid } = await import("./finance");

    txMock.spendRequest.findUnique.mockResolvedValue(openSpend());
    txMock.spendComment.count.mockResolvedValue(1);

    await expect(markSpendPaid(
      { kind: "user", user: { id: "usr-finance" } } as any,
      { workspaceId: "ws-1", spendId: "sp-1", receiptUrl: "https://receipt.test/1" },
    )).rejects.toMatchObject({ code: "INVALID_STATE" });

    expect(txMock.spendRequest.update).not.toHaveBeenCalled();
  });

  it("marks an open spend paid when it has no unresolved objections", async () => {
    const { markSpendPaid } = await import("./finance");
    const spend = openSpend();
    const updatedSpend = {
      ...spend,
      status: "RESOLVED",
      resolutionOutcome: "APPROVED",
      receiptUrl: "https://receipt.test/1",
      spentAt: new Date(),
    };

    txMock.spendRequest.findUnique.mockResolvedValue(spend);
    txMock.spendRequest.update.mockResolvedValue(updatedSpend);

    await expect(markSpendPaid(
      { kind: "user", user: { id: "usr-finance" } } as any,
      { workspaceId: "ws-1", spendId: "sp-1", receiptUrl: "https://receipt.test/1" },
    )).resolves.toBe(updatedSpend);

    expect(txMock.spendRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "sp-1" },
      data: expect.objectContaining({
        status: "RESOLVED",
        resolutionOutcome: "APPROVED",
        receiptUrl: "https://receipt.test/1",
        spentAt: expect.any(Date),
      }),
    }));
  });
});
