import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const fixture = vi.hoisted(() => {
  const tables: Record<string, any[]> = {};
  const time = new Date("2026-10-12T09:00:00Z");
  const match = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === "AND" || key === "conversation" || key === "member" || key === "account" || key === "contact" || key === "deal") return true;
    if (key === "OR") return value.some((clause: any) => match(row, clause));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (value.in) return value.in.includes(row[key]);
      if ("not" in value) return row[key] !== value.not;
      return Object.entries(value).every(([nested, expected]) => row[nested] === expected);
    }
    return row[key] === value;
  });
  const project = (row: any, args: any): any => {
    if (!row) return null;
    let result = { ...row };
    if (args.include?.document) result.document = tables.document.find(parent => parent.id === row.documentId) ?? null;
    if (args.include?.brainSource) result.brainSource = tables.brainSource.find(parent => parent.id === row.brainSourceId) ?? null;
    if (args.include?.agentRun) result.agentRun = tables.agentRun.find(parent => parent.id === row.agentRunId) ?? null;
    if (args.include?.report) result.report = tables.financeReport.find(parent => parent.sourceBatchId === row.id) ?? null;
    if (args.include?.candidates) result.candidates = tables.financeImportCandidate.filter(child => child.batchId === row.id).map(child => ({ ...child,
      ...(args.include.candidates.include?.application ? { application: tables.financeImportApplication.find(receipt => receipt.candidateId === child.id) ?? null } : {}) }));
    if (args.select) result = Object.fromEntries(Object.keys(args.select).map((key) => [key, result[key]]));
    return result;
  };
  const sqlJson = (value: any) => ["JsonNull", "DbNull"].includes(value?.constructor?.name) ? null : value;
  const names = ["informationCategoryPolicy", "document", "brainSource", "artifactInputLineage", "artifactInputSnapshot", "workspace", "user", "financeImportBatch", "financeReportUploadInput", "workflowJob", "event", "financeImportCandidate", "financeReportFact", "financeReportFactRevision", "agentRun", "agentIdentity", "financeReport", "financeImportApplication"];
  const permissionEpochs = new Map<string, bigint>();
  const epochKey = (workspaceId: unknown, kind: unknown, id: unknown) => JSON.stringify([workspaceId, kind, id]);
  const rawSql = (query: any) => Array.isArray(query?.strings) ? query.strings.join("?") : String(query);
  const prisma: any = { $queryRaw: vi.fn(async (query: any) => {
    if (!rawSql(query).includes('FROM "SourcePermissionEpoch"')) return [];
    const [workspaceId, ...identities] = query.values as unknown[];
    const rows: Array<{ sourceKind: string; sourceId: string; epoch: bigint }> = [];
    for (let index = 0; index < identities.length; index += 2) {
      const sourceKind = identities[index] as string;
      const sourceId = identities[index + 1] as string;
      const epoch = permissionEpochs.get(epochKey(workspaceId, sourceKind, sourceId));
      if (epoch !== undefined) rows.push({ sourceKind, sourceId, epoch });
    }
    return rows.sort((left, right) => left.sourceKind.localeCompare(right.sourceKind, "en")
      || left.sourceId.localeCompare(right.sourceId, "en"));
  }), $executeRaw: vi.fn(async (query: any) => {
    if (!rawSql(query).includes('INSERT INTO "SourcePermissionEpoch"')) return 1;
    const values = query.values as unknown[];
    for (let index = 0; index < values.length; index += 4) {
      const key = epochKey(values[index + 1], values[index + 2], values[index + 3]);
      if (!permissionEpochs.has(key)) permissionEpochs.set(key, 0n);
    }
    return 1;
  }),
    auditLog: { create: vi.fn(async () => ({})) }, event: { createMany: vi.fn(async () => ({ count: 1 })) } };
  for (const name of names) {
    tables[name] = [];
    prisma[name] = {
      findFirst: vi.fn(async (args: any) => {
        const rows = tables[name].filter((row) => match(row, args.where));
        return project(name === "artifactInputLineage" ? rows.at(-1) : rows[0], args);
      }),
      findUniqueOrThrow: vi.fn(async (args: any) => { const row = tables[name].find((row) => match(row, args.where)); if (!row) throw new Error("missing fixture row"); return project(row, args); }),
      findUnique: vi.fn(async (args: any) => project(tables[name].find((row) => match(row, args.where)), args)),
      findMany: vi.fn(async (args: any) => {
        const rows = tables[name].filter((row) => match(row, args.where));
        if (name === "artifactInputLineage") rows.sort((left, right) => right.revision - left.revision);
        const start = args.cursor ? rows.findIndex((row) => row.id === args.cursor.id) + (args.skip ?? 0) : args.skip ?? 0;
        return rows.slice(start, start + (args.take ?? rows.length)).map((row) => project(row, args));
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => { const existing = tables[name].find(row => match(row, where)); return existing ? prisma[name].update({ where, data: update }) : prisma[name].create({ data: create }); }),
      createMany: vi.fn(async ({ data }: any) => { for (const row of data) await prisma[name].create({ data: row }); return { count: data.length }; }),
      create: vi.fn(async ({ data }: any) => {
        data = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, sqlJson(value)]));
        const row = { id: `${name}-${tables[name].length + 1}`,
          ...(["document", "brainSource", "meeting"].includes(name) ? { informationCategory: "GENERAL" } : {}), archivedAt: null, createdAt: time,
          ...(name === "financeImportBatch" ? { version: 1, retryCount: 0, workflowJobId: null } : {}),
          ...(name === "financeReport" || name === "financeReportFact" ? { version: 1, status: "ACTIVE" } : {}),
          ...(name === "financeImportCandidate" ? { version: 1, currentFactId: null, currentFactRevisionId: null, currentAmountCents: null, approvedByUserId: null, approvedAt: null } : {}),
          ...(name === "document" ? { textContent: null } : {}),
          ...(name !== "crmActivity" && name !== "crmDealStageTransition" ? { updatedAt: time } : {}), ...data };
        tables[name].push(row); return { ...row };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const index = tables[name].findIndex((row) => match(row, where));
        const patched = Object.fromEntries(Object.entries(data).map(([key, value]: [string, any]) => [key, value && typeof value === "object" && "increment" in value ? tables[name][index][key] + value.increment : sqlJson(value)]));
        tables[name][index] = { ...tables[name][index], ...patched }; return { ...tables[name][index] };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const matches = tables[name].filter((row) => match(row, where));
        for (const row of matches) for (const [key, value] of Object.entries(data) as Array<[string, any]>) {
          row[key] = value && typeof value === "object" && "increment" in value ? row[key] + value.increment : sqlJson(value);
        }
        return { count: matches.length };
      }),
    };
  }
  prisma.$transaction = vi.fn(async (run: (tx: any) => Promise<any>) => {
    const before = Object.fromEntries(names.map((name) => [name, structuredClone(tables[name])]));
    const epochsBefore = new Map(permissionEpochs);
    try { return await run(prisma); } catch (error) { for (const name of names) tables[name] = before[name];
      permissionEpochs.clear(); for (const [key, epoch] of epochsBefore) permissionEpochs.set(key, epoch); throw error; }
  });
  return { prisma, tables, permissionEpochs, time, revoked: new Set<string>(), departed: new Set<string>() };
});
vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma, env: { APP_URL: "https://synthetic.test" }, toInputJson: (value: unknown) => value }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: vi.fn(async ({ actor, workspaceId }) => {
  if (!["ws-crm", "ws-other"].includes(workspaceId) || fixture.departed.has(actor.user?.id ?? "agent")) throw Object.assign(new Error("Membership revoked"), { status: 403 });
  return { id: `member-${actor.user?.id ?? "agent"}`, role: "MEMBER" };
}), requireGlobalOperator: vi.fn() }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async actor => actor.kind === "user" && !fixture.revoked.has(actor.user.id) ? ["PUBLIC", "FINANCE"] : ["PUBLIC"]) }));
vi.mock("./finance", () => ({ requireFinanceReportImportReadAccess: vi.fn(async () => {}), requireFinanceReportImportHumanWriteAccess: vi.fn(async (actor, workspaceId) => {
  if (actor.kind !== "user" || fixture.revoked.has(actor.user.id) || fixture.departed.has(actor.user.id)
    || !["ws-crm", "ws-other"].includes(workspaceId)) throw Object.assign(new Error("Finance permission revoked"), { code: "FORBIDDEN" });
}) }));
vi.mock("./trial-entitlements", () => ({ lockAndAssertTrialStorageCapacity: vi.fn() }));
vi.mock("./events", () => ({ appendEvents: vi.fn() }));
vi.mock("@corgtex/storage", () => ({ defaultStorage: { get: vi.fn(), put: vi.fn() } }));
vi.mock("@corgtex/agents", () => ({ runFinanceReportImportAgentV1: vi.fn() }));
vi.mock("@corgtex/domain", async () => ({ ...await import("./finance-import-extraction") }));
vi.mock("@corgtex/knowledge", async () => ({ ...await import("../../knowledge/src/finance-file-extraction") }));
import { createFinanceReportImportUpload } from "./finance-import-upload";
import { claimFinanceReportImportExtraction, completeFinanceReportImportExtraction } from "./finance-import-extraction";
import { captureArtifactInputProof, isArtifactInputProofReadable, recordArtifactInputLineage } from "./source-lineage";
import { isArtifactInputPermissionEpochCoverageComplete } from "./source-permission-coverage";
import { runFinanceReportImportExtractionJob } from "../../workflows/src/handlers/finance-report-import";
import { extractFinanceReportFile } from "../../knowledge/src/finance-file-extraction";
const ws = "ws-crm";
const alice = { kind: "user", user: { id: "alice", email: "alice@example.test", displayName: "Alice" } } as AppActor;
const bob = { kind: "user", user: { id: "bob", email: "bob@example.test", displayName: "Bob" } } as AppActor;
const bytes = Buffer.from("Account,Amount\nRevenue,100\n");
const lease = { lockedBy: "worker-1", lockedAt: new Date("2026-10-13T12:00:00Z") };
const storage = { put: vi.fn(async () => ({ key: "stored", size: bytes.length })), get: vi.fn(async () => ({ data: Buffer.from(bytes), contentType: "text/csv" })) };
const upload = (actor = alice, workspaceId = ws) => createFinanceReportImportUpload(actor, { workspaceId, fileBuffer: bytes, fileName: "synthetic.csv", mimeType: "text/csv", storage });
const job = async (batchId: string, workspaceId = ws) => {
  const row = await fixture.prisma.workflowJob.create({ data: { workspaceId, type: "finance-report-import.extract", payload: { batchId }, status: "RUNNING", attempts: 1, ...lease } });
  return { workspaceId, batchId, workflowJobId: row.id, attempts: 1, isFinalAttempt: false, expectedLease: lease, storage };
};
beforeEach(async () => {
  for (const name of Object.keys(fixture.tables)) fixture.tables[name] = [];
  fixture.permissionEpochs.clear();
  fixture.revoked.clear(); fixture.departed.clear(); vi.clearAllMocks();
  storage.get.mockReset().mockImplementation(async () => ({ data: Buffer.from(bytes), contentType: "text/csv" }));
  storage.put.mockReset().mockResolvedValue({ key: "stored", size: bytes.length });
  for (const actor of [alice, bob]) if (actor.kind === "user") await fixture.prisma.user.create({ data: actor.user });
});

