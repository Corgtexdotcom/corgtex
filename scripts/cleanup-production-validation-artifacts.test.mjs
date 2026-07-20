import { describe, expect, it, vi } from "vitest";

import {
  buildProductionValidationArtifactQueries,
  cleanupProductionValidationArtifacts,
  parseCleanupArgs,
} from "./cleanup-production-validation-artifacts.mjs";

function selectors(overrides = {}) {
  return {
    dateKey: "2026-07-18",
    runId: null,
    before: null,
    ...overrides,
  };
}

function mockPrisma(candidates = {}) {
  return {
    workspaceBriefing: { findMany: vi.fn().mockResolvedValue(candidates.WorkspaceBriefing ?? []) },
    action: { findMany: vi.fn().mockResolvedValue(candidates.Action ?? []) },
    proposal: { findMany: vi.fn().mockResolvedValue(candidates.Proposal ?? []) },
    brainArticle: { findMany: vi.fn().mockResolvedValue(candidates.BrainArticle ?? []) },
    $transaction: vi.fn(),
  };
}

describe("production validation artifact cleanup", () => {
  it("requires an explicit cleanup selector", () => {
    expect(() => parseCleanupArgs([])).toThrow("Set at least one cleanup selector");
    expect(parseCleanupArgs(["--date-key=2026-07-18"])).toMatchObject({
      apply: false,
      workspaceSlug: "corgtex-validation",
      selectors: { dateKey: "2026-07-18" },
    });
    expect(() => parseCleanupArgs(["--date-key=2026/07/18"])).toThrow("date-key must use YYYY-MM-DD");
  });

  it("builds queries that only target owned validation artifacts", () => {
    const queries = buildProductionValidationArtifactQueries("ws-1", selectors({ runId: "briefing-fixture-run" }));

    expect(queries.WorkspaceBriefing.where).toEqual({
      workspaceId: "ws-1",
      modelUsed: "production-validation-fixture",
      dateKey: "2026-07-18",
    });
    expect(queries.Action.where).toEqual({
      workspaceId: "ws-1",
      archivedAt: null,
      AND: [
        { title: { startsWith: "PROD-VERIFY 2026-07-18" } },
        { title: { contains: "briefing-fixture-run" } },
      ],
    });

    const runOnlyQueries = buildProductionValidationArtifactQueries("ws-1", selectors({ dateKey: null, runId: "briefing-fixture-run" }));
    expect(runOnlyQueries.WorkspaceBriefing).toBeUndefined();
    expect(runOnlyQueries.Action.where).toMatchObject({
      workspaceId: "ws-1",
      archivedAt: null,
      AND: [
        { title: { startsWith: "PROD-VERIFY " } },
        { title: { contains: "briefing-fixture-run" } },
      ],
    });
  });

  it("dry-runs against corgtex-validation without mutating records", async () => {
    const prisma = mockPrisma({
      WorkspaceBriefing: [{ id: "briefing-1", title: "Daily Workspace Briefing - 2026-07-18", dateKey: "2026-07-18" }],
      Action: [{ id: "action-1", title: "PROD-VERIFY 2026-07-18 PR-724 run action" }],
    });

    const report = await cleanupProductionValidationArtifacts(
      prisma,
      { id: "ws-1", slug: "corgtex-validation" },
      selectors(),
      { apply: false },
    );

    expect(report.mode).toBe("dry-run");
    expect(report.counts).toMatchObject({ WorkspaceBriefing: 1, Action: 1, Proposal: 0, BrainArticle: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses non-validation workspaces by default", async () => {
    await expect(cleanupProductionValidationArtifacts(
      mockPrisma(),
      { id: "ws-customer", slug: "customer" },
      selectors(),
      { apply: false },
    )).rejects.toThrow("must target corgtex-validation");
  });

  it("applies deletes and archives by candidate ids only", async () => {
    const prisma = mockPrisma({
      WorkspaceBriefing: [{ id: "briefing-1", title: "Daily Workspace Briefing - 2026-07-18" }],
      Action: [{ id: "action-1", title: "PROD-VERIFY 2026-07-18 PR-724 run action" }],
      Proposal: [{ id: "proposal-1", title: "PROD-VERIFY 2026-07-18 PR-724 run proposal" }],
      BrainArticle: [{ id: "article-1", title: "PROD-VERIFY 2026-07-18 PR-724 run article" }],
    });
    const tx = {
      workspaceBriefing: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      action: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      proposal: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      brainArticle: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    const now = new Date("2026-07-18T12:00:00.000Z");

    const report = await cleanupProductionValidationArtifacts(
      prisma,
      { id: "ws-1", slug: "corgtex-validation" },
      selectors(),
      { apply: true, now },
    );

    expect(report.mode).toBe("apply");
    expect(report.cleaned).toEqual({ WorkspaceBriefing: 1, Action: 1, Proposal: 1, BrainArticle: 1 });
    expect(tx.workspaceBriefing.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["briefing-1"] } } });
    expect(tx.action.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["action-1"] }, archivedAt: null },
      data: { archivedAt: now, archiveReason: "Production validation artifact cleanup." },
    });
  });
});
