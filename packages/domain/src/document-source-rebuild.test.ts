import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, resetFixture, alpha, beta, workspaceId } from "../../agents/src/agents/model-consumer.test-fixture";
vi.mock("@corgtex/shared", async original => ({ ...await original<typeof import("@corgtex/shared")>(), prisma: fixture.prisma }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async () => ["WORKSPACE"] }));
import { rebuildDocumentBrainSource } from "./document-source-rebuild";
import { readableArtifactIds, recordArtifactInputLineage } from "./source-lineage";

let source: any;
let document: any;
beforeEach(async () => {
  await resetFixture();
  fixture.rows.member.find(row => row.userId === "alpha").role = "ADMIN";
  fixture.prisma.financeImportBatch = { findFirst: vi.fn(async () => null) };
  document = fixture.add("document", { id: "native-document", workspaceId, title: "Current native title", source: "upload",
    textContent: "Current original content", metadata: { ingestionGuidanceMd: "Current native instruction" }, storageKey: "safe/file", mimeType: "text/plain",
    accessDomain: "WORKSPACE", archivedAt: null });
  await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId, artifact: { kind: "Document", id: document.id },
    content: document, origin: "HUMAN_ORIGINAL", inputs: [] });
  source = fixture.add("brainSource", { id: "legacy-copy", workspaceId, sourceType: "DOC", accessDomain: "WORKSPACE", authorMemberId: null,
    title: "PRIVATE unknown title", content: "PRIVATE unknown body", ingestionGuidanceMd: "PRIVATE instructions", tier: 3,
    fileStorageKey: "other/secret", fileName: "PRIVATE", fileSizeBytes: 91, externalId: "PRIVATE", metadata: { documentId: document.id, privateText: "PRIVATE" } });
  const query = fixture.prisma.$queryRaw.getMockImplementation()!;
  fixture.prisma.$queryRaw.mockImplementation(async (...args: any[]) => {
    const sql = Array.isArray(args[0]) ? args[0].join("?") : "";
    if (!sql.includes('"sourceType"::text')) return query(...args);
    expect(sql).not.toMatch(/\b(content|title|ingestionGuidanceMd|previousState)\b/);
    const row = fixture.rows.brainSource.find(value => value.id === args[1] && value.workspaceId === args[2] && !value.archivedAt);
    if (!row) return [];
    return [{ id: row.id, workspaceId: row.workspaceId, sourceType: row.sourceType, accessDomain: row.accessDomain,
      authorMemberId: row.authorMemberId, documentId: typeof row.metadata?.documentId === "string" ? row.metadata.documentId : null,
      bindingMalformed: typeof row.metadata?.documentId !== "string" }];
  });
});
describe("document source rebuilding", () => {
  it("copies only proven current document content and preserves UNKNOWN bytes without certifying history", async () => {
    expect(await readableArtifactIds(alpha, workspaceId, "BrainSource", [source], fixture.prisma)).toEqual(new Set());
    const updated = await rebuildDocumentBrainSource(alpha, { workspaceId, sourceId: source.id });
    expect(updated).toMatchObject({ content: "Current native title\n\nCurrent original content", title: document.title,
      ingestionGuidanceMd: "Current native instruction", tier: 2, externalId: null, fileName: null, fileStorageKey: null,
      authorMemberId: null, accessDomain: "WORKSPACE" });
    expect(JSON.stringify(updated)).not.toContain("PRIVATE");
    expect(fixture.rows.artifactInputSnapshot.find(row => row.sourceKind === "BrainSource" && row.sourceId === source.id))
      .toMatchObject({ origin: "UNKNOWN", contentJson: { content: "PRIVATE unknown body" }, rootsJson: [] });
    expect(await readableArtifactIds(alpha, workspaceId, "BrainSource", [updated], fixture.prisma)).toEqual(new Set([source.id]));
  });
  it("preserves known human originals and denies foreign/unproven documents", async () => {
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId, artifact: { kind: "BrainSource", id: source.id },
      content: source, origin: "HUMAN_ORIGINAL", inputs: [] });
    await expect(rebuildDocumentBrainSource(alpha, { workspaceId, sourceId: source.id })).rejects.toMatchObject({ code: "MANUAL_REBUILD_REQUIRED" });
    expect(fixture.rows.brainSource[0].content).toBe(source.content);
    fixture.rows.artifactInputLineage = fixture.rows.artifactInputLineage.filter(row => row.artifactType !== "BrainSource" && row.artifactType !== "Document");
    await expect(rebuildDocumentBrainSource(alpha, { workspaceId, sourceId: source.id })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    fixture.rows.document[0].workspaceId = "foreign";
    await expect(rebuildDocumentBrainSource(alpha, { workspaceId, sourceId: source.id })).rejects.toMatchObject({ code: "MANUAL_REBUILD_REQUIRED" });
    expect(fixture.rows.artifactInputSnapshot).toEqual([]);
  });
  it("requires current source authority before any old bytes are preserved", async () => {
    await expect(rebuildDocumentBrainSource(beta, { workspaceId, sourceId: source.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fixture.rows.artifactInputSnapshot).toEqual([]);
    expect(fixture.rows.brainSource[0].content).toBe(source.content);
  });
  it("rolls back an actual SQL output that contains content outside the proven document projection", async () => {
    const update = fixture.prisma.brainSource.update.getMockImplementation()!;
    fixture.prisma.brainSource.update.mockImplementationOnce(async (args: any) => {
      const row = await update(args);
      fixture.rows.brainSource.find(value => value.id === row.id).content = "PRIVATE unrelated SQL content";
      return { ...row, content: "PRIVATE unrelated SQL content" };
    });
    await expect(rebuildDocumentBrainSource(alpha, { workspaceId, sourceId: source.id })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.rows.brainSource[0].content).toBe("PRIVATE unknown body");
    expect(fixture.rows.artifactInputSnapshot).toEqual([]);
    expect(fixture.rows.artifactInputLineage.filter(row => row.artifactType === "BrainSource")).toEqual([]);
  });
});