describe("Finance uploads and extraction with actual source helpers", () => {
  it.each([[alice, ws], [bob, "ws-other"]] as const)("preserves exact originals and derives parsed content for %j", async (actor, workspaceId) => {
    const uploaded = await upload(actor, workspaceId);
    const original = fixture.tables.document[0];
    const input = fixture.tables.financeReportUploadInput[0];
    expect(input).toMatchObject({ uploadedByUserId: actor.kind === "user" ? actor.user.id : "", batchId: uploaded.batch.id,
      documentId: original.id, fileSizeBytes: bytes.length, mimeType: "text/csv" });
    expect(fixture.tables.artifactInputLineage.find(row => row.artifactType === "Document").origin).toBe("HUMAN_ORIGINAL");
    const params = await job(uploaded.batch.id, workspaceId);
    expect(await runFinanceReportImportExtractionJob(params)).toMatchObject({ skipped: false });
    const document = fixture.tables.document[0];
    expect(document.textContent).toContain("Revenue");
    for (const reader of [alice, bob]) {
      const roots = await captureArtifactInputProof(reader, workspaceId, [{ kind: "Document", id: document.id }, { kind: "BrainSource", id: uploaded.batch.brainSourceId! }]);
      expect(await isArtifactInputProofReadable(reader, workspaceId, roots)).toBe(true);
      await expect(captureArtifactInputProof(reader, workspaceId === ws ? "ws-other" : ws, [{ kind: "Document", id: document.id }])).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    }
    expect(fixture.tables.artifactInputSnapshot.some(row => row.sourceKind === "Document" && row.contentJson.textContent === null)).toBe(true);
    const receipts = fixture.tables.artifactInputLineage.length;
    expect(await runFinanceReportImportExtractionJob(params)).toMatchObject({ skipped: true });
    expect(fixture.tables.artifactInputLineage).toHaveLength(receipts);
  });

  it("does not certify or return a legacy upload even when its uploader id matches", async () => {
    const uploaded = await upload();
    fixture.tables.financeReportUploadInput = [];
    await expect(upload()).rejects.toMatchObject({ code: "FINANCE_REPORT_SOURCE_NOT_READY" });
    await expect(runFinanceReportImportExtractionJob(await job(uploaded.batch.id))).rejects.toMatchObject({ code: "FINANCE_REPORT_SOURCE_NOT_READY" });
    expect(storage.get).not.toHaveBeenCalled();
    expect(fixture.tables.document[0].textContent).toBeNull();
  });

  it("requires the exact current lease and prevents serialized receipt forgery", async () => {
    const uploaded = await upload();
    const params = await job(uploaded.batch.id);
    await expect(runFinanceReportImportExtractionJob({ ...params, expectedLease: undefined })).rejects.toMatchObject({ code: "FINANCE_REPORT_SOURCE_NOT_READY" });
    for (const change of [{ lockedBy: "other" }, { lockedAt: new Date("2026-10-13T12:01:00Z") }]) {
      await expect(runFinanceReportImportExtractionJob({ ...params, expectedLease: { ...lease, ...change } })).rejects.toMatchObject({ code: "FINANCE_REPORT_EXTRACTION_CONFLICT" });
    }
    const claim = await claimFinanceReportImportExtraction({ ...params, retryCount: 1 });
    if (claim.skipped) throw new Error("Expected claim");
    await expect(completeFinanceReportImportExtraction({ ...params, expectedVersion: claim.version, receipt: { kind: "FINANCE_REPORT_EXTRACTION" },
      extraction: { fileHash: claim.fileHash, fileSizeBytes: bytes.length, mimeType: "text/csv", format: "CSV", text: "forged", metadata: {} } })).rejects.toMatchObject({ code: "FINANCE_REPORT_SOURCE_NOT_READY" });
    expect(fixture.tables.document[0].textContent).toBeNull();
  });

  it.each([
    { type: "unrelated.job" }, { status: "PENDING" }, { attempts: 2 }, { payload: { batchId: "other-batch" } },
  ])("rejects a mismatched current job boundary %j", async changed => {
    const uploaded = await upload();
    const params = await job(uploaded.batch.id);
    Object.assign(fixture.tables.workflowJob[0], changed);
    const receipts = fixture.tables.artifactInputLineage.length;
    await expect(runFinanceReportImportExtractionJob(params)).rejects.toMatchObject({ code: "FINANCE_REPORT_EXTRACTION_CONFLICT" });
    expect(storage.get).not.toHaveBeenCalled();
    expect(fixture.tables.artifactInputLineage).toHaveLength(receipts);
  });

  it.each(["permission", "source", "lease", "bytes"])("withholds extraction when %s changes during storage", async reason => {
    const uploaded = await upload();
    const params = await job(uploaded.batch.id);
    storage.get.mockImplementationOnce(async () => {
      if (reason === "permission") fixture.revoked.add("alice");
      if (reason === "source") fixture.tables.document[0].title = "Changed title";
      if (reason === "lease") fixture.tables.workflowJob[0].lockedBy = "new-worker";
      return { data: reason === "bytes" ? Buffer.from("substituted") : Buffer.from(bytes), contentType: "text/csv" };
    });
    const extract = vi.fn(extractFinanceReportFile);
    await expect(runFinanceReportImportExtractionJob({ ...params, extract })).rejects.toThrow();
    expect(extract).not.toHaveBeenCalled();
    expect(fixture.tables.document[0].textContent).toBeNull();
  });

  it("withholds output after parser-time revocation and preserves current human edits", async () => {
    const uploaded = await upload();
    const params = await job(uploaded.batch.id);
    const extract = vi.fn(async (input: Parameters<typeof extractFinanceReportFile>[0]) => {
      const result = await extractFinanceReportFile(input);
      fixture.tables.document[0].textContent = "Human replacement";
      return result;
    });
    await expect(runFinanceReportImportExtractionJob({ ...params, extract })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.tables.document[0].textContent).toBe("Human replacement");
    expect(fixture.tables.event).toHaveLength(0);
  });

  it("denies a revoked uploader and bare bootstrap Finance reads", async () => {
    const uploaded = await upload();
    const params = await job(uploaded.batch.id);
    fixture.departed.add("alice");
    await expect(runFinanceReportImportExtractionJob(params)).rejects.toThrow();
    expect(storage.get).not.toHaveBeenCalled();
    const bootstrap = { kind: "agent", authProvider: "bootstrap", label: "forged", workspaceIds: [ws] } as AppActor;
    await expect(captureArtifactInputProof(bootstrap, ws, [{ kind: "Document", id: uploaded.batch.documentId! }])).rejects.toThrow();
  });
});

