import { installSourcePermissionEpochFixture } from "../../domain/src/source-permission-epochs.test-fixture";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, resetFixture, known, alpha, beta, workspaceId } from "../../agents/src/agents/model-consumer.test-fixture";

const remote = vi.hoisted(() => ({ embed: vi.fn(), azure: vi.fn() }));
vi.mock("@corgtex/shared", async original => ({ ...await original<typeof import("@corgtex/shared")>(), prisma: fixture.prisma }));
vi.mock("../../domain/src/auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("../../domain/src/brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: any) => actor.kind === "agent" ? ["WORKSPACE"] : fixture.domains.get(actor.user.id) ?? [] }));
vi.mock("@corgtex/domain", async () => ({ ...await import("../../domain/src/source-lineage"), ...await import("../../domain/src/auth"),
  ...await import("../../domain/src/source-scoped-read"), ...await import("../../domain/src/artifact-commit-preflight") }));
vi.mock("@corgtex/models", () => ({ defaultModelGateway: { embed: remote.embed } }));
vi.mock("./retrieval", () => ({ invalidateKnowledgeCache: vi.fn() }));
vi.mock("./azure-search", () => ({ getKnowledgeSearchProvider: () => "postgres", isAzureKnowledgeSearchConfigured: () => false,
  syncAzureKnowledgeSource: remote.azure, logAzureKnowledgeIndexingWarning: vi.fn() }));
vi.mock("./counts", () => ({ countReadableKnowledgeChunks: vi.fn() }));

import { readableArtifactIds, lineageContentFingerprint, captureArtifactInputSnapshotProof, captureArtifactInputProof, isArtifactInputProofReadable } from "../../domain/src/source-lineage";
import { artifactPermissionEpochIdentities, capturePermissionEpochs } from "../../domain/src/source-permission-epochs";
import { reindexWorkspace, syncDocumentKnowledge, syncKnowledgeForSource } from "./chunks";

function matches(row: any, where: any) {
  return Object.entries(where ?? {}).every(([field, value]: [string, any]) => value && typeof value === "object" && "in" in value ? value.in.includes(row[field]) : row[field] === value);
}
async function original(id = "document") {
  const row = fixture.add("document", { id, workspaceId, title: "Original synthetic policy", textContent: "Human authored source body",
    source: "manual", mimeType: "text/plain", storageKey: `synthetic/${id}`, metadata: {}, accessDomain: "WORKSPACE", archivedAt: null });
  await known("Document", row, [], alpha); return row;
}
function legacy(source: any) {
  return fixture.add("knowledgeChunk", { id: `legacy-${source.id}`, workspaceId, sourceType: "DOCUMENT", sourceId: source.id,
    sourceTitle: source.title, content: "ARBITRARY LEGACY CLAIM", embedding: [900, 900], embeddingModel: "unproved", tokenCount: 999,
    chunkIndex: 0, accessDomain: "WORKSPACE", sensitivity: "INTERNAL", updatedAt: undefined, metadata: { sourceContentHash: lineageContentFingerprint("Document", source) } });
}
let epochs: ReturnType<typeof installSourcePermissionEpochFixture>;
async function currentReadable() {
  return readableArtifactIds(alpha, workspaceId, "KnowledgeChunk", fixture.rows.knowledgeChunk);
}

beforeEach(async () => {
  await resetFixture(); fixture.rows.knowledgeChunk = [];
  fixture.prisma.$queryRaw = vi.fn(async () => []);
  fixture.prisma.document.findFirst.mockImplementation(async ({ where }: any) => structuredClone(fixture.rows.document.find(row => Object.entries(where).every(([field, value]) =>
    value instanceof Date ? row[field] instanceof Date && row[field].getTime() === value.getTime() : row[field] === value)) ?? null));
  fixture.prisma.$transaction.mockImplementation(async (work: any) => {
    const before = structuredClone(fixture.rows);
    try { return await work({ ...fixture.prisma }); } catch (error) { for (const name of Object.keys(before)) fixture.rows[name] = before[name]; throw error; }
  });
  fixture.prisma.knowledgeChunk = {
    // Prisma returns independent row objects; metadata projection must not mutate
    // the persisted fixture or the embedding worker's intended output.
    findFirst: vi.fn(async ({ where }: any) => structuredClone(fixture.rows.knowledgeChunk.find(row => matches(row, where)) ?? null)),
    findMany: vi.fn(async ({ where, take }: any) => structuredClone(fixture.rows.knowledgeChunk.filter(row => matches(row, where)).slice(0, take))),
    deleteMany: vi.fn(async ({ where }: any) => { fixture.rows.knowledgeChunk = fixture.rows.knowledgeChunk.filter(row => !matches(row, where)); return { count: 1 }; }),
    createMany: vi.fn(async ({ data }: any) => { fixture.rows.knowledgeChunk.push(...structuredClone(data)); return { count: data.length }; }),
  };
  remote.embed.mockReset().mockImplementation(async ({ input }) => ({ embeddings: input.map(() => [1, 0]), usage: { model: "synthetic-current" } }));
  remote.azure.mockReset().mockResolvedValue({ skipped: true });
  delete process.env.KNOWLEDGE_SEARCH_PROVIDER;
  epochs = installSourcePermissionEpochFixture(fixture.prisma);
});

