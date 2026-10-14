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
  const names = ["crmAccount", "crmContact", "crmDeal", "crmActivity", "crmDealStageTransition", "crmConversation", "crmConversationMessage",
    "crmProspectWorkspace", "crmCommunicationSuggestion", "document", "meeting", "meetingInsight", "artifactInputLineage", "artifactInputSnapshot", "workspace", "executionRequest", "executionResult", "demoLead", "crmQualification", "workflowJob", "brainArticle", "brainSource", "mcpToolInput", "member", "user", "knowledgeChunk", "externalMcpConnection", "externalContentSource", "externalContentSyncLog", "externalProviderFetchInput"];
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
        const row = { id: `${name}-${tables[name].length + 1}`, archivedAt: null, createdAt: time,
          ...(name === "externalProviderFetchInput" ? { fetchedAt: time } : {}),
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
vi.mock("../../shared/src/env", () => ({ env: { ENCRYPTION_KEY: "b".repeat(64) } }));
vi.mock("@corgtex/shared", async () => ({ ...await import("../../shared/src/crypto"), prisma: fixture.prisma, env: { APP_URL: "https://synthetic.test" }, getSharedStateBackend: () => "redis", logger: { warn: vi.fn() }, toInputJson: (value: unknown) => value }));
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
const remote = vi.hoisted(() => ({ boxDetails: { id: "file", name: "Box title", etag: "v1" } as Record<string, unknown>, boxContent: { text: "Provider exact content" } as Record<string, unknown>, providerRead: vi.fn(), embed: vi.fn(), azure: vi.fn(), provider: "none", put: vi.fn(), remove: vi.fn() }));
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
vi.mock("../../domain/src/action-policy", () => ({ evaluateDelegatedActionPolicy: vi.fn() }));
vi.mock("../../domain/src/external-mcp", async importOriginal => ({ ...await importOriginal<typeof import("../../domain/src/external-mcp")>(),
  readBoxExternalMcpNativeResponse: remote.providerRead }));
import { syncKnowledgeForSource } from "./chunks";
import { selectExternalContentSource, syncExternalContentSource } from "../../domain/src/external-content-sources";
import { readableArtifactIds } from "../../domain/src/source-lineage";
const owner = { kind: "user", user: { id: "general", email: "general@synthetic.test" } } as AppActor;
const other = { kind: "user", user: { id: "finance", email: "finance@synthetic.test" } } as AppActor;
const ws = "ws-crm";
async function setup() {
  await fixture.prisma.member.create({ data: { id: "owner-member", workspaceId: ws, userId: "general", isActive: true } });
  await fixture.prisma.member.create({ data: { id: "other-member", workspaceId: ws, userId: "finance", isActive: true } });
  await fixture.prisma.externalMcpConnection.create({ data: { id: "connection", workspaceId: ws, userId: "general", providerKey: "box",
    serverUrl: "https://mcp.box.com", providerAccountId: "box-owner", scopes: ["root_readwrite"], status: "ACTIVE", accessTokenEnc: "synthetic" } });
  const source = await selectExternalContentSource(owner, { workspaceId: ws, providerKey: "box", sourceKind: "FILE", externalId: "file", connectionId: "connection", title: "Native selection" });
  const job = fixture.tables.workflowJob.at(-1); Object.assign(job, { status: "RUNNING", lockedBy: "worker", lockedAt: fixture.time, startedAt: fixture.time, attempts: 1 });
  return { source, job };
}
const index = (input: any) => syncKnowledgeForSource({ ...input, accessDomain: "WORKSPACE" });
describe("External content indexing full source receipts", () => {
  beforeEach(() => { for (const name of Object.keys(fixture.tables)) fixture.tables[name] = [];
    fixture.revoked.clear(); fixture.departed.clear(); vi.clearAllMocks(); remote.provider = "none";
    remote.boxDetails = { id: "file", name: "Box title", etag: "v1" }; remote.boxContent = { text: "Provider exact content" };
    remote.providerRead.mockImplementation(async ({ toolName }: any) => structuredClone(toolName === "get_file_details" ? remote.boxDetails : remote.boxContent));
    remote.embed.mockResolvedValue({ embeddings: [[0, 1]], usage: { model: "synthetic" } }); remote.azure.mockResolvedValue({ skipped: true });
    fixture.prisma.knowledgeChunk.deleteMany = vi.fn(async () => { fixture.tables.knowledgeChunk = []; return { count: 1 }; });
    fixture.prisma.knowledgeChunk.createMany = vi.fn(async ({ data }: any) => { fixture.tables.knowledgeChunk.push(...data); return { count: data.length }; });
    installSourcePermissionEpochFixture(fixture.prisma);
  });
  it("embeds only a committed provider receipt, storing exact parent hash and owner-only child proof", async () => {
    const { source, job } = await setup();
    const result = await syncExternalContentSource({ workspaceId: ws, sourceId: source.id, workflowJobId: job.id, syncKnowledge: index });
    expect(result.status).toBe("SYNCED"); expect(remote.embed).toHaveBeenCalledTimes(1);
    const chunks = fixture.tables.knowledgeChunk; expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("Provider exact content"); expect(chunks[0].metadata.sourceContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await readableArtifactIds(owner, ws, "KnowledgeChunk", chunks)).toEqual(new Set([chunks[0].id]));
    expect(await readableArtifactIds(other, ws, "KnowledgeChunk", chunks)).toEqual(new Set());
    fixture.tables.externalMcpConnection[0].status = "DISCONNECTED";
    expect(await readableArtifactIds(owner, ws, "KnowledgeChunk", chunks)).toEqual(new Set()); expect(fixture.tables.knowledgeChunk).toHaveLength(1);
  });
  it("withholds unknown external copies before embedding and preserves existing chunks", async () => {
    await fixture.prisma.externalContentSource.create({ data: { id: "legacy", workspaceId: ws, title: "Unproven copy", metadata: { materializedContent: "Private copied body" } } });
    fixture.tables.knowledgeChunk.push({ id: "original", workspaceId: ws, sourceType: "EXTERNAL_CONTENT", sourceId: "legacy" });
    expect(await index({ workspaceId: ws, sourceType: "EXTERNAL_CONTENT", sourceId: "legacy", sourceTitle: "Unproven copy", content: "Private copied body", lineageActor: owner })).toBe(0);
    expect(remote.embed).not.toHaveBeenCalled(); expect(fixture.prisma.knowledgeChunk.deleteMany).not.toHaveBeenCalled();
    expect(fixture.tables.knowledgeChunk).toHaveLength(1);
  });
  it("rejects spoofed raw content and bare workers before embedding", async () => {
    const { source, job } = await setup(); let captured: any;
    await syncExternalContentSource({ workspaceId: ws, sourceId: source.id, workflowJobId: job.id, syncKnowledge: async input => { captured = input; return 0; } });
    expect(await index({ ...captured, content: "Uncaptured raw body" })).toBe(0);
    expect(await index({ ...captured, lineageActor: undefined })).toBe(0);
    expect(remote.embed).not.toHaveBeenCalled();
  });
  it("does not certify arbitrary caller metadata or mutable raw bindings as provider inputs", async () => {
    const { source, job } = await setup(); let captured: any;
    await syncExternalContentSource({ workspaceId: ws, sourceId: source.id, workflowJobId: job.id, syncKnowledge: async input => { captured = input; return 0; } });
    const params = { ...captured, accessDomain: "WORKSPACE" as const, metadata: { copiedPrivateTitle: "Uncaptured private annotation" } };
    remote.embed.mockImplementationOnce(async () => { params.metadata.copiedPrivateTitle = "Later private annotation"; params.sourceId = "other";
      return { embeddings: [[1, 0]], usage: { model: "synthetic" } }; });
    expect(await syncKnowledgeForSource(params)).toBe(1);
    expect(fixture.tables.knowledgeChunk[0].sourceId).toBe(source.id);
    expect(JSON.stringify(fixture.tables.knowledgeChunk[0].metadata)).not.toContain("private annotation");
  });
  it("rechecks live provider bytes after embedding without deleting prior rows on change", async () => {
    const { source, job } = await setup(); fixture.tables.knowledgeChunk.push({ id: "prior", workspaceId: ws, sourceType: "EXTERNAL_CONTENT", sourceId: source.id });
    remote.embed.mockImplementationOnce(async () => { remote.boxContent.text = "Changed during embedding"; return { embeddings: [[1, 0]], usage: { model: "synthetic" } }; });
    await expect(syncExternalContentSource({ workspaceId: ws, sourceId: source.id, workflowJobId: job.id, syncKnowledge: index })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.prisma.knowledgeChunk.deleteMany).not.toHaveBeenCalled(); expect(fixture.tables.knowledgeChunk[0].id).toBe("prior");
    expect(await readableArtifactIds(owner, ws, "BrainSource", fixture.tables.brainSource)).toEqual(new Set());
  });
  it("rechecks the exact worker lease before storing model output", async () => {
    const { source, job } = await setup();
    remote.embed.mockImplementationOnce(async () => { job.lockedBy = "replacement-worker"; return { embeddings: [[1, 0]], usage: { model: "synthetic" } }; });
    await expect(syncExternalContentSource({ workspaceId: ws, sourceId: source.id, workflowJobId: job.id, syncKnowledge: index })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.prisma.knowledgeChunk.createMany).not.toHaveBeenCalled();
  });
  it("never deletes external originals through an arbitrary empty caller payload", async () => {
    fixture.tables.knowledgeChunk.push({ id: "original", workspaceId: ws, sourceType: "EXTERNAL_CONTENT", sourceId: "legacy" });
    expect(await index({ workspaceId: ws, sourceType: "EXTERNAL_CONTENT", sourceId: "legacy", content: "", lineageActor: owner })).toBe(0);
    expect(fixture.prisma.knowledgeChunk.deleteMany).not.toHaveBeenCalled(); expect(fixture.tables.knowledgeChunk).toHaveLength(1);
  });
});