import { prepareFinanceReportImportProposalInput, claimFinanceReportImportProposal, bindFinanceReportProposalBehavior,
  assertFinanceReportProposalInputCurrent, persistFinanceReportImportProposal, failFinanceReportImportProposal } from "./finance-import-proposal";
import { listFinanceReportImports, getFinanceReportImport, editFinanceReportImportCandidate, reviewFinanceReportImport } from "./finance-import-review";
const textClaim = (id: string) => ({ id, role: "TEXT" as const, source: { kind: "CELL" as const, sheet: "Report", row: 1, column: 1, evidence: id } });
const interpretation = { version: 1, classification: { reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL", cadence: "MONTHLY",
  reportTypeEvidenceClaimIds: ["type"], basisEvidenceClaimIds: ["basis"], cadenceEvidenceClaimIds: ["cadence"], confidence: 1 },
  numericFormat: { status: "RESOLVED", version: 1, decimalSeparator: "DOT", groupingSeparator: "NONE", amountScale: 1,
    decimalSeparatorEvidenceClaimIds: [], groupingSeparatorEvidenceClaimIds: [], amountScaleEvidenceClaimIds: ["scale"], confidence: 1 },
  evidenceClaims: ["type", "basis", "cadence", "scale"].map(textClaim), exceptions: [] };
