import { describe, expect, it, vi } from "vitest";

import {
  ENTITY_ORDER,
  importPracticeLedgerExport,
  parseArgs,
  parsePortableRecord,
  planImport,
  PRACTICE_FINANCE_SCHEMA_VERSION,
} from "./import-practice-ledger-export.mjs";

function delegate() {
  return { upsert: vi.fn().mockResolvedValue({}) };
}

function prismaFixture() {
  return {
    practiceClient: delegate(),
    practiceBillingCode: delegate(),
    practiceConsultant: delegate(),
    practiceProject: delegate(),
    practiceProjectLine: delegate(),
    practicePurchaseOrder: delegate(),
    practiceProjectAssignment: delegate(),
    practiceSourceDocument: delegate(),
    practicePaymentBatch: delegate(),
    practiceTimeEntry: delegate(),
    practiceExpense: delegate(),
    practiceEntryReview: delegate(),
  };
}

function project(overrides = {}) {
  return {
    id: "project-001",
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

function fullBatch() {
  return {
    moduleKey: "practice-ledger",
    schemaVersion: PRACTICE_FINANCE_SCHEMA_VERSION,
    clients: [{ id: "client-1", code: "C001", name: "Client One" }],
    billingCodes: [{ id: "billing-1", clientId: "client-1", code: "B001", name: "Client billable" }],
    consultants: [{ id: "consultant-1", name: "Consultant One", email: "consultant@example.test" }],
    projects: [project({ id: "project-1", clientSourceId: "client-1", billingCodeSourceId: "billing-1" })],
    projectLines: [{ id: "line-1", projectId: "project-1", kind: "services", name: "Services", budgetCents: 10000_00 }],
    purchaseOrders: [{ id: "po-1", projectId: "project-1", poNumber: "PO-001", amountCents: 18000_00 }],
    assignments: [{ id: "assignment-1", projectId: "project-1", consultantId: "consultant-1", role: "Lead" }],
    sourceDocuments: [{ id: "doc-1", type: "timesheet", fileName: "timesheet.pdf" }],
    paymentBatches: [{ id: "batch-1", consultantId: "consultant-1", totalAmountCents: 1000_00, sliceAmountCents: 400_00 }],
    timeEntries: [{
      id: "time-1",
      clientId: "client-1",
      billingCodeId: "billing-1",
      projectId: "project-1",
      budgetLineId: "line-1",
      consultantId: "consultant-1",
      sourceDocumentId: "doc-1",
      paymentBatchId: "batch-1",
      workedOn: "2026-06-10",
      weekEndingOn: "2026-06-12",
      hours: 6.5,
      billRateCents: 25000,
      costRateCents: 17500,
      paidAmountCents: 50000,
    }],
    expenses: [{
      id: "expense-1",
      clientId: "client-1",
      billingCodeId: "billing-1",
      projectId: "project-1",
      budgetLineId: "line-1",
      consultantId: "consultant-1",
      sourceDocumentId: "doc-1",
      paymentBatchId: "batch-1",
      spentOn: "2026-06-11",
      category: "Travel",
      businessPurpose: "Client workshop",
      amountCents: 1200_00,
    }],
    entryReviews: [
      { id: "review-time-1", entryType: "TIME_ENTRY", entryId: "time-1", status: "approved" },
      { id: "review-expense-1", entryType: "EXPENSE", entryId: "expense-1", status: "submitted" },
    ],
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
  it("keeps the legacy project-only record parser for compatibility", () => {
    const parsed = parsePortableRecord(project({ status: "on hold" }));
    expect(parsed).toMatchObject({
      sourceSatelliteId: "project-001",
      code: "DPRJ-001",
      clientName: "Demo Client 01",
      status: "ON_HOLD",
      poValueCents: 18000_00,
      targetMarginBps: 5500,
    });
  });

  it("accepts `client` and `sourceSatelliteId` aliases for legacy project records", () => {
    const parsed = parsePortableRecord({ sourceSatelliteId: "pl-9", code: "C9", name: "N9", client: "Acme" });
    expect(parsed?.sourceSatelliteId).toBe("pl-9");
    expect(parsed?.clientName).toBe("Acme");
  });

  it("rejects project records missing a stable id or identity", () => {
    expect(parsePortableRecord(project({ id: "", sourceSatelliteId: "" }))).toBeNull();
    expect(parsePortableRecord(project({ code: "" }))).toBeNull();
    expect(parsePortableRecord(project({ clientName: "", client: "" }))).toBeNull();
    expect(parsePortableRecord(null)).toBeNull();
  });
});

describe("planImport", () => {
  it("keeps dependency parents before dependent ledger entries", () => {
    expect(ENTITY_ORDER.indexOf("clients")).toBeLessThan(ENTITY_ORDER.indexOf("projects"));
    expect(ENTITY_ORDER.indexOf("projects")).toBeLessThan(ENTITY_ORDER.indexOf("projectLines"));
    expect(ENTITY_ORDER.indexOf("consultants")).toBeLessThan(ENTITY_ORDER.indexOf("timeEntries"));
    expect(ENTITY_ORDER.indexOf("timeEntries")).toBeLessThan(ENTITY_ORDER.indexOf("entryReviews"));
    expect(ENTITY_ORDER.indexOf("expenses")).toBeLessThan(ENTITY_ORDER.indexOf("entryReviews"));
  });

  it("plans every supported entity in dependency order", () => {
    const plan = planImport(fullBatch());

    for (const entity of ENTITY_ORDER) {
      expect(plan.counts.planned[entity], entity).toBeGreaterThan(0);
      expect(plan.counts.skipped[entity], entity).toBe(0);
    }
    expect(plan.valid).toHaveLength(1);
  });

  it("still accepts the old project-only array shape", () => {
    const plan = planImport([project(), project({ id: "" }), project({ id: "project-2", code: "DPRJ-2" })]);

    expect(plan.entities.projects.valid).toHaveLength(2);
    expect(plan.entities.projects.skipped).toHaveLength(1);
    expect(plan.counts.planned.projects).toBe(2);
  });

  it("still accepts the old project-only PortableRecordBatch shape", () => {
    const plan = planImport({ moduleKey: "practice-ledger", schemaVersion: "1", records: [project()] });

    expect(plan.entities.projects.valid).toHaveLength(1);
    expect(plan.counts.planned.projects).toBe(1);
  });

  it("skips dependent records whose parent source id is not in the batch", () => {
    const plan = planImport({
      clients: [{ id: "client-1", code: "C001", name: "Client One" }],
      projects: [project({ id: "project-1", clientSourceId: "missing-client" })],
      timeEntries: [{
        id: "time-1",
        clientId: "client-1",
        projectId: "project-1",
        consultantId: "missing-consultant",
        workedOn: "2026-06-10",
        weekEndingOn: "2026-06-12",
        hours: 1,
      }],
    });

    expect(plan.counts.planned.clients).toBe(1);
    expect(plan.counts.skipped.projects).toBe(1);
    expect(plan.counts.skipped.timeEntries).toBe(1);
    expect(plan.entities.projects.skipped[0].reason).toBe("missing_dependency");
  });
});

describe("importPracticeLedgerExport", () => {
  it("dry-runs by default and writes nothing", async () => {
    const prisma = prismaFixture();
    const result = await importPracticeLedgerExport({
      prisma,
      workspaceId: "ws1",
      batch: fullBatch(),
    });

    expect(prisma.practiceProject.upsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dryRun: true, imported: 0, skipped: 0 });
    expect(result.counts.planned.timeEntries).toBe(1);
    expect(result.planned).toBe(13);
  });

  it("upserts valid records idempotently by (workspaceId, sourceSatelliteId) when applied", async () => {
    const prisma = prismaFixture();
    const result = await importPracticeLedgerExport({
      prisma,
      workspaceId: "ws1",
      apply: true,
      batch: fullBatch(),
    });

    expect(result).toMatchObject({ dryRun: false, planned: 13, imported: 13, skipped: 0 });
    expect(prisma.practiceClient.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_sourceSatelliteId: { workspaceId: "ws1", sourceSatelliteId: "client-1" } },
    }));
    expect(prisma.practiceProject.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_sourceSatelliteId: { workspaceId: "ws1", sourceSatelliteId: "project-1" } },
      create: expect.objectContaining({
        workspaceId: "ws1",
        sourceSatelliteId: "project-1",
        client: { connect: { workspaceId_sourceSatelliteId: { workspaceId: "ws1", sourceSatelliteId: "client-1" } } },
      }),
    }));
    expect(prisma.practiceTimeEntry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        client: { connect: { workspaceId_sourceSatelliteId: { workspaceId: "ws1", sourceSatelliteId: "client-1" } } },
        project: { connect: { workspaceId_sourceSatelliteId: { workspaceId: "ws1", sourceSatelliteId: "project-1" } } },
        consultant: { connect: { workspaceId_sourceSatelliteId: { workspaceId: "ws1", sourceSatelliteId: "consultant-1" } } },
      }),
    }));
  });

  it("counts upsert failures as skipped without stopping later entities", async () => {
    const prisma = prismaFixture();
    prisma.practiceProject.upsert.mockRejectedValueOnce(new Error("unique violation"));
    const result = await importPracticeLedgerExport({
      prisma,
      workspaceId: "ws1",
      apply: true,
      batch: fullBatch(),
    });

    expect(result.counts.imported.projects).toBe(0);
    expect(result.counts.skipped.projects).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("requires a workspaceId", async () => {
    await expect(importPracticeLedgerExport({ prisma: prismaFixture(), workspaceId: "", batch: [] }))
      .rejects.toThrow(/workspaceId/);
  });
});
