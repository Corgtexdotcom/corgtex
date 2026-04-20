import { describe, expect, it, vi } from "vitest";
import { normalizeCurrencyCode, normalizeReconciliationStatusInput } from "./finance";

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
  prisma: {
    member: { findFirst: vi.fn() },
    $transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        spendRequest: {
          create: vi.fn().mockResolvedValue({
            id: "sp-1",
            amountCents: 1000,
            currency: "USD",
            category: "software",
            description: "copilot",
            vendor: null,
            ledgerAccountId: null,
          }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({}) },
      }),
    ),
  },
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