const proposed = { sourceKey: "a".repeat(64), sourceLocation: { kind: "CELL", sheet: "Report", row: 2, column: 2, evidence: "100" },
  sourceLabel: "Revenue", sourcePath: ["Revenue"], proposedAccountPath: ["Revenue"], factKind: "LEAF" as const,
  periodStart: "2026-01-01", periodEnd: "2026-01-31", amountCents: 10_000, extractionJson: { claimId: "amount" },
  proposalJson: { mappingId: "mapping-1", numericFormat: { version: 1, decimalSeparator: "DOT", groupingSeparator: "NONE", amountScale: 1 } }, confidenceBps: 9900, evidenceMd: "Report R2C2" };
async function modelClaim(actor = alice, workspaceId = ws, fileBuffer = bytes) {
  const uploadResult = await createFinanceReportImportUpload(actor, { workspaceId, fileBuffer, fileName: "synthetic.csv", mimeType: "text/csv", storage });
  await runFinanceReportImportExtractionJob({ ...await job(uploadResult.batch.id, workspaceId), storage: { ...storage, get: async () => ({ data: Buffer.from(fileBuffer), contentType: "text/csv" }) } });
  const batch = fixture.tables.financeImportBatch.find(row => row.id === uploadResult.batch.id);
  const workflow = await fixture.prisma.workflowJob.create({ data: { workspaceId, type: "finance-report-import.interpret", payload: { batchId: batch.id, expectedVersion: batch.version }, status: "RUNNING", attempts: 1, ...lease } });
  const agentRun = await fixture.prisma.agentRun.create({ data: { workspaceId, status: "RUNNING" } });
  const params = { workspaceId, batchId: batch.id, expectedVersion: batch.version, workflowJobId: workflow.id, attempts: 1, expectedLease: lease, agentRunId: agentRun.id };
  const planned = await prepareFinanceReportImportProposalInput(params);
  expect(planned.actor.kind).toBe("user");
  const claim = await claimFinanceReportImportProposal(params);
  if (claim.skipped) throw new Error(`Expected model claim: ${batch.stage}/${batch.safeErrorCode}`);
  const behavior = await fixture.prisma.agentIdentity.create({ data: { workspaceId, name: "finance-report-import", isActive: true, isArchived: false } });
  await recordArtifactInputLineage({ tx: fixture.prisma, actor, workspaceId, artifact: { kind: "AgentIdentity", id: behavior.id }, content: behavior, origin: "HUMAN_ORIGINAL", inputs: [] });
  const behaviorRoots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "AgentIdentity", id: behavior.id, snapshot: behavior }]);
  await bindFinanceReportProposalBehavior(claim.receipt, behaviorRoots);
  return { params, claim, persist: { ...params, expectedVersion: claim.version, receipt: claim.receipt, interpretation,
    currency: { state: "RESOLVED" as const, code: "EUR", source: "DOCUMENT" as const }, periodStart: "2026-01-01", periodEnd: "2026-01-31", candidates: [proposed], warningCount: 0, blockerCount: 0 } };
}
describe("Finance model and review with actual complete receipts", () => {
  it.each([[alice, ws], [bob, "ws-other"]] as const)("preserves complete model inputs and human edits for %j", async (actor, workspaceId) => {
    const state = await modelClaim(actor, workspaceId);
    expect(state.claim.workspaceCurrencyCodes).toEqual([]);
    const saved = await persistFinanceReportImportProposal(state.persist);
    expect(await isArtifactInputProofReadable(actor, workspaceId, saved.lineageRoots)).toBe(true);
    const detail = await getFinanceReportImport(actor, { workspaceId, batchId: saved.batchId });
    expect(detail).toMatchObject({ addCount: 1, candidates: [{ amountCents: 10_000, application: null }] });
    const row = detail.candidates[0]!;
    const edited = await editFinanceReportImportCandidate(actor, { workspaceId, batchId: saved.batchId, candidateId: row.id,
      expectedVersion: saved.version, expectedCandidateVersion: row.version, amountCents: 11_000 });
    const changed = await getFinanceReportImport(actor, { workspaceId, batchId: saved.batchId });
    expect(changed.candidates[0]?.amountCents).toBe(11_000);
    await reviewFinanceReportImport(actor, { workspaceId, batchId: saved.batchId, expectedVersion: edited.version,
      mode: "APPROVE", candidateId: row.id, candidateVersions: [{ id: row.id, expectedVersion: edited.candidateVersion }], acceptWarnings: true });
    expect((await getFinanceReportImport(actor, { workspaceId, batchId: saved.batchId })).candidates[0]?.reviewState).toBe("APPROVED");
    expect(fixture.tables.artifactInputSnapshot.some(row => row.sourceKind === "FinanceImportCandidate" && row.contentJson.amountCents === 10_000)).toBe(true);
    expect(fixture.tables.artifactInputLineage.filter(row => ["FinanceImportBatch", "FinanceImportCandidate"].includes(row.artifactType)).every(row => row.origin === "DERIVED")).toBe(true);
    await expect(getFinanceReportImport(actor, { workspaceId: workspaceId === ws ? "ws-other" : ws, batchId: saved.batchId })).rejects.toMatchObject({ code: "FINANCE_REPORT_IMPORT_NOT_FOUND" });
  });
  it.each(["permission", "membership", "source", "lease", "upload"])("rechecks %s changes before the model and persistence", async changed => {
    const state = await modelClaim();
    if (changed === "permission") fixture.revoked.add("alice");
    if (changed === "membership") fixture.departed.add("alice");
    if (changed === "source") fixture.tables.brainSource[0].content = "changed source";
    if (changed === "lease") fixture.tables.workflowJob.at(-1)!.lockedBy = "replacement-worker";
    if (changed === "upload") fixture.tables.financeReportUploadInput[0].fileHash = "changed binding";
    await expect(assertFinanceReportProposalInputCurrent(state.claim.receipt)).rejects.toThrow();
    await expect(persistFinanceReportImportProposal(state.persist)).rejects.toThrow();
    expect(fixture.tables.financeImportCandidate).toEqual([]);
    expect(fixture.tables.financeImportBatch[0].stage).toBe("MAPPING");
  });
  it("denies forged receipts and stores a bounded failure under the original job version", async () => {
    const state = await modelClaim();
    await expect(persistFinanceReportImportProposal({ ...state.persist, receipt: { kind: "FINANCE_REPORT_PROPOSAL" } })).rejects.toMatchObject({ code: "FINANCE_REPORT_SOURCE_NOT_READY" });
    await failFinanceReportImportProposal({ ...state.params, expectedVersion: state.claim.version, receipt: state.claim.receipt, failureCode: "PROVIDER_ERROR" });
    expect((await listFinanceReportImports(alice, ws))[0]).toMatchObject({ stage: "FAILED", safeErrorCode: "FINANCE_REPORT_PROVIDER_ERROR" });
  });
  it("does not give unproved matching facts a false ADD or expose their values", async () => {
    const state = await modelClaim();
    fixture.prisma.financeReportFact.findMany.mockResolvedValueOnce([{ id: "private-fact", amountCents: 123456789 }]);
    await expect(persistFinanceReportImportProposal(state.persist)).rejects.toMatchObject({ code: "FINANCE_REPORT_SOURCE_NOT_READY" });
    expect(fixture.tables.financeImportCandidate).toEqual([]);
  });
  it("filters unknown batches and child candidates before result limits and aggregate counts", async () => {
    const state = await modelClaim();
    const saved = await persistFinanceReportImportProposal(state.persist);
    const known = fixture.tables.financeImportBatch[0];
    fixture.tables.financeImportBatch.unshift(...Array.from({ length: 105 }, (_, index) => ({ ...known, id: `unknown-${index}` })));
    fixture.tables.financeImportCandidate.push({ ...fixture.tables.financeImportCandidate[0], id: "unknown-child", amountCents: 99_999 });
    const rows = await listFinanceReportImports(bob, ws);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: saved.batchId, addCount: 1 });
    const detail = await getFinanceReportImport(bob, { workspaceId: ws, batchId: saved.batchId });
    expect(detail.candidates).toHaveLength(1);
    fixture.revoked.add("bob");
    expect(await listFinanceReportImports(bob, ws)).toEqual([]);
    await expect(getFinanceReportImport(bob, { workspaceId: ws, batchId: saved.batchId })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });
});

