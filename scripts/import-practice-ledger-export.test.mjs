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
  return {
    findMany: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue({}),
  };
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
    crmAccount: { findFirst: vi.fn().mockResolvedValue({ id: "crm-1" }) },
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
      expect(plan.counts.source[entity], entity).toBeGreaterThan(0);
      expect(plan.counts.planned[entity], entity).toBeGreaterThan(0);
      expect(plan.counts.skipped[entity], entity).toBe(0);
    }
    expect(plan.valid).toHaveLength(1);
    expect(plan.counts.source.entryReviews).toBe(2);
    expect(plan.counts.planned.entryReviews).toBe(2);
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

  it("routes versioned PortableRecordBatch records by entity", () => {
    const plan = planImport({
      moduleKey: "practice-ledger",
      schemaVersion: PRACTICE_FINANCE_SCHEMA_VERSION,
      records: [
        { entity: "client", id: "client-1", code: "C001", name: "Client One" },
        { entityType: "consultant", id: "consultant-1", name: "Consultant One" },
        { recordType: "project", id: "project-1", code: "P001", name: "Project One", clientName: "Client One", clientId: "client-1" },
        { entity: "time_entry", id: "time-1", clientId: "client-1", projectId: "project-1", consultantId: "consultant-1", workedOn: "2026-06-10", weekEndingOn: "2026-06-12", hours: 1 },
      ],
    });

    expect(plan.counts.planned.clients).toBe(1);
    expect(plan.counts.planned.consultants).toBe(1);
    expect(plan.counts.planned.projects).toBe(1);
    expect(plan.counts.planned.timeEntries).toBe(1);
  });

  it("rejects unsupported PortableRecordBatch schema versions", () => {
    expect(() => planImport({
      moduleKey: "practice-ledger",
      schemaVersion: "3",
      records: [
        { entity: "client", id: "client-1", code: "C001", name: "Client One" },
      ],
    })).toThrow(/Unsupported Practice Ledger export schema version: 3/);
  });

  it("rejects PortableRecordBatch records from another module", () => {
    expect(() => planImport({
      moduleKey: "another-module",
      schemaVersion: PRACTICE_FINANCE_SCHEMA_VERSION,
      records: [
        { entity: "client", id: "client-1", code: "C001", name: "Client One" },
      ],
    })).toThrow(/Unsupported Practice Ledger export module: another-module/);
  });

  it("rejects unsupported metadata before accepting top-level entity arrays", () => {
    expect(() => planImport({
      moduleKey: "another-module",
      schemaVersion: "3",
      clients: [{ id: "client-1", code: "C001", name: "Client One" }],
    })).toThrow(/Unsupported Practice Ledger export module: another-module/);
  });

  it("counts unknown PortableRecordBatch record types as skipped", () => {
    const plan = planImport({
      moduleKey: "practice-ledger",
      schemaVersion: PRACTICE_FINANCE_SCHEMA_VERSION,
      records: [
        { entity: "client", id: "client-1", code: "C001", name: "Client One" },
        { entity: "new_future_entity", id: "future-1", name: "Future One" },
      ],
    });

    expect(plan.counts.planned.clients).toBe(1);
    expect(plan.counts.source.unknownRecords).toBe(1);
    expect(plan.counts.skipped.unknownRecords).toBe(1);
    expect(plan.entities.unknownRecords.skipped[0].reason).toBe("unknown_record_type");
  });

  it("rejects missing required financial quantities and unknown posted-entry statuses", () => {
    const plan = planImport({
      clients: [{ id: "client-1", code: "C001", name: "Client One" }],
      consultants: [{ id: "consultant-1", name: "Consultant One" }],
      projects: [project({ id: "project-1", clientSourceId: "client-1" })],
      timeEntries: [
        { id: "time-missing-hours", clientId: "client-1", projectId: "project-1", consultantId: "consultant-1", workedOn: "2026-06-10", weekEndingOn: "2026-06-12" },
        { id: "time-unknown-status", clientId: "client-1", projectId: "project-1", consultantId: "consultant-1", workedOn: "2026-06-10", weekEndingOn: "2026-06-12", hours: 1, status: "pending" },
      ],
      expenses: [
        { id: "expense-missing-amount", clientId: "client-1", projectId: "project-1", spentOn: "2026-06-11", category: "Travel", businessPurpose: "Workshop" },
      ],
    });

    expect(plan.counts.skipped.timeEntries).toBe(2);
    expect(plan.counts.skipped.expenses).toBe(1);
  });

  it("rejects supplied invalid money and impossible calendar dates", () => {
    const plan = planImport({
      clients: [{ id: "client-1", code: "C001", name: "Client One" }],
      consultants: [{ id: "consultant-1", name: "Consultant One" }],
      projects: [project({ id: "project-1", clientSourceId: "client-1" })],
      projectLines: [
        { id: "line-invalid-money", projectId: "project-1", kind: "services", name: "Services", billRateCents: "not-a-number" },
      ],
      purchaseOrders: [
        { id: "po-invalid-date", projectId: "project-1", poNumber: "PO-001", issuedOn: "2026-02-30" },
      ],
      paymentBatches: [
        { id: "batch-invalid-money", consultantId: "consultant-1", totalAmountCents: "bad" },
      ],
      timeEntries: [
        { id: "time-invalid-money", clientId: "client-1", projectId: "project-1", consultantId: "consultant-1", workedOn: "2026-06-10", weekEndingOn: "2026-06-12", hours: 1, billRateCents: "bad" },
        { id: "time-invalid-date", clientId: "client-1", projectId: "project-1", consultantId: "consultant-1", workedOn: "2026-02-30", weekEndingOn: "2026-06-12", hours: 1 },
        { id: "time-invalid-timestamp", clientId: "client-1", projectId: "project-1", consultantId: "consultant-1", workedOn: "2026-02-30T00:00:00Z", weekEndingOn: "2026-06-12", hours: 1 },
        { id: "time-whitespace-hours", clientId: "client-1", projectId: "project-1", consultantId: "consultant-1", workedOn: "2026-06-10", weekEndingOn: "2026-06-12", hours: " " },
      ],
      expenses: [
        { id: "expense-invalid-money", clientId: "client-1", projectId: "project-1", spentOn: "2026-06-11", category: "Travel", businessPurpose: "Workshop", amountCents: 1000, amountFunctionalCents: "bad" },
        { id: "expense-invalid-date", clientId: "client-1", projectId: "project-1", spentOn: "2026-02-30", category: "Travel", businessPurpose: "Workshop", amountCents: 1000 },
        { id: "expense-whitespace-amount", clientId: "client-1", projectId: "project-1", spentOn: "2026-06-11", category: "Travel", businessPurpose: "Workshop", amountCents: " " },
      ],
    });

    expect(plan.counts.skipped.projectLines).toBe(1);
    expect(plan.counts.skipped.purchaseOrders).toBe(1);
    expect(plan.counts.skipped.paymentBatches).toBe(1);
    expect(plan.counts.skipped.timeEntries).toBe(4);
    expect(plan.counts.skipped.expenses).toBe(3);
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

  it("skips dependent records whose referenced parents disagree", () => {
    const plan = planImport({
      clients: [{ id: "client-1", code: "C001", name: "Client One" }, { id: "client-2", code: "C002", name: "Client Two" }],
      consultants: [{ id: "consultant-1", name: "Consultant One" }],
      projects: [project({ id: "project-1", clientSourceId: "client-1" })],
      projectLines: [{ id: "line-1", projectId: "project-1", kind: "services", name: "Services" }],
      timeEntries: [{
        id: "time-1",
        clientId: "client-2",
        projectId: "project-1",
        budgetLineId: "line-1",
        consultantId: "consultant-1",
        workedOn: "2026-06-10",
        weekEndingOn: "2026-06-12",
        hours: 1,
      }],
    });

    expect(plan.counts.skipped.timeEntries).toBe(1);
    expect(plan.entities.timeEntries.skipped[0].reason).toBe("relationship_mismatch");
  });

  it("allows entry billing codes that belong to the same client", () => {
    const plan = planImport({
      clients: [{ id: "client-1", code: "C001", name: "Client One" }],
      billingCodes: [
        { id: "billing-services", clientId: "client-1", code: "SERV", name: "Services" },
        { id: "billing-travel", clientId: "client-1", code: "TRVL", name: "Travel" },
      ],
      consultants: [{ id: "consultant-1", name: "Consultant One" }],
      projects: [project({ id: "project-1", clientSourceId: "client-1", billingCodeSourceId: "billing-services" })],
      timeEntries: [{
        id: "time-1",
        clientId: "client-1",
        billingCodeId: "billing-travel",
        projectId: "project-1",
        consultantId: "consultant-1",
        workedOn: "2026-06-10",
        weekEndingOn: "2026-06-12",
        hours: 1,
      }],
    });

    expect(plan.counts.planned.timeEntries).toBe(1);
    expect(plan.counts.skipped.timeEntries).toBe(0);
  });

  it("skips duplicate target unique keys during dry runs", () => {
    const plan = planImport({
      clients: [
        { id: "client-1", code: "C001", name: "Client One" },
        { id: "client-2", code: "C001", name: "Client Duplicate" },
      ],
    });

    expect(plan.counts.planned.clients).toBe(1);
    expect(plan.counts.skipped.clients).toBe(1);
    expect(plan.entities.clients.skipped[0].reason).toBe("duplicate_unique_key");
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
    expect(result.reconciliation.source.total).toBe(13);
    expect(result.reconciliation.targetBefore.missing.total).toBe(13);
    expect(result.reconciliation.targetAfter).toBeNull();
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

  it("preserves nullable JSON values and disconnects cleared optional relations on update", async () => {
    const prisma = prismaFixture();
    await importPracticeLedgerExport({
      prisma,
      workspaceId: "ws1",
      apply: true,
      batch: {
        clients: [{ id: "client-1", code: "C001", name: "Client One" }],
        consultants: [{ id: "consultant-1", name: "Consultant One" }],
        projects: [project({ id: "project-1", clientId: "client-1" })],
        sourceDocuments: [{ id: "doc-1", submittedPayload: null, createdRecords: null }],
        timeEntries: [{
          id: "time-1",
          clientId: "client-1",
          projectId: "project-1",
          consultantId: "consultant-1",
          workedOn: "2026-06-10",
          weekEndingOn: "2026-06-12",
          hours: 1,
        }],
      },
    });

    expect(prisma.practiceSourceDocument.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        submittedPayload: expect.anything(),
        createdRecords: expect.anything(),
      }),
    }));
    expect(prisma.practiceTimeEntry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        billingCode: { disconnect: true },
        projectLine: { disconnect: true },
        sourceDocument: { disconnect: true },
        paymentBatch: { disconnect: true },
      }),
      create: expect.not.objectContaining({
        billingCode: expect.anything(),
        projectLine: expect.anything(),
        sourceDocument: expect.anything(),
        paymentBatch: expect.anything(),
      }),
    }));
  });

  it("preserves explicit nulls for nullable financial values on update", async () => {
    const prisma = prismaFixture();
    await importPracticeLedgerExport({
      prisma,
      workspaceId: "ws1",
      apply: true,
      batch: {
        clients: [{ id: "client-1", code: "C001", name: "Client One" }],
        consultants: [{ id: "consultant-1", name: "Consultant One" }],
        projects: [project({ id: "project-1", clientId: "client-1" })],
        projectLines: [{ id: "line-1", projectId: "project-1", kind: "services", name: "Services", billRateCents: null, costRateCents: null }],
        timeEntries: [{
          id: "time-1",
          clientId: "client-1",
          projectId: "project-1",
          consultantId: "consultant-1",
          workedOn: "2026-06-10",
          weekEndingOn: "2026-06-12",
          hours: 1,
          billAmountCents: null,
          costAmountCents: null,
          paidAmountCents: null,
        }],
        expenses: [{
          id: "expense-1",
          clientId: "client-1",
          projectId: "project-1",
          spentOn: "2026-06-11",
          category: "Travel",
          businessPurpose: "Workshop",
          amountCents: 1000,
          amountFunctionalCents: null,
        }],
      },
    });

    expect(prisma.practiceProjectLine.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        billRateCents: null,
        costRateCents: null,
      }),
    }));
    expect(prisma.practiceTimeEntry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        billAmountCents: null,
        costAmountCents: null,
        paidAmountCents: null,
      }),
    }));
    expect(prisma.practiceExpense.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        amountFunctionalCents: null,
      }),
    }));
  });

  it("omits payment batch settledAt when the export omits it", async () => {
    const prisma = prismaFixture();
    await importPracticeLedgerExport({
      prisma,
      workspaceId: "ws1",
      apply: true,
      batch: {
        consultants: [{ id: "consultant-1", name: "Consultant One" }],
        paymentBatches: [{ id: "batch-1", consultantId: "consultant-1", totalAmountCents: 1000_00 }],
      },
    });

    expect(prisma.practicePaymentBatch.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.not.objectContaining({ settledAt: expect.anything() }),
      create: expect.not.objectContaining({ settledAt: expect.anything() }),
    }));
  });

  it("does not erase native project fields when legacy exports omit them", async () => {
    const prisma = prismaFixture();
    await importPracticeLedgerExport({
      prisma,
      workspaceId: "ws1",
      apply: true,
      batch: { moduleKey: "practice-ledger", schemaVersion: "1", records: [project()] },
    });

    expect(prisma.practiceProject.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.not.objectContaining({
        currency: expect.anything(),
        client: expect.anything(),
        billingCode: expect.anything(),
        startsOn: expect.anything(),
        endsOn: expect.anything(),
      }),
    }));
  });

  it("requires imported CRM account links to belong to the target workspace", async () => {
    const prisma = prismaFixture();
    prisma.crmAccount.findFirst.mockResolvedValueOnce(null);
    const result = await importPracticeLedgerExport({
      prisma,
      workspaceId: "ws1",
      apply: true,
      batch: {
        clients: [{ id: "client-1", code: "C001", name: "Client One", crmAccountId: "crm-other" }],
      },
    });

    expect(prisma.crmAccount.findFirst).toHaveBeenCalledWith({
      where: { id: "crm-other", workspaceId: "ws1" },
      select: { id: true },
    });
    expect(result.counts.skipped.clients).toBe(1);
    expect(prisma.practiceClient.upsert).not.toHaveBeenCalled();
  });

  it("reports existing target unique-key conflicts during dry runs", async () => {
    const prisma = prismaFixture();
    prisma.practiceClient.findMany.mockResolvedValueOnce([
      { code: "C001", sourceSatelliteId: "native-client" },
    ]);

    const result = await importPracticeLedgerExport({
      prisma,
      workspaceId: "ws1",
      batch: {
        clients: [{ id: "client-1", code: "C001", name: "Client One" }],
      },
    });

    expect(result.dryRun).toBe(true);
    expect(result.counts.planned.clients).toBe(0);
    expect(result.counts.skipped.clients).toBe(1);
    expect(result.reconciliation.source.byEntity.clients).toBe(1);
    expect(result.reconciliation.targetBefore.missing.byEntity.clients).toBe(1);
    expect(prisma.practiceClient.upsert).not.toHaveBeenCalled();
  });

  it("reports already-imported target rows during dry runs", async () => {
    const prisma = prismaFixture();
    prisma.practiceClient.findMany
      .mockResolvedValueOnce([{ code: "C001", sourceSatelliteId: "client-1" }])
      .mockResolvedValueOnce([{ sourceSatelliteId: "client-1" }]);

    const result = await importPracticeLedgerExport({
      prisma,
      workspaceId: "ws1",
      batch: {
        clients: [{ id: "client-1", code: "C001", name: "Client One" }],
      },
    });

    expect(result.counts.source.clients).toBe(1);
    expect(result.reconciliation.targetBefore.matched.byEntity.clients).toBe(1);
    expect(result.reconciliation.targetBefore.missing.byEntity.clients).toBe(0);
  });

  it("reconciles parsed source IDs from dependency-skipped rows", async () => {
    const prisma = prismaFixture();
    prisma.practiceProject.findMany.mockResolvedValueOnce([{ sourceSatelliteId: "project-skipped" }]);

    const result = await importPracticeLedgerExport({
      prisma,
      workspaceId: "ws1",
      batch: {
        projects: [project({ id: "project-skipped", clientId: "missing-client" })],
      },
    });

    expect(result.counts.source.projects).toBe(1);
    expect(result.counts.planned.projects).toBe(0);
    expect(result.counts.skipped.projects).toBe(1);
    expect(result.reconciliation.source.byEntity.projects).toBe(1);
    expect(result.reconciliation.targetBefore.matched.byEntity.projects).toBe(1);
    expect(result.reconciliation.targetBefore.missing.byEntity.projects).toBe(0);
  });

  it("chunks target reconciliation source id lookups for large exports", async () => {
    const prisma = prismaFixture();
    const timeEntries = Array.from({ length: 1005 }, (_, index) => ({
      id: `time-${index}`,
      clientId: "client-1",
      projectId: "project-1",
      consultantId: "consultant-1",
      workedOn: "2026-06-10",
      weekEndingOn: "2026-06-12",
      hours: 1,
    }));
    prisma.practiceTimeEntry.findMany.mockImplementation(async ({ where }) => (
      where.sourceSatelliteId.in.map((sourceSatelliteId) => ({ sourceSatelliteId }))
    ));

    const result = await importPracticeLedgerExport({
      prisma,
      workspaceId: "ws1",
      batch: {
        clients: [{ id: "client-1", code: "C001", name: "Client One" }],
        consultants: [{ id: "consultant-1", name: "Consultant One" }],
        projects: [project({ id: "project-1", clientId: "client-1" })],
        timeEntries,
      },
    });

    expect(result.reconciliation.targetBefore.matched.byEntity.timeEntries).toBe(1005);
    expect(prisma.practiceTimeEntry.findMany).toHaveBeenCalledTimes(2);
  });

  it("reports target reconciliation after an apply", async () => {
    const prisma = prismaFixture();
    prisma.practiceClient.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ sourceSatelliteId: "client-1" }]);

    const result = await importPracticeLedgerExport({
      prisma,
      workspaceId: "ws1",
      apply: true,
      batch: {
        clients: [{ id: "client-1", code: "C001", name: "Client One" }],
      },
    });

    expect(result.reconciliation.targetBefore.missing.byEntity.clients).toBe(1);
    expect(result.reconciliation.targetAfter.matched.byEntity.clients).toBe(1);
    expect(result.reconciliation.targetAfter.missing.byEntity.clients).toBe(0);
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
