import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  auditLegacyFinance,
  buildLegacyFinanceArchive,
  exportLegacyFinanceArchive,
  LEGACY_FINANCE_TABLE_KEYS,
  normalizeAuditRows,
  parseArgs,
  writeLegacyFinanceArchive,
} from "./legacy-finance-archive.mjs";

const generatedAt = new Date("2026-06-19T18:00:00.000Z");

function row(id, overrides = {}) {
  return { id, ...overrides };
}

function workspace(overrides = {}) {
  return {
    id: "workspace-1",
    slug: "corgtex",
    name: "Corgtex Platform",
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-19T00:00:00.000Z"),
    ...overrides,
  };
}

function delegate(rows = []) {
  return { findMany: vi.fn().mockResolvedValue(rows) };
}

function prismaFixture(overrides = {}) {
  const tx = {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    workspace: { findFirst: vi.fn().mockResolvedValue(workspace()) },
    ledgerAccount: delegate([row("ledger-1")]),
    ledgerEntry: delegate([row("entry-1")]),
    spendRequest: delegate([row("spend-1"), row("spend-2")]),
    spendProposalLink: delegate([row("link-1")]),
    spendComment: delegate([row("comment-1")]),
    approvalFlow: delegate([row("flow-1")]),
    approvalDecision: delegate([row("decision-1")]),
    objection: delegate([row("objection-1")]),
    deliberationEntry: delegate([row("deliberation-1")]),
    workItemVersion: delegate([row("version-1")]),
    workspaceArchiveRecord: delegate([row("archive-1")]),
    auditLog: delegate([row("audit-1")]),
    event: delegate([row("event-1")]),
    workflowJob: delegate([row("job-1")]),
    notification: delegate([row("notification-1")]),
    ...overrides.tx,
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn((callback) => callback(tx)),
      ...overrides.prisma,
    },
  };
}

describe("legacy finance archive CLI args", () => {
  it("defaults to aggregate audit", () => {
    expect(parseArgs([])).toMatchObject({
      command: "audit",
      workspace: null,
    });
  });

  it("requires explicit workspace selection for row-level exports", () => {
    expect(() => parseArgs(["export"])).toThrow(/workspace/i);
    expect(parseArgs(["export", "--workspace", "corgtex", "--out-dir", ".artifacts/x"]))
      .toMatchObject({ command: "export", workspace: "corgtex", outDir: ".artifacts/x" });
  });

  it("rejects unknown commands and flags", () => {
    expect(() => parseArgs(["drop"])).toThrow(/unknown command/i);
    expect(() => parseArgs(["audit", "--apply"])).toThrow(/unknown argument/i);
  });
});

describe("legacy finance audit", () => {
  it("normalizes bigint counts and dates without row-level details", () => {
    expect(normalizeAuditRows([{
      id: "workspace-1",
      slug: "corgtex",
      name: "Corgtex Platform",
      spend_count: 5n,
      ledger_account_count: "7",
      ledger_entry_count: 6,
      spend_comment_count: null,
      last_activity_at: new Date("2026-06-19T17:00:00.000Z"),
    }])).toEqual([{
      id: "workspace-1",
      slug: "corgtex",
      name: "Corgtex Platform",
      spendCount: 5,
      ledgerAccountCount: 7,
      ledgerEntryCount: 6,
      spendCommentCount: 0,
      lastActivityAt: "2026-06-19T17:00:00.000Z",
    }]);
  });

  it("runs the audit query inside a read-only transaction", async () => {
    const { prisma, tx } = prismaFixture();
    tx.$queryRawUnsafe.mockResolvedValueOnce([{
      id: "workspace-1",
      slug: "corgtex",
      name: "Corgtex Platform",
      spend_count: 1n,
      ledger_account_count: 0n,
      ledger_entry_count: 0n,
      spend_comment_count: 0n,
      last_activity_at: new Date("2026-06-19T17:00:00.000Z"),
    }]);

    const rows = await auditLegacyFinance({ prisma });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith("SET TRANSACTION READ ONLY");
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain("FROM \"Workspace\" w");
    expect(rows[0]).toMatchObject({ slug: "corgtex", spendCount: 1 });
  });
});

