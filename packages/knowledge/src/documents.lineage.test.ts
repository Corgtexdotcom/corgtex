import { installSourcePermissionEpochFixture } from "../../domain/src/source-permission-epochs.test-fixture";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const fixture = vi.hoisted(() => {
  const tables: Record<string, any[]> = {};
  const time = new Date("2026-10-12T09:00:00Z");
  const match = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === "AND") return value.every((clause: any) => match(row, clause));
    if (["conversation", "member", "account", "contact", "deal"].includes(key)) return true;
    if (key === "OR") return value.some((clause: any) => match(row, clause));
    if (value instanceof Date) return row[key] instanceof Date && row[key].getTime() === value.getTime();
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (value.in) return value.in.includes(row[key]);
      if ("not" in value) return row[key] !== value.not;
      if ("gt" in value) return row[key] > value.gt;
      if ("lt" in value) return row[key] < value.lt;
      if (value.path) return value.path.reduce((current: any, part: string) => current?.[part], row[key]) === value.equals;
      return true;
    }
    return row[key] === value;
  });
  const project = (row: any, args: any) => {
    if (!row) return null;
    let result = { ...row };
    if (args.include?.account) result.account = tables.crmAccount.find((parent) => parent.id === row.accountId) ?? null;
    if (args.include?.contact) result.contact = tables.crmContact.find((parent) => parent.id === row.contactId) ?? null;
    if (args.include?.deal) result.deal = tables.crmDeal.find((parent) => parent.id === row.dealId) ?? null;
    if (args.select) result = Object.fromEntries(Object.keys(args.select).map((key) => [key, result[key]]));
    return result;
  };
  const names = ["informationCategoryPolicy", "crmAccount", "crmContact", "crmDeal", "crmActivity", "crmDealStageTransition", "crmConversation", "crmConversationMessage",
    "crmProspectWorkspace", "crmCommunicationSuggestion", "document", "meeting", "meetingInsight", "artifactInputLineage", "artifactInputSnapshot", "workspace", "executionRequest", "executionResult", "demoLead", "crmQualification", "workflowJob", "brainArticle", "brainSource", "mcpToolInput", "member", "user", "knowledgeChunk"];
  const prisma: any = { $queryRaw: vi.fn(async () => []), $executeRaw: vi.fn(async () => 1),
    auditLog: { create: vi.fn(async () => ({})) }, event: { createMany: vi.fn(async () => ({ count: 1 })) } };
  for (const name of names) {
    tables[name] = [];
    prisma[name] = {
      findFirst: vi.fn(async (args: any) => {
        const rows = tables[name].filter((row) => match(row, args.where));
        return project(name === "artifactInputLineage" ? rows.at(-1) : rows[0], args);
      }),
      findUnique: vi.fn(async (args: any) => project(tables[name].find((row) => match(row, args.where)), args)),
      findMany: vi.fn(async (args: any) => {
        const rows = tables[name].filter((row) => match(row, args.where));
        const order = Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : [];
        rows.sort((left, right) => { for (const field of order) { const key = Object.keys(field)[0]; if (left[key] === right[key]) continue;
          return (left[key] > right[key] ? 1 : -1) * (field[key] === "desc" ? -1 : 1); } return 0; });
        if (name === "artifactInputLineage") rows.sort((left, right) => right.revision - left.revision);
        const start = args.cursor ? rows.findIndex((row) => row.id === args.cursor.id) + (args.skip ?? 0) : args.skip ?? 0;
        return rows.slice(start, start + (args.take ?? rows.length)).map((row) => project(row, args));
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `${name}-${tables[name].length + 1}`,
          ...(["document", "brainSource", "meeting"].includes(name) ? { informationCategory: "GENERAL" } : {}), archivedAt: null, createdAt: time,
          ...(["document", "brainSource"].includes(name) ? { accessDomain: "WORKSPACE" } : {}),
          ...(name === "executionRequest" ? { status: "PENDING", results: [], claimedAt: null, completedAt: null } : {}),
          ...(name !== "crmActivity" && name !== "crmDealStageTransition" ? { updatedAt: time } : {}), ...data };
        tables[name].push(row); return { ...row };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const index = tables[name].findIndex((row) => match(row, where));
        const patched = Object.fromEntries(Object.entries(data).map(([key, value]: [string, any]) => [key, value && typeof value === "object" && "increment" in value ? tables[name][index][key] + value.increment : value]));
        tables[name][index] = { ...tables[name][index], ...patched }; return { ...tables[name][index] };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const matches = tables[name].filter((row) => match(row, where));
        for (const row of matches) Object.assign(row, data);
        return { count: matches.length };
      }),
    };
  }
  prisma.$transaction = vi.fn(async (run: (tx: any) => Promise<any>) => {
    const before = Object.fromEntries(names.map((name) => [name, tables[name].map((row) => ({ ...row }))]));
    try { return await run({ ...prisma }); } catch (error) { for (const name of names) tables[name] = before[name]; throw error; }
  });
  return { prisma, tables, time, revoked: new Set<string>(), departed: new Set<string>() };
});
vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma, env: { APP_URL: "https://synthetic.test" }, getSharedStateBackend: () => "redis", logger: { warn: vi.fn() }, toInputJson: (value: unknown) => value }));
vi.mock("../../domain/src/auth", () => ({ requireWorkspaceMembership: vi.fn(async ({ actor, workspaceId }) => {
  if (!["ws-crm", "ws-other"].includes(workspaceId) || fixture.departed.has(actor.user?.id ?? "agent")) throw Object.assign(new Error("Membership revoked"), { status: 403 });
  return { id: `member-${actor.user?.id ?? "agent"}`, role: "MEMBER" };
}), requireGlobalOperator: vi.fn() }));
vi.mock("../../domain/src/brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async (actor) => actor.user?.id === "finance" && !fixture.revoked.has("finance")
  ? ["WORKSPACE", "FINANCE"] : ["WORKSPACE"]) }));