import { applyFinanceReportImport } from "./finance-import-application";
import { rerunFinanceReportImportReconciliation } from "./finance-import-reconciliation";
async function approveAndApply(state: Awaited<ReturnType<typeof modelClaim>>) {
  const saved = await persistFinanceReportImportProposal(state.persist);
  const candidate = fixture.tables.financeImportCandidate.find(row => row.batchId === saved.batchId);
  const approved = await reviewFinanceReportImport(alice, { workspaceId: ws, batchId: saved.batchId, expectedVersion: saved.version,
    mode: "APPROVE", candidateId: candidate.id, candidateVersions: [{ id: candidate.id, expectedVersion: candidate.version }], acceptWarnings: true });
  const input = { workspaceId: ws, batchId: saved.batchId, expectedVersion: approved.version,
    candidateVersions: [{ id: candidate.id, expectedVersion: fixture.tables.financeImportCandidate.find(row => row.id === candidate.id).version }] };
  return { input, result: await applyFinanceReportImport(alice, input) };
}
describe("Finance canonical application with actual lineage helpers", () => {
  it("derives complete reports/facts/receipts, preserves exact retry and denies revoked retry", async () => {
    const state = await modelClaim();
    const { input, result } = await approveAndApply(state);
    expect(result).toMatchObject({ appliedNow: 1, appliedCount: 1, stage: "APPLIED", receipts: [{ outcome: "CREATED" }] });
    for (const [kind, model] of [["FinanceReport", "financeReport"], ["FinanceReportFact", "financeReportFact"], ["FinanceImportApplication", "financeImportApplication"]] as const) {
      const row = fixture.tables[model][0];
      expect((await captureArtifactInputProof(bob, ws, [{ kind, id: row.id, snapshot: row }])).length).toBeGreaterThan(0);
      const exact = await captureArtifactInputProof(alice, ws, [{ kind, id: row.id, snapshot: row }]);
      const fields = kind === "FinanceReport" ? ["workspaceId", "reportType", "basis", "cadence", "currency", "periodStart", "periodEnd", "asOfDate", "title", "status", "sourceBatchId", "version"]
        : kind === "FinanceReportFact" ? ["workspaceId", "reportId", "accountPath", "kind", "periodStart", "periodEnd", "amountCents", "dimensions", "semanticKey", "sourceBatchId", "sourceCandidateId", "appliedByUserId", "version"]
        : ["workspaceId", "batchId", "candidateId", "idempotencyKey", "targetType", "targetFactId", "beforeValueJson", "afterValueJson", "beforeValueHash", "afterValueHash", "outcome", "appliedByUserId", "appliedAt"];
      for (const field of fields) {
        const previous = row[field]; row[field] = "unproved mutation";
        expect(await isArtifactInputProofReadable(alice, ws, exact), `${kind}.${field}`).toBe(false); row[field] = previous;
      }
    }
    expect(await applyFinanceReportImport(alice, input)).toMatchObject({ noOp: true, appliedNow: 0, appliedCount: 1 });
    expect(fixture.tables.financeReportFact).toHaveLength(1);
    expect((await getFinanceReportImport(bob, { workspaceId: ws, batchId: result.batchId })).candidates[0]?.application).toMatchObject({ outcome: "CREATED", targetFactId: fixture.tables.financeReportFact[0].id });
    fixture.revoked.add("alice");
    await expect(applyFinanceReportImport(alice, input)).rejects.toThrow();
    expect(fixture.tables.financeReportFact).toHaveLength(1);
  });
  it("restates a proven current fact from a separately proven upload and keeps the old value immutable", async () => {
    await approveAndApply(await modelClaim());
    const oldFact = structuredClone(fixture.tables.financeReportFact[0]);
    const oldFactManifest = structuredClone([...fixture.tables.artifactInputLineage].reverse().find((row: any) =>
      row.artifactType === "FinanceReportFact" && row.artifactId === oldFact.id));
    const second = await modelClaim(alice, ws, Buffer.from(bytes.toString().replace("100", "200")));
    second.persist.candidates = [{ ...proposed, amountCents: 20_000 }];
    const saved = await persistFinanceReportImportProposal(second.persist);
    const candidate = fixture.tables.financeImportCandidate.find(row => row.batchId === saved.batchId);
    expect(candidate).toMatchObject({ action: "UPDATE", currentAmountCents: 10_000 });
    const approved = await reviewFinanceReportImport(bob, { workspaceId: ws, batchId: saved.batchId, expectedVersion: saved.version, mode: "APPROVE",
      candidateId: candidate.id, candidateVersions: [{ id: candidate.id, expectedVersion: candidate.version }], acceptWarnings: true });
    const applied = await applyFinanceReportImport(bob, { workspaceId: ws, batchId: saved.batchId, expectedVersion: approved.version,
      candidateVersions: [{ id: candidate.id, expectedVersion: candidate.version }] });
    expect(applied.receipts[0]?.outcome).toBe("UPDATED");
    expect(fixture.tables.financeReportFact).toHaveLength(1); expect(fixture.tables.financeReportFact[0].amountCents).toBe(20_000);
    const factSnapshots = fixture.tables.artifactInputSnapshot.filter(row => row.sourceKind === "FinanceReportFactRevision"
      && row.contentJson.factId === oldFact.id);
    const currentBatch = fixture.tables.financeImportBatch.find(row => row.id === saved.batchId);
    const currentBatchManifest = [...fixture.tables.artifactInputLineage].reverse().find((row: any) => row.artifactType === "FinanceImportBatch"
      && row.artifactId === saved.batchId);
    const reachable = new Set<string>();
    const pending = [...currentBatchManifest.rootsJson];
    while (pending.length) {
      const root = pending.pop();
      if (root.kind !== "ArtifactInputSnapshot" || reachable.has(root.id)) continue;
      reachable.add(root.id);
      const snapshot = fixture.tables.artifactInputSnapshot.find(row => row.id === root.id);
      if (snapshot) pending.push(...snapshot.rootsJson);
    }
    const prior = factSnapshots.find(row => row.contentJson.amountCents === 10_000 && reachable.has(row.id));
    expect(prior).toBeDefined();
    expect(prior.contentJson).toMatchObject({amountCents: 10_000, reportId: oldFact.reportId,
      sourceBatchId: oldFact.sourceBatchId, sourceCandidateId: oldFact.sourceCandidateId});
    expect(fixture.tables.artifactInputLineage.find(row => row.id === oldFactManifest.id)).toEqual(oldFactManifest);
    const params = {workspaceId: ws, artifact: {kind: "FinanceImportBatch" as const, id: saved.batchId},
      content: currentBatch, roots: currentBatchManifest.rootsJson,
      permissionEpochs: currentBatchManifest.permissionEpochsJson, db: fixture.prisma};
    expect(await isArtifactInputPermissionEpochCoverageComplete(params)).toBe(true);
    expect(new Set(factSnapshots.filter(row => reachable.has(row.id)).map(row => row.sourceFingerprint)).size).toBeGreaterThanOrEqual(2);
    const exactOldSnapshot = structuredClone(prior);
    prior.contentJson.amountCents = 999_999;
    expect(await isArtifactInputPermissionEpochCoverageComplete(params)).toBe(false);
    Object.assign(prior, exactOldSnapshot);
    expect(await isArtifactInputPermissionEpochCoverageComplete(params)).toBe(true);
    await expect(getFinanceReportImport(bob, {workspaceId: ws, batchId: saved.batchId})).resolves.toBeDefined();
    fixture.revoked.add("bob");
    await expect(getFinanceReportImport(bob, {workspaceId: ws, batchId: saved.batchId})).rejects.toThrow();
    fixture.revoked.delete("bob");
    expect(await isArtifactInputPermissionEpochCoverageComplete(params)).toBe(true);
    const oldReportEpoch = JSON.stringify([ws, "FinanceReport", oldFact.reportId]);
    fixture.permissionEpochs.set(oldReportEpoch, (fixture.permissionEpochs.get(oldReportEpoch) ?? 0n) + 1n);
    expect(await isArtifactInputPermissionEpochCoverageComplete(params)).toBe(false);
  });
  it("preserves partial applications and derives a narrowed report on rejection", async () => {
    const state = await modelClaim();
    state.persist.candidates.push({ ...proposed, sourceKey: "b".repeat(64), sourcePath: ["Expense"], proposedAccountPath: ["Expense"], periodStart: "2025-12-01", periodEnd: "2025-12-31" });
    const saved = await persistFinanceReportImportProposal(state.persist);
    const rows = fixture.tables.financeImportCandidate.filter(row => row.batchId === saved.batchId);
    const approved = await reviewFinanceReportImport(alice, { workspaceId: ws, batchId: saved.batchId, expectedVersion: saved.version,
      mode: "APPROVE", candidateId: rows[0].id, candidateVersions: [{ id: rows[0].id, expectedVersion: rows[0].version }], acceptWarnings: true });
    const partial = await applyFinanceReportImport(alice, { workspaceId: ws, batchId: saved.batchId, expectedVersion: approved.version,
      candidateVersions: [{ id: rows[0].id, expectedVersion: rows[0].version }] });
    expect(partial.stage).toBe("PARTIALLY_APPLIED");
    await reviewFinanceReportImport(bob, { workspaceId: ws, batchId: saved.batchId, expectedVersion: partial.version,
      mode: "REJECT", candidateId: rows[1].id, candidateVersions: [{ id: rows[1].id, expectedVersion: rows[1].version }] });
    expect((await getFinanceReportImport(alice, { workspaceId: ws, batchId: saved.batchId })).stage).toBe("APPLIED");
    expect(fixture.tables.financeReport[0]).toMatchObject({ periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-01-31") });
    await expect(captureArtifactInputProof(alice, ws, [{ kind: "FinanceReport", id: fixture.tables.financeReport[0].id }])).resolves.toBeTruthy();
  });
  it("withholds missing immutable revision provenance before decisions or writes", async () => {
    await approveAndApply(await modelClaim());
    const next = await modelClaim(alice, ws, Buffer.from(bytes.toString().replace("100", "300")));
    fixture.tables.artifactInputLineage = fixture.tables.artifactInputLineage.filter(row => row.artifactType !== "FinanceReportFactRevision");
    const before = structuredClone(fixture.tables.financeReportFact);
    await expect(persistFinanceReportImportProposal(next.persist)).rejects.toMatchObject({ code: "FINANCE_REPORT_SOURCE_NOT_READY" });
    expect(fixture.tables.financeReportFact).toEqual(before);
    expect(fixture.tables.financeImportCandidate.filter(row => row.batchId === next.params.batchId)).toEqual([]);
  });
  it("requires complete candidate numeric context, ignores legacy events, and safely reconciles current proofs", async () => {
    const state = await modelClaim();
    const saved = await persistFinanceReportImportProposal({ ...state.persist, currency: { state: "UNRESOLVED", code: null, source: null }, blockerCount: 1,
      blocker: { code: "CURRENCY_UNRESOLVED", message: "Choose currency." } });
    const candidate = fixture.tables.financeImportCandidate[0];
    const input = { workspaceId: ws, batchId: saved.batchId, expectedVersion: saved.version,
      candidateVersions: [{ id: candidate.id, expectedVersion: candidate.version }], confirmedCurrency: "USD", confirmedAmountScale: 1 };
    const result = await rerunFinanceReportImportReconciliation(alice, input);
    expect(result).toMatchObject({ stage: "READY_FOR_REVIEW", addCount: 1 });
    expect((await getFinanceReportImport(bob, { workspaceId: ws, batchId: saved.batchId })).resolvedCurrency).toBe("USD");
    fixture.tables.artifactInputLineage = fixture.tables.artifactInputLineage.filter(row => row.artifactType !== "FinanceImportCandidate");
    await expect(rerunFinanceReportImportReconciliation(alice, { ...input, expectedVersion: result.version,
      candidateVersions: [{ id: candidate.id, expectedVersion: fixture.tables.financeImportCandidate[0].version }] })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });
});