describe("legacy finance export archive", () => {
  it("collects spend, ledger, and supporting rows for the selected workspace", async () => {
    const { prisma, tx } = prismaFixture();

    const archive = await buildLegacyFinanceArchive({
      prisma,
      workspaceSelector: "corgtex",
      generatedAt,
    });

    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith("SET TRANSACTION READ ONLY");
    expect(tx.workspace.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ id: "corgtex" }, { slug: "corgtex" }] },
    }));
    expect(tx.approvalFlow.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "workspace-1", subjectType: "SPEND", subjectId: { in: ["spend-1", "spend-2"] } },
    }));
    expect(tx.deliberationEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "workspace-1", parentType: "SPEND", parentId: { in: ["spend-1", "spend-2"] } },
    }));
    expect(tx.workflowJob.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "workspace-1", eventId: { in: ["event-1"] } },
    }));
    expect(archive.manifest).toMatchObject({
      schemaVersion: "1",
      generatedAt: "2026-06-19T18:00:00.000Z",
      source: "corgtex-legacy-finance",
      workspace: { id: "workspace-1", slug: "corgtex" },
    });
    expect(archive.manifest.counts).toMatchObject({
      spendRequests: 2,
      ledgerAccounts: 1,
      ledgerEntries: 1,
      approvalFlows: 1,
      workflowJobs: 1,
    });
  });

  it("skips dependent lookups when there are no spend or account ids", async () => {
    const { prisma, tx } = prismaFixture({
      tx: {
        ledgerAccount: delegate([]),
        ledgerEntry: delegate([]),
        spendRequest: delegate([]),
      },
    });

    const archive = await buildLegacyFinanceArchive({
      prisma,
      workspaceSelector: "empty",
      generatedAt,
    });

    expect(tx.spendProposalLink.findMany).not.toHaveBeenCalled();
    expect(tx.approvalFlow.findMany).not.toHaveBeenCalled();
    expect(archive.manifest.counts.spendRequests).toBe(0);
  });

  it("writes a manifest and one JSON file per table key", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "legacy-finance-archive-"));
    try {
      const archive = {
        manifest: {
          schemaVersion: "1",
          generatedAt: "2026-06-19T18:00:00.000Z",
          source: "corgtex-legacy-finance",
          workspace: workspace(),
          counts: Object.fromEntries(LEGACY_FINANCE_TABLE_KEYS.map((key) => [key, key === "spendRequests" ? 1 : 0])),
        },
        tables: {
          spendRequests: [{ id: "spend-1", amountCents: 1000 }],
        },
      };

      const result = await writeLegacyFinanceArchive({ archive, outDir: tempDir });

      expect(result.files).toHaveLength(LEGACY_FINANCE_TABLE_KEYS.length + 1);
      const manifest = JSON.parse(await readFile(path.join(result.workspaceDir, "manifest.json"), "utf8"));
      const spendRequests = JSON.parse(await readFile(path.join(result.workspaceDir, "spendRequests.json"), "utf8"));
      expect(manifest.workspace.slug).toBe("corgtex");
      expect(spendRequests).toEqual([{ id: "spend-1", amountCents: 1000 }]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("combines read-only collection and local file writing for export", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "legacy-finance-export-"));
    try {
      const { prisma } = prismaFixture();
      const result = await exportLegacyFinanceArchive({
        prisma,
        workspaceSelector: "corgtex",
        outDir: tempDir,
        generatedAt,
      });

      expect(result.workspace.slug).toBe("corgtex");
      expect(result.counts.spendRequests).toBe(2);
      expect(result.files.some((file) => file.endsWith("manifest.json"))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