vi.mock("../../domain/src/crm-archive-guards", () => ({
  lockCrmLinks: vi.fn(), lockCrmLinkClosure: vi.fn(), lockCrmProspectProvisioning: vi.fn(),
  activeCrmParentWhere: () => ({}),
}));
const remote = vi.hoisted(() => ({ embed: vi.fn(), azure: vi.fn(), provider: "none", put: vi.fn(), remove: vi.fn() }));
vi.mock("@corgtex/models", () => ({ defaultModelGateway: { embed: remote.embed } }));
vi.mock("./retrieval", () => ({ invalidateKnowledgeCache: vi.fn() }));
vi.mock("./counts", () => ({ countReadableKnowledgeChunks: vi.fn(async () => 0) }));
vi.mock("./azure-search", () => ({ getKnowledgeSearchProvider: () => remote.provider, isAzureKnowledgeSearchConfigured: () => true,
  syncAzureKnowledgeSource: remote.azure, logAzureKnowledgeIndexingWarning: vi.fn() }));
vi.mock("@corgtex/storage", () => ({ defaultStorage: { put: remote.put, delete: remote.remove } }));
vi.mock("../../domain/src/events", () => ({ appendEvents: vi.fn() }));
vi.mock("../../domain/src/trial-entitlements", () => ({ assertTrialStorageCapacity: vi.fn(), lockAndAssertTrialStorageCapacity: vi.fn() }));
vi.mock("@corgtex/domain", async () => {
  const lineage = await import("../../domain/src/source-lineage");
  const documents = await import("../../domain/src/documents");
  const auth = await import("../../domain/src/auth");
  const duplicate = await import("../../domain/src/duplicate-guard");
  const guards = await import("../../domain/src/trial-entitlements");
  const errors = await import("../../domain/src/errors");
  const commit = await import("../../domain/src/artifact-commit-preflight");
  return { ...lineage, ...documents, ...auth, ...duplicate, ...guards, ...errors, ...commit,
    mergeArtifactInputProofs: (await import("../../domain/src/digest-lineage")).mergeArtifactInputProofs,
    scanSourceReadableRecords: (await import("../../domain/src/source-scoped-read")).scanSourceReadableRecords,
    appendEvents: vi.fn(), isGlobalOperator: () => false, lockWorkspaceArchiveArtifact: vi.fn(),
    getStorageUsageSummary: async () => ({ isOverLimit: false }), findSourceArticleImpacts: async () => new Map(),
  };
});
import { getWorkspaceIndexingHealth, syncDocumentKnowledge, syncKnowledgeForSource } from "./chunks";
import { ingestFile } from "./file-ingestion";
import { captureArtifactInputProof, invalidateArtifactInputLineage, readableArtifactIds, recordArtifactInputLineage } from "../../domain/src/source-lineage";
const general = { kind: "user", user: { id: "general", email: "general@synthetic.test" } } as AppActor;
const finance = { kind: "user", user: { id: "finance", email: "finance@synthetic.test" } } as AppActor;
const ws = "ws-crm";
async function doc(id = "document", domain = "WORKSPACE", extra: Record<string, unknown> = {}) {
  const row = await fixture.prisma.document.create({ data: { id, workspaceId: ws, title: "Synthetic document", source: "native", mimeType: "text/plain",
    storageKey: `workspaces/${ws}/native/${id}`, accessDomain: domain, textContent: "Synthetic current source", metadata: {}, ...extra } });
  await recordArtifactInputLineage({ tx: fixture.prisma, actor: domain === "FINANCE" ? finance : general, workspaceId: row.workspaceId,
    artifact: { kind: "Document", id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] });
  return row;
}
async function privateCopy() {
  const input = await doc("finance-input", "FINANCE"); const copy = await doc("public-copy");
  await recordArtifactInputLineage({ tx: fixture.prisma, actor: finance, workspaceId: ws, artifact: { kind: "Document", id: copy.id }, content: copy,
    origin: "DERIVED", inputs: [{ kind: "Document", id: input.id }] });
  return copy;
}

