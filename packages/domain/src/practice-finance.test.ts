import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, requireWorkspaceMembershipMock } = vi.hoisted(() => ({
  prismaMock: {
    crmAccount: {
      findUnique: vi.fn(),
    },
    crmDeal: {
      findUnique: vi.fn(),
    },
    practiceProject: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    workspaceFeatureFlag: {
      findUnique: vi.fn(),
    },
  },
  requireWorkspaceMembershipMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

import {
  BUDGET_RUNWAY_ATTENTION_WEEKS,
  canManagePracticeFinanceProjects,
  collectAttention,
  createPracticeProject,
  createPracticeProjectFromWonDeal,
  getCrmAccountPracticeFinance,
  getPracticeFinanceDashboard,
  listPracticeProjects,
  projectAttentionItems,
  projectBudgetRunwayWeeks,
  projectNeedsSetup,
  projectRemainingCents,
  projectUsedRatio,
  summarizePracticeFinance,
  updatePracticeProject,
} from "./practice-finance";

type Fixture = Parameters<typeof projectAttentionItems>[0];

function project(overrides: Partial<Fixture> = {}): Fixture {
  return {
    id: "p1",
    name: "Demo Project",
    status: "ACTIVE",
    poValueCents: 18_000_00,
    serviceBudgetCents: 15_000_00,
    expenseBudgetCents: 1_000_00,
    usedCents: 2_000_00,
    weeklyBurnCents: 0,
    targetMarginBps: 5500,
    currentMarginBps: 6400,
    ...overrides,
  };
}

describe("practice-finance pure derivations", () => {
  it("computes remaining and used ratio", () => {
    const p = project({ poValueCents: 10_000_00, usedCents: 2_500_00 });
    expect(projectRemainingCents(p)).toBe(7_500_00);
    expect(projectUsedRatio(p)).toBeCloseTo(0.25);
  });

  it("treats a zero budget as 0% used (no divide-by-zero)", () => {
    expect(projectUsedRatio(project({ poValueCents: 0, usedCents: 500_00 }))).toBe(0);
  });

  it("computes budget runway weeks, null without burn and 0 when exhausted", () => {
    expect(projectBudgetRunwayWeeks(project({ weeklyBurnCents: 0 }))).toBeNull();
    expect(
      projectBudgetRunwayWeeks(project({ poValueCents: 7_453_00, usedCents: 2_182_00, weeklyBurnCents: 2_182_00 })),
    ).toBeCloseTo(2.415, 2);
    expect(projectBudgetRunwayWeeks(project({ poValueCents: 1000, usedCents: 5000, weeklyBurnCents: 100 }))).toBe(0);
  });

  it("flags setup-incomplete projects", () => {
    expect(projectNeedsSetup(project())).toBe(false);
    expect(projectNeedsSetup(project({ poValueCents: 0 }))).toBe(true);
    expect(projectNeedsSetup(project({ targetMarginBps: null }))).toBe(true);
    expect(projectNeedsSetup(project({ expenseBudgetCents: 0 }))).toBe(true);
  });

  it("surfaces a setup attention item and short-circuits other checks", () => {
    const items = projectAttentionItems(project({ poValueCents: 0, weeklyBurnCents: 9_999_00, currentMarginBps: 10 }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ issue: "setup", weeks: null });
  });

  it("surfaces a budget runway attention item with a dollar/week detail", () => {
    const items = projectAttentionItems(
      project({ poValueCents: 7_453_00, usedCents: 2_182_00, weeklyBurnCents: 2_182_00, currentMarginBps: 6400, targetMarginBps: 5500 }),
    );
    const budget = items.find((i) => i.issue === "budget");
    expect(budget).toBeDefined();
    expect(budget?.weeks).toBe(2.4);
    expect(budget?.detail).toBe("$5,271 remaining at $2,182 / week.");
  });

  it("surfaces a margin attention item when below target", () => {
    const items = projectAttentionItems(
      project({ weeklyBurnCents: 0, currentMarginBps: 5260, targetMarginBps: 5500 }),
    );
    const margin = items.find((i) => i.issue === "margin");
    expect(margin?.detail).toBe("Current margin 52.6% vs target 55.0%.");
  });

  it("ignores non-active projects for attention", () => {
    expect(projectAttentionItems(project({ status: "CLOSED", poValueCents: 0 }))).toEqual([]);
  });

  it("does not flag budget attention when runway exceeds the threshold", () => {
    const items = projectAttentionItems(
      project({ poValueCents: 100_000_00, usedCents: 0, weeklyBurnCents: 100_00 }),
    );
    // 1000 weeks of runway -> well above threshold
    expect(items.find((i) => i.issue === "budget")).toBeUndefined();
    expect(BUDGET_RUNWAY_ATTENTION_WEEKS).toBeGreaterThan(0);
  });

  it("summarizes the portfolio across active projects only, with PO-weighted margin", () => {
    const summary = summarizePracticeFinance([
      project({ id: "a", status: "ACTIVE", poValueCents: 100_000_00, usedCents: 10_000_00, currentMarginBps: 6000 }),
      project({ id: "b", status: "ACTIVE", poValueCents: 300_000_00, usedCents: 30_000_00, currentMarginBps: 7000 }),
      project({ id: "c", status: "CLOSED", poValueCents: 999_000_00, usedCents: 999_000_00, currentMarginBps: 100 }),
    ]);
    expect(summary.activeProjects).toBe(2);
    expect(summary.budgetCents).toBe(400_000_00);
    expect(summary.usedCents).toBe(40_000_00);
    expect(summary.remainingCents).toBe(360_000_00);
    // PO-weighted: (6000*100 + 7000*300) / 400 = 6750
    expect(summary.marginBps).toBe(6750);
  });

  it("returns null portfolio margin when no active project has a margin", () => {
    expect(summarizePracticeFinance([project({ status: "ACTIVE", currentMarginBps: null })]).marginBps).toBeNull();
  });

  it("collects attention across many projects", () => {
    const all = collectAttention([
      project({ id: "s", poValueCents: 0 }),
      project({ id: "ok", weeklyBurnCents: 0 }),
    ]);
    expect(all.map((i) => i.projectId)).toEqual(["s"]);
  });
});

describe("practice-finance I/O", () => {
  const actor = {
    kind: "user" as const,
    user: {
      id: "user-1",
      email: "user@example.com",
      displayName: "User",
      globalRole: "USER" as const,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1", role: "ADMIN" });
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue({ enabled: true, config: null });
    prismaMock.crmAccount.findUnique.mockResolvedValue({
      id: "account-1",
      workspaceId: "workspace-1",
      archivedAt: null,
    });
    prismaMock.crmDeal.findUnique.mockResolvedValue({
      id: "deal-1",
      workspaceId: "workspace-1",
      accountId: "account-1",
      contactId: "contact-1",
      title: "Pilot rollout",
      stage: "CLOSED_WON",
      valueCents: 25_000_00,
      archivedAt: null,
      account: {
        id: "account-1",
        workspaceId: "workspace-1",
        name: "Example",
        slug: "example",
      },
      contact: {
        id: "contact-1",
        workspaceId: "workspace-1",
        email: "buyer@example.test",
        company: "Example",
      },
    });
    prismaMock.practiceProject.create.mockResolvedValue({
      id: "project-1",
      workspaceId: "workspace-1",
      crmAccountId: "account-1",
      crmDealId: "deal-1",
      code: "EXAMPLE-DEAL-1",
      name: "Pilot rollout",
      clientName: "Example",
      status: "ACTIVE",
      poValueCents: 25_000_00,
      serviceBudgetCents: 0,
      expenseBudgetCents: 0,
      usedCents: 0,
      weeklyBurnCents: 0,
      targetMarginBps: null,
      currentMarginBps: null,
      sourceSatelliteId: null,
      createdAt: new Date("2026-06-18T00:00:00.000Z"),
      updatedAt: new Date("2026-06-18T00:00:00.000Z"),
    });
    prismaMock.practiceProject.update.mockResolvedValue({
      id: "project-1",
      workspaceId: "workspace-1",
      crmAccountId: null,
      crmDealId: null,
      code: "DPRJ-001",
      name: "Updated project",
      clientName: "Example",
      status: "ON_HOLD",
      poValueCents: 40_000_00,
      serviceBudgetCents: 25_000_00,
      expenseBudgetCents: 5_000_00,
      usedCents: 12_000_00,
      weeklyBurnCents: 2_000_00,
      targetMarginBps: 5500,
      currentMarginBps: 5200,
      sourceSatelliteId: null,
      createdAt: new Date("2026-06-18T00:00:00.000Z"),
      updatedAt: new Date("2026-06-19T00:00:00.000Z"),
    });
    prismaMock.practiceProject.findUnique.mockResolvedValue(null);
    prismaMock.practiceProject.findMany.mockResolvedValue([]);
  });

  it("lists practice projects with a bounded default page", async () => {
    await listPracticeProjects(actor, "workspace-1");

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({ actor, workspaceId: "workspace-1" });
    expect(prismaMock.practiceProject.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1" },
      orderBy: [{ status: "asc" }, { code: "asc" }, { id: "asc" }],
      take: 100,
    });
  });

  it("clamps practice project take and applies a cursor", async () => {
    await listPracticeProjects(actor, "workspace-1", { take: 500, cursor: " project-10 " });

    expect(prismaMock.practiceProject.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1" },
      orderBy: [{ status: "asc" }, { code: "asc" }, { id: "asc" }],
      take: 200,
      cursor: { id: "project-10" },
      skip: 1,
    });
  });

  it("builds the dashboard from the bounded project list", async () => {
    prismaMock.practiceProject.findMany.mockResolvedValueOnce([
      project({ id: "active-1", poValueCents: 10_000_00, usedCents: 1_000_00 }),
    ]);

    const dashboard = await getPracticeFinanceDashboard(actor, "workspace-1");

    expect(dashboard.projects).toHaveLength(1);
    expect(dashboard.summary.activeProjects).toBe(1);
    expect(prismaMock.practiceProject.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 100,
    }));
  });

  it("returns CRM account-linked finance rollups from authoritative practice projects", async () => {
    prismaMock.practiceProject.findMany.mockResolvedValueOnce([
      {
        ...project({
          id: "project-1",
          poValueCents: 50_000_00,
          usedCents: 15_000_00,
          currentMarginBps: 6200,
        }),
        workspaceId: "workspace-1",
        crmAccountId: "account-1",
        crmDealId: "deal-1",
        code: "EXAMPLE-1",
        clientName: "Example",
        weeklyBurnCents: 5_000_00,
        sourceSatelliteId: null,
        createdAt: new Date("2026-06-18T00:00:00.000Z"),
        updatedAt: new Date("2026-06-18T00:00:00.000Z"),
        crmDeal: {
          id: "deal-1",
          title: "Pilot rollout",
          stage: "CLOSED_WON",
          valueCents: 50_000_00,
          currency: "USD",
        },
      },
    ]);

    const result = await getCrmAccountPracticeFinance(actor, {
      workspaceId: "workspace-1",
      accountId: "account-1",
    });

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({ actor, workspaceId: "workspace-1" });
    expect(prismaMock.crmAccount.findUnique).toHaveBeenCalledWith({
      where: { id: "account-1" },
      select: { id: true, workspaceId: true, archivedAt: true },
    });
    expect(result.summary).toMatchObject({
      activeProjects: 1,
      budgetCents: 50_000_00,
      usedCents: 15_000_00,
      remainingCents: 35_000_00,
      marginBps: 6200,
    });
    expect(result.projects[0]?.crmDeal?.valueCents).toBe(50_000_00);
  });

  it("creates a manual practice project behind finance-write access", async () => {
    const projectResult = await createPracticeProject(actor, "workspace-1", {
      code: "DPRJ-001",
      name: "Manual rollout",
      clientName: "Example",
      status: "ACTIVE",
      poValueCents: 40_000_00,
      serviceBudgetCents: 25_000_00,
      expenseBudgetCents: 5_000_00,
      usedCents: 12_000_00,
      weeklyBurnCents: 2_000_00,
      targetMarginBps: 5500,
      currentMarginBps: 5200,
    });

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor,
      workspaceId: "workspace-1",
    });
    expect(projectResult.id).toBe("project-1");
    expect(prismaMock.practiceProject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        code: "DPRJ-001",
        name: "Manual rollout",
        clientName: "Example",
        status: "ACTIVE",
        poValueCents: 40_000_00,
        targetMarginBps: 5500,
      }),
    });
  });

  it("rejects ordinary contributors without explicit all-member finance write config for manual practice projects", async () => {
    requireWorkspaceMembershipMock.mockResolvedValueOnce({ id: "member-1", role: "CONTRIBUTOR" });
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValueOnce({ enabled: true, config: null });

    await expect(createPracticeProject(actor, "workspace-1", {
      code: "DPRJ-001",
      name: "Manual rollout",
      clientName: "Example",
    })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(prismaMock.practiceProject.create).not.toHaveBeenCalled();
  });

  it("allows contributors to create and update practice projects when all-member finance writes are configured", async () => {
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1", role: "CONTRIBUTOR" });
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue({
      enabled: true,
      config: { practiceProjectsAllMemberWrite: true },
    });

    await createPracticeProject(actor, "workspace-1", {
      code: "DPRJ-001",
      name: "Manual rollout",
      clientName: "Example",
    });

    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-1",
      workspaceId: "workspace-1",
    });

    await updatePracticeProject(actor, "workspace-1", {
      projectId: "project-1",
      status: "ON_HOLD",
    });

    expect(prismaMock.practiceProject.create).toHaveBeenCalled();
    expect(prismaMock.practiceProject.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "project-1" },
    }));
  });

  it("keeps the finance manage helper aligned with configured all-member writes", async () => {
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1", role: "CONTRIBUTOR" });
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValueOnce({
      enabled: true,
      config: { practiceProjectsAllMemberWrite: true },
    });
    await expect(canManagePracticeFinanceProjects(actor, "workspace-1")).resolves.toBe(true);

    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValueOnce({ enabled: true, config: null });
    await expect(canManagePracticeFinanceProjects(actor, "workspace-1")).resolves.toBe(false);

    await expect(canManagePracticeFinanceProjects(actor, "workspace-1", {
      resolvedMembership: { role: "FINANCE_STEWARD" },
    })).resolves.toBe(true);
    await expect(canManagePracticeFinanceProjects(actor, "workspace-1", {
      resolvedMembership: { role: "ADMIN" },
    })).resolves.toBe(true);
  });

  it("updates a workspace-scoped practice project behind finance-write access", async () => {
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-1",
      workspaceId: "workspace-1",
    });

    const projectResult = await updatePracticeProject(actor, "workspace-1", {
      projectId: " project-1 ",
      code: "DPRJ-002",
      name: "Updated project",
      clientName: "Example",
      status: "ON_HOLD",
      poValueCents: 40_000_00,
      serviceBudgetCents: 25_000_00,
      expenseBudgetCents: 5_000_00,
      usedCents: 12_000_00,
      weeklyBurnCents: 2_000_00,
      targetMarginBps: 5500,
      currentMarginBps: 5200,
    });

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor,
      workspaceId: "workspace-1",
    });
    expect(projectResult.status).toBe("ON_HOLD");
    expect(prismaMock.practiceProject.findUnique).toHaveBeenCalledWith({
      where: { id: "project-1" },
      select: { id: true, workspaceId: true },
    });
    expect(prismaMock.practiceProject.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: expect.objectContaining({
        code: "DPRJ-002",
        name: "Updated project",
        clientName: "Example",
        status: "ON_HOLD",
        poValueCents: 40_000_00,
        currentMarginBps: 5200,
      }),
    });
  });

  it("rejects practice project updates across workspace boundaries", async () => {
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-1",
      workspaceId: "other-workspace",
    });

    await expect(updatePracticeProject(actor, "workspace-1", {
      projectId: "project-1",
      status: "CLOSED",
    })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(prismaMock.practiceProject.update).not.toHaveBeenCalled();
  });

  it("rejects account finance rollups across workspace boundaries", async () => {
    prismaMock.crmAccount.findUnique.mockResolvedValueOnce({
      id: "account-1",
      workspaceId: "other-workspace",
      archivedAt: null,
    });

    await expect(getCrmAccountPracticeFinance(actor, {
      workspaceId: "workspace-1",
      accountId: "account-1",
    })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(prismaMock.practiceProject.findMany).not.toHaveBeenCalled();
  });

  it("creates one finance project from a closed-won CRM deal behind finance-write access", async () => {
    const projectResult = await createPracticeProjectFromWonDeal(actor, "workspace-1", {
      dealId: "deal-1",
      serviceBudgetCents: 15_000_00,
      expenseBudgetCents: 2_000_00,
      targetMarginBps: 5500,
    });

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor,
      workspaceId: "workspace-1",
    });
    expect(projectResult.id).toBe("project-1");
    expect(prismaMock.practiceProject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        crmAccountId: "account-1",
        crmDealId: "deal-1",
        name: "Pilot rollout",
        clientName: "Example",
        poValueCents: 25_000_00,
        serviceBudgetCents: 15_000_00,
        expenseBudgetCents: 2_000_00,
        targetMarginBps: 5500,
      }),
    });
  });

  it("returns the existing linked finance project on repeated won-deal conversion", async () => {
    prismaMock.practiceProject.findUnique.mockResolvedValueOnce({
      id: "project-existing",
      workspaceId: "workspace-1",
    });

    const projectResult = await createPracticeProjectFromWonDeal(actor, "workspace-1", { dealId: "deal-1" });

    expect(projectResult.id).toBe("project-existing");
    expect(prismaMock.practiceProject.create).not.toHaveBeenCalled();
  });

  it("rejects project conversion unless the deal is closed won and workspace-scoped", async () => {
    prismaMock.crmDeal.findUnique.mockResolvedValueOnce({
      id: "deal-1",
      workspaceId: "workspace-1",
      accountId: "account-1",
      contactId: "contact-1",
      title: "Pilot rollout",
      stage: "NEGOTIATION",
      valueCents: 25_000_00,
      archivedAt: null,
      account: {
        id: "account-1",
        workspaceId: "workspace-1",
        name: "Example",
        slug: "example",
      },
      contact: {
        id: "contact-1",
        workspaceId: "workspace-1",
        email: "buyer@example.test",
        company: "Example",
      },
    });

    await expect(createPracticeProjectFromWonDeal(actor, "workspace-1", { dealId: "deal-1" }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_STATE" });
    expect(prismaMock.practiceProject.create).not.toHaveBeenCalled();

    prismaMock.crmDeal.findUnique.mockResolvedValueOnce({
      id: "deal-2",
      workspaceId: "workspace-1",
      accountId: "account-other",
      contactId: "contact-1",
      title: "Expansion",
      stage: "CLOSED_WON",
      valueCents: 10_000_00,
      archivedAt: null,
      account: {
        id: "account-other",
        workspaceId: "other-workspace",
        name: "Other",
        slug: "other",
      },
      contact: {
        id: "contact-1",
        workspaceId: "workspace-1",
        email: "buyer@example.test",
        company: "Example",
      },
    });

    await expect(createPracticeProjectFromWonDeal(actor, "workspace-1", { dealId: "deal-2" }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_STATE" });
    expect(prismaMock.practiceProject.create).not.toHaveBeenCalled();
  });
});