describe("generated KnowledgeChunk receipts with actual source helper", () => {
  it("withholds arbitrary legacy text/vector despite matching parent metadata until a real rebuild", async () => {
    const source = await original(); const unproved = legacy(source);
    expect(await currentReadable()).toEqual(new Set());
    await expect(captureArtifactInputSnapshotProof(alpha, workspaceId, { kind: "KnowledgeChunk", id: unproved.id }, fixture.prisma)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(await syncDocumentKnowledge({ workspaceId, documentId: source.id, lineageActor: alpha })).toBe(1);
    const chunk = fixture.rows.knowledgeChunk[0];
    expect(chunk.content).toBe(`${source.title}\n\n${source.textContent}`);
    expect(chunk.embedding).toEqual([1, 0]); expect(chunk.embeddingModel).toBe("synthetic-current");
    expect(fixture.manifest("KnowledgeChunk", chunk.id)).toMatchObject({ origin: "DERIVED", contentHash: lineageContentFingerprint("KnowledgeChunk", chunk) });
    expect(fixture.sources("KnowledgeChunk", chunk.id).has(`Document:${source.id}`)).toBe(true);
    expect(await currentReadable()).toEqual(new Set([chunk.id]));
    expect(fixture.rows.document[0]).toEqual(source);
  });

  it.each([["HUMAN_ORIGINAL", false], ["DERIVED", false], ["HUMAN_ORIGINAL", true], ["DERIVED", true]] as const)("rejects historical %s snapshot without a chunk receipt (current epoch %s)", async (origin, currentEpoch) => {
    const source = await original(); const unproved = legacy(source);
    const parentRoots = await captureArtifactInputProof(alpha, workspaceId, [{ kind: "Document", id: source.id }], fixture.prisma);
    const snapshot = fixture.add("artifactInputSnapshot", { id: "legacy-chunk-snapshot", workspaceId, sourceKind: "KnowledgeChunk", sourceId: unproved.id,
      sourceFingerprint: lineageContentFingerprint("KnowledgeChunk", unproved), origin,
      contentJson: JSON.parse(JSON.stringify(unproved)), accessEnvelopeJson: { accessDomain: "WORKSPACE" },
      rootsJson: origin === "DERIVED" ? parentRoots : [], updatedAt: undefined,
      epochProofVersion: currentEpoch ? 1 : null,
      permissionEpochsJson: currentEpoch ? await capturePermissionEpochs(fixture.prisma, workspaceId,
        artifactPermissionEpochIdentities("KnowledgeChunk", unproved)) : null });
    expect(await isArtifactInputProofReadable(alpha, workspaceId, [{ kind: "ArtifactInputSnapshot", id: snapshot.id,
      fingerprint: lineageContentFingerprint("ArtifactInputSnapshot", snapshot) }], fixture.prisma)).toBe(false);
  });

  it("reindexes an unreceipted legacy chunk even when its sourceContentHash is current", async () => {
    const source = await original(); legacy(source);
    expect(await reindexWorkspace(workspaceId, alpha)).toMatchObject({ reindexedDocuments: 1, reindexedArticles: 0, errors: [] });
    expect(await currentReadable()).toEqual(new Set([fixture.rows.knowledgeChunk[0].id]));
    expect(fixture.rows.knowledgeChunk[0].content).not.toContain("ARBITRARY LEGACY");
  });

  it("withholds a changed stored embedding/model/token until it is regenerated", async () => {
    const source = await original(); await syncDocumentKnowledge({ workspaceId, documentId: source.id, lineageActor: alpha });
    const row = fixture.rows.knowledgeChunk[0]; const createdAt = row.createdAt;
    row.embedding = [100, 0]; row.embeddingModel = "unattested"; row.tokenCount = 1000;
    expect(await currentReadable()).toEqual(new Set()); expect(row.createdAt).toBe(createdAt);
    await syncDocumentKnowledge({ workspaceId, documentId: source.id, lineageActor: alpha });
    expect(await currentReadable()).toEqual(new Set([fixture.rows.knowledgeChunk[0].id]));
  });

  it("rechecks source revocation and restoration without blessing old unknown chunks", async () => {
    const source = await original(); legacy(source);
    source.archivedAt = fixture.timestamp;
    expect(await syncDocumentKnowledge({ workspaceId, documentId: source.id, lineageActor: alpha })).toBe(0);
    expect(await currentReadable()).toEqual(new Set());
    source.archivedAt = null; source.updatedAt = new Date(fixture.timestamp.getTime() + 1);
    expect(await currentReadable()).toEqual(new Set());
    // This exact restored original is contributed afresh; legacy chunk output remains unproved.
    await known("Document", source, [], alpha);
    expect(await currentReadable()).toEqual(new Set());
    await syncDocumentKnowledge({ workspaceId, documentId: source.id, lineageActor: alpha });
    expect(await currentReadable()).toEqual(new Set([fixture.rows.knowledgeChunk[0].id]));
  });

  it("rejects stale source retries after embedding and keeps every original row unchanged", async () => {
    const source = await original(); const old = legacy(source);
    remote.embed.mockImplementationOnce(async () => { source.textContent = "Newly authored replacement"; source.updatedAt = new Date(fixture.timestamp.getTime() + 1);
      return { embeddings: [[0, 1]], usage: { model: "synthetic-current" } }; });
    expect(await syncDocumentKnowledge({ workspaceId, documentId: source.id, lineageActor: alpha })).toBe(0);
    expect(fixture.rows.knowledgeChunk).toEqual([old]); expect(fixture.manifest("KnowledgeChunk", old.id)).toBeUndefined();
    expect(remote.azure).not.toHaveBeenCalled(); expect(await currentReadable()).toEqual(new Set());
  });

  it("rejects an epoch-only revoke/restore during embedding even when the source body and grant are unchanged", async () => {
    const source = await original(); const old = legacy(source);
    remote.embed.mockImplementationOnce(async () => {
      epochs.bump(workspaceId, "Document", source.id); // revoke
      epochs.bump(workspaceId, "Document", source.id); // restore
      return { embeddings: [[1, 0]], usage: { model: "synthetic-current" } };
    });
    expect(await syncDocumentKnowledge({ workspaceId, documentId: source.id, lineageActor: alpha })).toBe(0);
    expect(fixture.rows.knowledgeChunk).toEqual([old]); expect(remote.azure).not.toHaveBeenCalled();
    expect(fixture.rows.document[0]).toEqual(source);
    // A fresh generation may capture the current vector after restoration.
    expect(await syncDocumentKnowledge({ workspaceId, documentId: source.id, lineageActor: alpha })).toBe(1);
    expect(await currentReadable()).toEqual(new Set([fixture.rows.knowledgeChunk[0].id]));
  });

  it("rolls back chunk replacement when complete receipt persistence fails", async () => {
    const source = await original(); const old = legacy(source);
    fixture.prisma.artifactInputLineage.create.mockImplementationOnce(async () => { throw new Error("Synthetic receipt failure"); });
    await expect(syncDocumentKnowledge({ workspaceId, documentId: source.id, lineageActor: alpha })).rejects.toThrow("Synthetic receipt failure");
    expect(fixture.rows.knowledgeChunk).toEqual([old]); expect(remote.azure).not.toHaveBeenCalled();
    expect(fixture.rows.document[0]).toEqual(source);
  });

  it("does not pass unsupported, unknown, private or arbitrary annotations to embedding", async () => {
    const source = await original();
    expect(await syncKnowledgeForSource({ workspaceId, sourceType: "EVENT", accessDomain: "WORKSPACE", sourceId: "unknown", content: "Private virtual text" })).toBe(0);
    expect(await syncKnowledgeForSource({ workspaceId, sourceType: "DOCUMENT", accessDomain: "WORKSPACE", sourceId: source.id, sourceTitle: source.title,
      content: `${source.title}\n\n${source.textContent}`, metadata: { copiedPrivateTitle: "Unproved annotation" }, lineageActor: alpha })).toBe(0);
    const privateSource = fixture.add("brainArticle", { id: "private", workspaceId, title: "Private owner", bodyMd: "Private owner body", isPrivate: true, ownerMemberId: "member-alpha", archivedAt: null });
    await known("BrainArticle", privateSource, [], alpha);
    expect(await syncKnowledgeForSource({ workspaceId, sourceType: "BRAIN_ARTICLE", accessDomain: "WORKSPACE", sourceId: privateSource.id,
      sourceTitle: privateSource.title, content: privateSource.bodyMd, lineageActor: beta })).toBe(0);
    expect(remote.embed).not.toHaveBeenCalled(); expect(remote.azure).not.toHaveBeenCalled();
  });
});