describe("Document parser and index boundaries with real source receipts", () => {
  beforeEach(() => { for (const name of Object.keys(fixture.tables)) fixture.tables[name] = []; fixture.revoked.clear(); fixture.departed.clear(); vi.clearAllMocks();
    remote.provider = "none"; remote.embed.mockResolvedValue({ embeddings: [[0, 1]], usage: { model: "synthetic" } });
    remote.azure.mockResolvedValue({ skipped: true }); remote.put.mockResolvedValue({ success: true }); remote.remove.mockResolvedValue(undefined);
    fixture.prisma.knowledgeChunk.deleteMany = vi.fn(async () => { fixture.tables.knowledgeChunk = []; return { count: 1 }; });
    fixture.prisma.knowledgeChunk.createMany = vi.fn(async ({ data }: any) => { fixture.tables.knowledgeChunk.push(...data); return { count: data.length }; });
    installSourcePermissionEpochFixture(fixture.prisma);
  });
  it("admits a current native document before embedding and stores its exact parent receipt", async () => {
    const row = await doc();
    expect(await syncDocumentKnowledge({ workspaceId: ws, documentId: row.id })).toBe(1);
    expect(remote.embed).toHaveBeenCalledWith(expect.objectContaining({ input: ["Synthetic document\n\nSynthetic current source"] }));
    expect(await readableArtifactIds(general, ws, "KnowledgeChunk", fixture.tables.knowledgeChunk)).toEqual(new Set([fixture.tables.knowledgeChunk[0].id]));
  });
  it("withholds public-looking private-derived and UNKNOWN documents before model calls or chunk mutation", async () => {
    const copy = await privateCopy();
    expect(await syncDocumentKnowledge({ workspaceId: ws, documentId: copy.id })).toBe(0);
    const unknown = await doc("unknown");
    await invalidateArtifactInputLineage({ tx: fixture.prisma, workspaceId: ws, artifact: { kind: "Document", id: unknown.id }, content: unknown });
    expect(await syncDocumentKnowledge({ workspaceId: ws, documentId: unknown.id, lineageActor: general })).toBe(0);
    expect(remote.embed).not.toHaveBeenCalled(); expect(fixture.prisma.knowledgeChunk.deleteMany).not.toHaveBeenCalled();
  });
  it("keeps legacy documents without receipts out of model input and preserves original storage", async () => {
    const legacy = await fixture.prisma.document.create({ data: { id: "legacy", workspaceId: ws, title: "Legacy copy",
      source: "api", storageKey: "legacy-bytes", textContent: "Unproven old model output", metadata: {} } });
    expect(await syncDocumentKnowledge({ workspaceId: ws, documentId: legacy.id, lineageActor: general })).toBe(0);
    expect(remote.embed).not.toHaveBeenCalled(); expect(remote.put).not.toHaveBeenCalled();
    expect(fixture.tables.document[0].textContent).toBe("Unproven old model output");
    expect(fixture.tables.document[0].storageKey).toBe("legacy-bytes");
  });
  it("gates indexing totals, article paths and failed-job samples before ranking with real receipts", async () => {
    const original = await doc("original"); const privateDocument = await doc("private", "FINANCE");
    const source = await fixture.prisma.brainSource.create({ data: { id: "public-source", workspaceId: ws, sourceType: "DOC", title: "Proven source",
      content: original.textContent, metadata: { documentId: original.id } } });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: general, workspaceId: ws, artifact: { kind: "BrainSource", id: source.id },
      content: source, origin: "DERIVED", inputs: [{ kind: "Document", id: original.id }] });
    const privateSource = await fixture.prisma.brainSource.create({ data: { id: "private-source", workspaceId: ws, sourceType: "DOC", title: "Private-derived source",
      content: "Private copied data", metadata: { documentId: privateDocument.id } } });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: finance, workspaceId: ws, artifact: { kind: "BrainSource", id: privateSource.id },
      content: privateSource, origin: "DERIVED", inputs: [{ kind: "Document", id: privateDocument.id }] });
    const article = await fixture.prisma.brainArticle.create({ data: { id: "public-article", workspaceId: ws, title: "Proven article", slug: "proven", bodyMd: "Current body", isPrivate: false } });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: general, workspaceId: ws, artifact: { kind: "BrainArticle", id: article.id },
      content: article, origin: "HUMAN_ORIGINAL", inputs: [] });
    const hiddenArticle = await fixture.prisma.brainArticle.create({ data: { id: "private-article", workspaceId: ws, title: "Restricted title", slug: "private-path", bodyMd: "Copied private body", isPrivate: false } });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: finance, workspaceId: ws, artifact: { kind: "BrainArticle", id: hiddenArticle.id },
      content: hiddenArticle, origin: "DERIVED", inputs: [{ kind: "Document", id: privateDocument.id }] });
    for (let i = 0; i < 105; i++) {
      await fixture.prisma.workflowJob.create({ data: { id: `hidden-${i.toString().padStart(3, "0")}`, workspaceId: ws,
        eventId: `hidden-event-${i}`, type: "knowledge.sync.document", status: "FAILED", payload: { documentId: privateDocument.id },
        error: "Restricted provider response", createdAt: new Date() } });
    }
    const job = await fixture.prisma.workflowJob.create({ data: { id: "visible-job", workspaceId: ws, eventId: "event", type: "knowledge.sync.document",
      status: "FAILED", payload: { documentId: original.id }, error: "Unreceipted private provider response", createdAt: new Date() } });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: general, workspaceId: ws, artifact: { kind: "WorkflowJobInput", id: job.id },
      content: job, origin: "DERIVED", inputs: [{ kind: "Document", id: original.id }] });
    const health = await getWorkspaceIndexingHealth(ws, general);
    expect(health.metrics).toMatchObject({ totalArticles: 1, totalSources: 1, totalDocuments: 1 });
    expect(health.unchunkedArticles).toEqual([{ id: article.id, title: article.title, slug: article.slug }]);
    expect(health.recentErrors).toHaveLength(1); expect(health.recentErrors[0]).toContain("Indexing failed.");
    expect(JSON.stringify(health)).not.toMatch(/Restricted|private-path|provider response/);
    expect(fixture.prisma.workflowJob.findMany.mock.calls.some(([args]: any[]) => args.where.id?.gt)).toBe(true);
    expect(fixture.prisma.workflowJob.findMany.mock.calls.every(([args]: any[]) => args.select.error === undefined)).toBe(true);
    fixture.tables.document.find(row => row.id === original.id).metadata = { changed: true };
    const changed = await getWorkspaceIndexingHealth(ws, general);
    expect(changed.metrics.totalDocuments).toBe(0); expect(changed.metrics.totalSources).toBe(0); expect(changed.recentErrors).toEqual([]);
    expect(fixture.tables.workflowJob).toHaveLength(106);
  });
  it("rechecks every private ancestor after embedding and preserves previous chunks after grant loss", async () => {
    const copy = await privateCopy(); fixture.tables.knowledgeChunk.push({ id: "prior", workspaceId: ws, sourceType: "DOCUMENT", sourceId: copy.id });
    remote.embed.mockImplementationOnce(async () => { fixture.revoked.add("finance"); return { embeddings: [[0, 1]], usage: { model: "synthetic" } }; });
    expect(await syncDocumentKnowledge({ workspaceId: ws, documentId: copy.id, lineageActor: finance })).toBe(0);
    expect(remote.embed).toHaveBeenCalledTimes(1); expect(fixture.tables.knowledgeChunk.map(row => row.id)).toEqual(["prior"]);
    expect(remote.azure).not.toHaveBeenCalled();
  });
  it("rejects changed metadata and forged domains, not merely changed body text", async () => {
    const row = await doc();
    remote.embed.mockImplementationOnce(async () => { fixture.tables.document[0].metadata = { changed: true }; return { embeddings: [[0, 1]], usage: { model: "synthetic" } }; });
    expect(await syncDocumentKnowledge({ workspaceId: ws, documentId: row.id })).toBe(0);
    expect(fixture.prisma.knowledgeChunk.createMany).not.toHaveBeenCalled();
    const privateRow = await doc("finance", "FINANCE"); remote.embed.mockClear();
    expect(await syncKnowledgeForSource({ workspaceId: ws, sourceType: "DOCUMENT", sourceId: privateRow.id, sourceTitle: privateRow.title,
      accessDomain: "WORKSPACE", content: privateRow.textContent, lineageActor: finance })).toBe(0);
    expect(remote.embed).not.toHaveBeenCalled();
  });
  it("does not certify provider pseudo-Document ids or foreign workspace projections", async () => {
    await doc("foreign", "WORKSPACE", { workspaceId: "ws-other" });
    expect(await syncDocumentKnowledge({ workspaceId: ws, documentId: "foreign" })).toBe(0);
    expect(await syncKnowledgeForSource({ workspaceId: ws, sourceType: "DOCUMENT", sourceId: "oauth-doc-unproven", sourceTitle: "Unproven provider",
      accessDomain: "WORKSPACE", content: "Transient provider response" })).toBe(0);
    expect(remote.embed).not.toHaveBeenCalled(); expect(remote.azure).not.toHaveBeenCalled();
  });
  it("does not replay newer private or unproven SQL chunk bodies after an Azure indexing race", async () => {
    const row = await doc(); remote.provider = "azure";
    remote.azure.mockImplementationOnce(async () => {
      fixture.tables.document[0].accessDomain = "FINANCE";
      fixture.tables.knowledgeChunk = [{ id: "new-private-chunk", workspaceId: ws, sourceType: "DOCUMENT", sourceId: row.id,
        accessDomain: "WORKSPACE", content: "New private body", metadata: { sourceContentHash: "unproven" } }];
      return { skipped: false };
    });
    await expect(syncDocumentKnowledge({ workspaceId: ws, documentId: row.id })).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(remote.azure).toHaveBeenCalledTimes(1);
    expect(remote.azure.mock.calls[0][0].chunks[0].content).toBe("Synthetic document\n\nSynthetic current source");
  });
  it("keeps the parser projection and stored blob bound to the same native bytes", async () => {
    const bytes = Buffer.from("Original native bytes");
    remote.put.mockImplementationOnce(async (_key: string, buffer: Buffer) => { bytes.fill(120); expect(buffer.toString()).toBe("Original native bytes"); return { success: true }; });
    const result = await ingestFile(general, { workspaceId: ws, fileBuffer: bytes, fileName: "original.txt", mimeType: "text/plain" });
    expect(result.document.textContent).toBe("Original native bytes");
    expect((result.document.metadata as any).fileContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect((result.source!.metadata as any).fileContentHash).toBe((result.document.metadata as any).fileContentHash);
    expect(fixture.tables.artifactInputLineage.find(row => row.artifactType === "Document")?.origin).toBe("HUMAN_ORIGINAL");
    expect(fixture.tables.artifactInputLineage.find(row => row.artifactType === "BrainSource")?.origin).toBe("DERIVED");
    expect(await readableArtifactIds(general, ws, "BrainSource", fixture.tables.brainSource)).toEqual(new Set([result.source!.id]));
  });
  it("rejects stale copied context before exporting file bytes to storage", async () => {
    const input = await doc("input"); const roots = await captureArtifactInputProof(general, ws, [{ kind: "Document", id: input.id }]);
    fixture.tables.document[0].textContent = "Changed input";
    await expect(ingestFile(general, { workspaceId: ws, fileBuffer: Buffer.from("Stale copy"), fileName: "copy.txt", mimeType: "text/plain", lineageRoots: roots })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(remote.put).not.toHaveBeenCalled(); expect(fixture.tables.document).toHaveLength(1);
  });
  it("retains the captured input set even if the caller mutates its original root array during upload", async () => {
    const input = await doc("finance", "FINANCE"); const roots = await captureArtifactInputProof(finance, ws, [{ kind: "Document", id: input.id }]);
    const params = { workspaceId: ws, fileBuffer: Buffer.from("Captured copy"), fileName: "copy.txt", mimeType: "text/plain", lineageRoots: roots };
    remote.put.mockImplementationOnce(async () => { roots.splice(0); fixture.revoked.add("finance"); return { success: true }; });
    await expect(ingestFile(finance, params)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(remote.remove).toHaveBeenCalledTimes(1); expect(fixture.tables.document).toHaveLength(1);
  });
  it("rechecks copied context after storage and removes only the new blob when a grant changes", async () => {
    const input = await doc("finance", "FINANCE"); const roots = await captureArtifactInputProof(finance, ws, [{ kind: "Document", id: input.id }]);
    remote.put.mockImplementationOnce(async () => { fixture.revoked.add("finance"); return { success: true }; });
    await expect(ingestFile(finance, { workspaceId: ws, fileBuffer: Buffer.from("Captured private copy"), fileName: "copy.txt", mimeType: "text/plain", lineageRoots: roots })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(remote.remove).toHaveBeenCalledTimes(1); expect(fixture.tables.document).toHaveLength(1);
    expect(fixture.tables.document[0].textContent).toBe("Synthetic current source");
  });
});
