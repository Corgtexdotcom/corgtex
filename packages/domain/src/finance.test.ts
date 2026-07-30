import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, requireAgentScopeMock, requireWorkspaceMembershipMock, resolveSingleModuleAccessMock } = vi.hoisted(() => ({
  requireAgentScopeMock: vi.fn(),
  requireWorkspaceMembershipMock: vi.fn(),
  resolveSingleModuleAccessMock: vi.fn(),
  prismaMock: {
    workspaceFeatureFlag: { findMany: vi.fn() },
    member: { findUnique: vi.fn() },
    financeProject: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    financeClient: { count: vi.fn(), findFirst: vi.fn() },
    financeConsultant: { count: vi.fn(), findFirst: vi.fn() },
    financeTimeEntry: { count: vi.fn(), findFirst: vi.fn() },
    financeExpense: { count: vi.fn(), findFirst: vi.fn() },
    financeContributionEntry: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
    },
    appDefinition: { count: vi.fn() },
    catalogItem: { count: vi.fn() },
    appInstallation: { count: vi.fn() },
  },
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./agent-auth", () => ({
  requireAgentScope: requireAgentScopeMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

vi.mock("./module-access", () => ({
  resolveSingleModuleAccess: resolveSingleModuleAccessMock,
}));

const actor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

const scopedAgentActor = {
  kind: "agent",
  authProvider: "credential",
  credentialId: "credential-1",
  label: "Scoped agent",
  workspaceIds: ["workspace-1"],
  scopes: ["workspace:read"],
} as AppActor;

function financeFlags(overrides: Array<{ flag: string; enabled: boolean; config?: unknown }> = []) {
  return [
    { flag: "FINANCE", enabled: true, config: { financeAllMemberWrite: true }, updatedAt: new Date("2026-07-28T10:00:00.000Z") },
    ...overrides.map((flag) => ({ ...flag, updatedAt: new Date("2026-07-28T10:00:00.000Z") })),
  ];
}

describe("Finance V2 access policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAgentScopeMock.mockReturnValue(undefined);
    requireWorkspaceMembershipMock.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
    });
    resolveSingleModuleAccessMock.mockResolvedValue("read");
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue(financeFlags());
    prismaMock.financeClient.count.mockResolvedValue(0);
    prismaMock.financeConsultant.count.mockResolvedValue(0);
    prismaMock.financeProject.count.mockResolvedValue(0);
    prismaMock.financeTimeEntry.count.mockResolvedValue(0);
    prismaMock.financeExpense.count.mockResolvedValue(0);
    prismaMock.financeContributionEntry.count.mockResolvedValue(0);
    prismaMock.financeClient.findFirst.mockResolvedValue(null);
    prismaMock.financeConsultant.findFirst.mockResolvedValue(null);
    prismaMock.financeProject.findFirst.mockResolvedValue(null);
    prismaMock.financeTimeEntry.findFirst.mockResolvedValue(null);
    prismaMock.financeExpense.findFirst.mockResolvedValue(null);
    prismaMock.financeContributionEntry.findFirst.mockResolvedValue(null);
    prismaMock.member.findUnique.mockResolvedValue({ isActive: true });
    prismaMock.appDefinition.count.mockResolvedValue(0);
    prismaMock.catalogItem.count.mockResolvedValue(0);
    prismaMock.appInstallation.count.mockResolvedValue(0);
  });

  it("lets FINANCE config grant write access to normal contributors", async () => {
    const { getFinanceAccessPolicy } = await import("./finance");

    await expect(getFinanceAccessPolicy(actor, "workspace-1")).resolves.toMatchObject({
      financeEnabled: true,
      financeAllMemberWrite: true,
      role: "CONTRIBUTOR",
      canRead: true,
      canWrite: true,
    });
  });

  it("keeps contributor write access off when financeAllMemberWrite is absent", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE", enabled: true, config: {} },
    ]));
    const { getFinanceAccessPolicy } = await import("./finance");

    await expect(getFinanceAccessPolicy(actor, "workspace-1")).resolves.toMatchObject({
      financeAllMemberWrite: false,
      canRead: true,
      canWrite: false,
    });
  });

  it("honors approved Finance module write grants", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE", enabled: true, config: {} },
    ]));
    resolveSingleModuleAccessMock.mockResolvedValueOnce("write");
    const { getFinanceAccessPolicy } = await import("./finance");

    await expect(getFinanceAccessPolicy(actor, "workspace-1")).resolves.toMatchObject({
      financeAllMemberWrite: false,
      canRead: true,
      canWrite: true,
    });
  });

  it("reads section capabilities from FINANCE config", async () => {
    const { financeCapabilitiesFromConfig } = await import("./finance");

    expect(financeCapabilitiesFromConfig({
      financeCapabilities: {
        overview: true,
        projects: true,
        clients: true,
        slicingPie: true,
        capital: false,
      },
    })).toMatchObject({
      overview: true,
      projects: true,
      clients: true,
      "slicing-pie": true,
      capital: false,
    });
  });

  it("keeps report imports off unless the parent Finance config explicitly enables them", async () => {
    const { financeReportImportsEnabledFromConfig } = await import("./finance");

    expect(financeReportImportsEnabledFromConfig(null)).toBe(false);
    expect(financeReportImportsEnabledFromConfig({ financeCapabilities: {} })).toBe(false);
    expect(financeReportImportsEnabledFromConfig({
      financeCapabilities: { reportImports: false },
    })).toBe(false);
    expect(financeReportImportsEnabledFromConfig({
      financeCapabilities: { reportImports: "true" },
    })).toBe(false);
    expect(financeReportImportsEnabledFromConfig({
      financeCapabilities: { reportImports: true },
    })).toBe(true);
  });

  it("requires the finance read scope for credential agents", async () => {
    requireAgentScopeMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("Agent credential is missing the required scope."), {
        status: 403,
        code: "FORBIDDEN",
      });
    });
    const { getFinanceReadiness } = await import("./finance");

    await expect(getFinanceReadiness(scopedAgentActor, "workspace-1")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(requireAgentScopeMock).toHaveBeenCalledWith(scopedAgentActor, "finance:read");
    expect(requireWorkspaceMembershipMock).not.toHaveBeenCalled();
  });

  it("gates project creation on the projects capability flag", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags());
    const { createFinanceProject } = await import("./finance");

    await expect(createFinanceProject(actor, {
      workspaceId: "workspace-1",
      name: "Pilot rollout",
    })).rejects.toMatchObject({ code: "FINANCE_CAPABILITY_DISABLED" });
    expect(prismaMock.financeProject.create).not.toHaveBeenCalled();
  });

  it("creates projects when FINANCE config enables the projects capability", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      {
        flag: "FINANCE",
        enabled: true,
        config: {
          financeAllMemberWrite: true,
          financeCapabilities: { projects: true },
        },
      },
    ]));
    prismaMock.financeProject.create.mockResolvedValueOnce({ id: "project-1" });
    const { createFinanceProject } = await import("./finance");

    await expect(createFinanceProject(actor, {
      workspaceId: "workspace-1",
      name: "Pilot rollout",
    })).resolves.toEqual({ id: "project-1" });
  });

  it("lets FINANCE config disable a standalone section flag", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      {
        flag: "FINANCE",
        enabled: true,
        config: {
          financeAllMemberWrite: true,
          financeCapabilities: { projects: false },
        },
      },
      { flag: "FINANCE_PROJECTS", enabled: true },
    ]));
    const { createFinanceProject } = await import("./finance");

    await expect(createFinanceProject(actor, {
      workspaceId: "workspace-1",
      name: "Pilot rollout",
    })).rejects.toMatchObject({ code: "FINANCE_CAPABILITY_DISABLED" });
    expect(prismaMock.financeProject.create).not.toHaveBeenCalled();
  });

  it("creates project records through the Finance write policy", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE_PROJECTS", enabled: true },
    ]));
    prismaMock.financeProject.create.mockResolvedValueOnce({ id: "project-1" });
    const { createFinanceProject } = await import("./finance");

    await expect(createFinanceProject(actor, {
      workspaceId: "workspace-1",
      name: " Pilot rollout ",
      budgetCents: 2147483647,
      currency: "usd",
    })).resolves.toEqual({ id: "project-1" });
    expect(prismaMock.financeProject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        name: "Pilot rollout",
        budgetCents: 2147483647,
        currency: "USD",
        createdByUserId: "user-1",
      }),
    });
  });

  it("rejects project budgets above the Prisma Int range", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE_PROJECTS", enabled: true },
    ]));
    const { createFinanceProject } = await import("./finance");

    await expect(createFinanceProject(actor, {
      workspaceId: "workspace-1",
      name: "Pilot rollout",
      budgetCents: 2147483648,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(prismaMock.financeProject.create).not.toHaveBeenCalled();
  });

  it("turns duplicate project names into conflicts", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE_PROJECTS", enabled: true },
    ]));
    prismaMock.financeProject.create.mockRejectedValueOnce({
      code: "P2002",
      meta: { target: ["workspaceId", "name"] },
    });
    const { createFinanceProject } = await import("./finance");

    await expect(createFinanceProject(actor, {
      workspaceId: "workspace-1",
      name: "Pilot rollout",
    })).rejects.toMatchObject({
      status: 409,
      code: "FINANCE_PROJECT_ALREADY_EXISTS",
    });
  });

  it("rejects project creation with a client from another workspace", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE_PROJECTS", enabled: true },
    ]));
    prismaMock.financeClient.findFirst.mockResolvedValueOnce(null);
    const { createFinanceProject } = await import("./finance");

    await expect(createFinanceProject(actor, {
      workspaceId: "workspace-1",
      clientId: "client-from-other-workspace",
      name: "Pilot rollout",
    })).rejects.toMatchObject({ code: "FINANCE_CLIENT_NOT_FOUND" });
    expect(prismaMock.financeProject.create).not.toHaveBeenCalled();
  });

  it("records the submitting human on new Slicing Pie cash contributions", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE_SLICING_PIE", enabled: true },
    ]));
    prismaMock.financeContributionEntry.create.mockResolvedValueOnce({ id: "entry-1" });
    const { createFinanceContributionEntry } = await import("./finance");

    await expect(createFinanceContributionEntry(actor, {
      workspaceId: "workspace-1",
      type: "EXPENSE",
      paymentChoice: "CASH",
      amountCents: 2147483647,
      currency: "usd",
    })).resolves.toEqual({ id: "entry-1" });
    expect(prismaMock.financeContributionEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        submittedByUserId: "user-1",
        contributorUserId: "user-1",
        paymentChoice: "CASH",
        amountCents: 2147483647,
        cashStatus: "REQUESTED",
      }),
    });
  });

  it("creates Slicing Pie cash contributions when FINANCE config enables Slicing Pie", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      {
        flag: "FINANCE",
        enabled: true,
        config: {
          financeAllMemberWrite: true,
          financeCapabilities: { slicingPie: true },
        },
      },
    ]));
    prismaMock.financeContributionEntry.create.mockResolvedValueOnce({ id: "entry-1" });
    const { createFinanceContributionEntry } = await import("./finance");

    await expect(createFinanceContributionEntry(actor, {
      workspaceId: "workspace-1",
      type: "EXPENSE",
      paymentChoice: "CASH",
      amountCents: 5000,
    })).resolves.toEqual({ id: "entry-1" });
  });

  it("rejects contribution amounts above the Prisma Int range", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE_SLICING_PIE", enabled: true },
    ]));
    const { createFinanceContributionEntry } = await import("./finance");

    await expect(createFinanceContributionEntry(actor, {
      workspaceId: "workspace-1",
      type: "EXPENSE",
      paymentChoice: "CASH",
      amountCents: 2147483648,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(prismaMock.financeContributionEntry.create).not.toHaveBeenCalled();
  });

  it("requires an amount before creating cash payables", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE_SLICING_PIE", enabled: true },
    ]));
    const { createFinanceContributionEntry } = await import("./finance");

    await expect(createFinanceContributionEntry(actor, {
      workspaceId: "workspace-1",
      type: "EXPENSE",
      paymentChoice: "CASH",
    })).rejects.toMatchObject({ code: "PAYABLE_AMOUNT_REQUIRED" });
    expect(prismaMock.financeContributionEntry.create).not.toHaveBeenCalled();
  });

  it("requires positive minutes for time contributions", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE_SLICING_PIE", enabled: true },
    ]));
    const { createFinanceContributionEntry } = await import("./finance");

    await expect(createFinanceContributionEntry(actor, {
      workspaceId: "workspace-1",
      type: "TIME",
      paymentChoice: "SLICING_PIE",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(prismaMock.financeContributionEntry.create).not.toHaveBeenCalled();
  });

  it("rejects contribution minutes above the Prisma Int range", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE_SLICING_PIE", enabled: true },
    ]));
    const { createFinanceContributionEntry } = await import("./finance");

    await expect(createFinanceContributionEntry(actor, {
      workspaceId: "workspace-1",
      type: "TIME",
      paymentChoice: "SLICING_PIE",
      minutes: 2147483648,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(prismaMock.financeContributionEntry.create).not.toHaveBeenCalled();
  });

  it("requires a positive amount for non-cash expense contributions", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE_SLICING_PIE", enabled: true },
    ]));
    const { createFinanceContributionEntry } = await import("./finance");

    await expect(createFinanceContributionEntry(actor, {
      workspaceId: "workspace-1",
      type: "EXPENSE",
      paymentChoice: "SLICING_PIE",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(prismaMock.financeContributionEntry.create).not.toHaveBeenCalled();
  });

  it("requires a positive amount for capital contributions", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE_CAPITAL", enabled: true },
    ]));
    const { createFinanceContributionEntry } = await import("./finance");

    await expect(createFinanceContributionEntry(actor, {
      workspaceId: "workspace-1",
      type: "CAPITAL",
      paymentChoice: "CAPITAL",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(prismaMock.financeContributionEntry.create).not.toHaveBeenCalled();
  });

  it("rejects contributions with project or consultant ids outside the workspace", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE_SLICING_PIE", enabled: true },
    ]));
    prismaMock.financeProject.findFirst.mockResolvedValueOnce(null);
    prismaMock.financeConsultant.findFirst.mockResolvedValueOnce({ id: "consultant-1" });
    const { createFinanceContributionEntry } = await import("./finance");

    await expect(createFinanceContributionEntry(actor, {
      workspaceId: "workspace-1",
      projectId: "project-from-other-workspace",
      consultantId: "consultant-1",
      type: "TIME",
      paymentChoice: "SLICING_PIE",
      minutes: 60,
    })).rejects.toMatchObject({ code: "FINANCE_PROJECT_NOT_FOUND" });
    expect(prismaMock.financeContributionEntry.create).not.toHaveBeenCalled();
  });

  it("rejects contributions for users outside the workspace", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE_SLICING_PIE", enabled: true },
    ]));
    prismaMock.member.findUnique.mockResolvedValueOnce(null);
    const { createFinanceContributionEntry } = await import("./finance");

    await expect(createFinanceContributionEntry(actor, {
      workspaceId: "workspace-1",
      contributorUserId: "outside-user",
      type: "EXPENSE",
      paymentChoice: "CASH",
      amountCents: 4200,
    })).rejects.toMatchObject({ code: "FINANCE_CONTRIBUTOR_NOT_FOUND" });
    expect(prismaMock.financeContributionEntry.create).not.toHaveBeenCalled();
  });

  it("blocks self-confirmation of a cash payable", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE_SLICING_PIE", enabled: true },
    ]));
    prismaMock.financeContributionEntry.findFirst.mockResolvedValueOnce({
      id: "entry-1",
      workspaceId: "workspace-1",
      submittedByUserId: "user-1",
      contributorUserId: "user-1",
      paymentChoice: "CASH",
      cashStatus: "REQUESTED",
      type: "EXPENSE",
      version: 3,
    });
    const { confirmFinanceCashPayablePaid } = await import("./finance");

    await expect(confirmFinanceCashPayablePaid(actor, {
      workspaceId: "workspace-1",
      entryId: "entry-1",
      expectedVersion: 3,
    })).rejects.toMatchObject({ code: "PEER_REVIEW_REQUIRED" });
    expect(prismaMock.financeContributionEntry.updateMany).not.toHaveBeenCalled();
  });

  it("blocks contribution payee confirmation even when another human submitted it", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE_SLICING_PIE", enabled: true },
    ]));
    prismaMock.financeContributionEntry.findFirst.mockResolvedValueOnce({
      id: "entry-1",
      workspaceId: "workspace-1",
      submittedByUserId: "submitter-user",
      contributorUserId: "user-1",
      paymentChoice: "CASH",
      cashStatus: "REQUESTED",
      type: "EXPENSE",
      version: 3,
    });
    const { confirmFinanceCashPayablePaid } = await import("./finance");

    await expect(confirmFinanceCashPayablePaid(actor, {
      workspaceId: "workspace-1",
      entryId: "entry-1",
      expectedVersion: 3,
    })).rejects.toMatchObject({ code: "PEER_REVIEW_REQUIRED" });
    expect(prismaMock.financeContributionEntry.updateMany).not.toHaveBeenCalled();
  });

  it("lets a different human confirm a requested cash payable with stale-write protection", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE_SLICING_PIE", enabled: true },
    ]));
    prismaMock.financeContributionEntry.findFirst.mockResolvedValueOnce({
      id: "entry-1",
      workspaceId: "workspace-1",
      submittedByUserId: "other-user",
      contributorUserId: "other-user",
      paymentChoice: "CASH",
      cashStatus: "REQUESTED",
      type: "EXPENSE",
      version: 3,
    });
    prismaMock.financeContributionEntry.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.financeContributionEntry.findUniqueOrThrow.mockResolvedValueOnce({ id: "entry-1", cashStatus: "PAID" });
    const { confirmFinanceCashPayablePaid } = await import("./finance");

    await expect(confirmFinanceCashPayablePaid(actor, {
      workspaceId: "workspace-1",
      entryId: "entry-1",
      expectedVersion: 3,
    })).resolves.toEqual({ id: "entry-1", cashStatus: "PAID" });
    expect(prismaMock.financeContributionEntry.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "entry-1",
        workspaceId: "workspace-1",
        paymentChoice: "CASH",
        cashStatus: "REQUESTED",
        version: 3,
      }),
      data: expect.objectContaining({
        cashStatus: "PAID",
        paidByUserId: "user-1",
        version: { increment: 1 },
      }),
    });
  });

  it("requires a payable version before confirming payment", async () => {
    const { confirmFinanceCashPayablePaid } = await import("./finance");

    await expect(confirmFinanceCashPayablePaid(actor, {
      workspaceId: "workspace-1",
      entryId: "entry-1",
      expectedVersion: 0,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(prismaMock.financeContributionEntry.findFirst).not.toHaveBeenCalled();
  });

  it("rejects payable versions above the Prisma Int range", async () => {
    const { confirmFinanceCashPayablePaid } = await import("./finance");

    await expect(confirmFinanceCashPayablePaid(actor, {
      workspaceId: "workspace-1",
      entryId: "entry-1",
      expectedVersion: 2147483648,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(prismaMock.financeContributionEntry.findFirst).not.toHaveBeenCalled();
  });

  it("turns stale payable updates into conflicts", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      { flag: "FINANCE_SLICING_PIE", enabled: true },
    ]));
    prismaMock.financeContributionEntry.findFirst.mockResolvedValueOnce({
      id: "entry-1",
      workspaceId: "workspace-1",
      submittedByUserId: "other-user",
      contributorUserId: "other-user",
      paymentChoice: "CASH",
      cashStatus: "REQUESTED",
      type: "EXPENSE",
      version: 4,
    });
    prismaMock.financeContributionEntry.updateMany.mockResolvedValueOnce({ count: 0 });
    const { confirmFinanceCashPayablePaid } = await import("./finance");

    await expect(confirmFinanceCashPayablePaid(actor, {
      workspaceId: "workspace-1",
      entryId: "entry-1",
      expectedVersion: 3,
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("blocks payable confirmation when the child contribution capability is disabled", async () => {
    prismaMock.financeContributionEntry.findFirst.mockResolvedValueOnce({
      id: "entry-1",
      workspaceId: "workspace-1",
      submittedByUserId: "other-user",
      contributorUserId: "other-user",
      paymentChoice: "CASH",
      cashStatus: "REQUESTED",
      type: "EXPENSE",
      version: 3,
    });
    const { confirmFinanceCashPayablePaid } = await import("./finance");

    await expect(confirmFinanceCashPayablePaid(actor, {
      workspaceId: "workspace-1",
      entryId: "entry-1",
      expectedVersion: 3,
    })).rejects.toMatchObject({ code: "FINANCE_CAPABILITY_DISABLED" });
    expect(prismaMock.financeContributionEntry.updateMany).not.toHaveBeenCalled();
  });

  it("returns a read-only readiness diagnostic without Practice Ledger revival", async () => {
    const latestProjectUpdate = new Date("2026-07-28T11:00:00.000Z");
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      {
        flag: "FINANCE",
        enabled: true,
        config: {
          financeAllMemberWrite: true,
          financeCapabilities: {
            projects: true,
            slicingPie: true,
            reportImports: true,
          },
        },
      },
    ]));
    prismaMock.financeClient.count.mockResolvedValueOnce(2);
    prismaMock.financeConsultant.count.mockResolvedValueOnce(3);
    prismaMock.financeProject.count.mockResolvedValueOnce(5);
    prismaMock.financeContributionEntry.count
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(2);
    prismaMock.financeProject.findFirst.mockResolvedValueOnce({ updatedAt: latestProjectUpdate });

    const { getFinanceReadiness } = await import("./finance");

    const readiness = await getFinanceReadiness(actor, "workspace-1");
    expect(readiness).toMatchObject({
      ready: true,
      access: {
        financeAllMemberWrite: true,
        canWrite: true,
      },
      capabilities: {
        reportImports: true,
      },
      counts: {
        clients: 2,
        consultants: 3,
        projects: 5,
        contributionEntries: 7,
        requestedPayables: 1,
        slicingPieContributionEntries: 4,
        capitalContributionEntries: 2,
      },
      paymentSafety: {
        cashOnlyConfirmation: true,
        peerReviewRequired: true,
        staleConflictProtection: true,
      },
      retiredPracticeLedger: {
        retired: true,
      },
      latestFinanceUpdateAt: latestProjectUpdate,
    });
    expect(readiness.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "projects", enabled: true }),
      expect.objectContaining({ key: "slicing-pie", enabled: true }),
      expect.objectContaining({ key: "capital", enabled: false }),
    ]));
    expect(prismaMock.financeClient.count).toHaveBeenCalledWith({ where: { workspaceId: "workspace-1", status: "ACTIVE", archivedAt: null } });
    expect(prismaMock.financeConsultant.count).toHaveBeenCalledWith({ where: { workspaceId: "workspace-1", status: "ACTIVE", archivedAt: null } });
    expect(prismaMock.financeProject.count).toHaveBeenCalledWith({ where: { workspaceId: "workspace-1", status: { not: "ARCHIVED" }, archivedAt: null } });
    expect(prismaMock.financeTimeEntry.count).toHaveBeenCalledWith({ where: { workspaceId: "workspace-1", status: { not: "ARCHIVED" }, archivedAt: null } });
    expect(prismaMock.financeExpense.count).toHaveBeenCalledWith({ where: { workspaceId: "workspace-1", status: { not: "ARCHIVED" }, archivedAt: null } });
  });

  it("applies explicit overview capability config in readiness", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce(financeFlags([
      {
        flag: "FINANCE",
        enabled: true,
        config: {
          financeAllMemberWrite: true,
          financeCapabilities: {
            overview: false,
          },
        },
      },
    ]));
    const { getFinanceReadiness } = await import("./finance");

    const readiness = await getFinanceReadiness(actor, "workspace-1");

    expect(readiness.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "overview", enabled: false }),
      expect.objectContaining({ key: "projects", enabled: false }),
    ]));
  });

  it("includes Finance flag changes in the readiness update timestamp", async () => {
    const flagUpdate = new Date("2026-07-28T12:00:00.000Z");
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce([
      { flag: "FINANCE", enabled: true, config: { financeAllMemberWrite: true }, updatedAt: new Date("2026-07-28T10:00:00.000Z") },
      { flag: "FINANCE_PROJECTS", enabled: true, config: null, updatedAt: flagUpdate },
    ]);
    const { getFinanceReadiness } = await import("./finance");

    await expect(getFinanceReadiness(actor, "workspace-1")).resolves.toMatchObject({
      latestFinanceUpdateAt: flagUpdate,
    });
  });
});
