import { describe, expect, it, vi } from "vitest";

import {
  importPracticeLedgerExport,
  parseArgs,
  parsePortableRecord,
  planImport,
  PRACTICE_FINANCE_SCHEMA_VERSION,
} from "./import-practice-ledger-export.mjs";

function prismaFixture() {
  return {
    practiceProject: { upsert: vi.fn().mockResolvedValue({}) },
  };
}

function record(overrides = {}) {
  return {
    id: "pl-001",
    code: "DPRJ-001",
    name: "Demo Project 01",
    clientName: "Demo Client 01",
    status: "active",
    poValueCents: 18000_00,
    usedCents: 10700_00,
    targetMarginBps: 5500,
    currentMarginBps: 7760,
    ...overrides,
  };
}

describe("parseArgs", () => {
  it("parses file, workspace, and apply", () => {
    expect(parseArgs(["--file", "x.json", "--workspace", "ws1", "--apply"]))
      .toEqual({ file: "x.json", workspaceId: "ws1", apply: true });
  });
  it("defaults to a dry run", () => {
    expect(parseArgs(["--file", "x.json", "--workspace", "ws1"]).apply).toBe(false);
  });
});

describe("parsePortableRecord", () => {
  it("normalizes a valid record (status, cents, bps)", () => {
    const parsed = parsePortableRecord(record({ status: "on hold" }));
    expect(parsed).toMatchObject({
      sourceSatelliteId: "pl-001",
      code: "DPRJ-001",
      clientName: "Demo Client 01",
      status: "ON_HOLD",
      poValueCents: 18000_00,
      targetMarginBps: 5500,
    });
  });

  it("accepts `client` and `sourceSatelliteId` aliases", () => {
    const parsed = parsePortableRecord({ sourceSatelliteId: "pl-9", code: "C9", name: "N9", client: "Acme" });
    expect(parsed?.sourceSatelliteId).toBe("pl-9");
    expect(parsed?.clientName).toBe("Acme");
  });

  it("rejects records missing a stable id or identity", () => {
    expect(parsePortableRecord(record({ id: "", sourceSatelliteId: "" }))).toBeNull();
    expect(parsePortableRecord(record({ code: "" }))).toBeNull();
    expect(parsePortableRecord(record({ clientName: "", client: "" }))).toBeNull();
    expect(parsePortableRecord(null)).toBeNull();
  });

  it("clamps out-of-range margin bps to null and unknown status to ACTIVE", () => {
    const parsed = parsePortableRecord(record({ targetMarginBps: 99999, status: "weird" }));
    expect(parsed?.targetMarginBps).toBeNull();
    expect(parsed?.status).toBe("ACTIVE");
  });
});

describe("planImport", () => {
  it("separates valid rows from skipped records", () => {
    const { valid, skipped } = planImport([record(), record({ id: "" }), record({ id: "pl-2", code: "DPRJ-2" })]);
    expect(valid).toHaveLength(2);
    expect(skipped).toHaveLength(1);
  });
});

describe("importPracticeLedgerExport", () => {
  it("dry-runs by default and writes nothing", async () => {
    const prisma = prismaFixture();
    const result = await importPracticeLedgerExport({
      prisma,
      workspaceId: "ws1",
      batch: { moduleKey: "practice-ledger", schemaVersion: PRACTICE_FINANCE_SCHEMA_VERSION, records: [record()] },
    });
    expect(prisma.practiceProject.upsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dryRun: true, planned: 1, imported: 0, skipped: 0 });
  });

  it("upserts each valid record idempotently by (workspaceId, sourceSatelliteId) when applied", async () => {
    const prisma = prismaFixture();
    const result = await importPracticeLedgerExport({
      prisma,
      workspaceId: "ws1",
      apply: true,
      batch: [record(), record({ id: "pl-2", code: "DPRJ-2" }), record({ id: "" })],
    });
    expect(prisma.practiceProject.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.practiceProject.upsert.mock.calls[0][0].where).toEqual({
      workspaceId_sourceSatelliteId: { workspaceId: "ws1", sourceSatelliteId: "pl-001" },
    });
    expect(result).toMatchObject({ dryRun: false, planned: 2, imported: 2, skipped: 1 });
  });

  it("counts upsert failures (e.g. code collisions) as skipped", async () => {
    const prisma = prismaFixture();
    prisma.practiceProject.upsert.mockRejectedValueOnce(new Error("unique violation"));
    const result = await importPracticeLedgerExport({
      prisma,
      workspaceId: "ws1",
      apply: true,
      batch: [record(), record({ id: "pl-2", code: "DPRJ-2" })],
    });
    expect(result).toMatchObject({ imported: 1, skipped: 1 });
  });

  it("requires a workspaceId", async () => {
    await expect(importPracticeLedgerExport({ prisma: prismaFixture(), workspaceId: "", batch: [] }))
      .rejects.toThrow(/workspaceId/);
  });
});
