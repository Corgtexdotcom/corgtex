import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { rebuildDocumentBrainSource } from "./document-source-rebuild";
import { createDocument } from "./documents";
import { advanceHumanArtifactInputLineage, captureArtifactInputProof, isArtifactInputProofReadable, readableArtifactIds, recordArtifactInputLineage } from "./source-lineage";

beforeEach(truncateAllTables);
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic rebuild", slug: `rebuild-${randomUUID()}` } });
  const user = await prisma.user.create({ data: { email: `rebuild-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const other = await prisma.user.create({ data: { email: `rebuild-other-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: other.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Admin" } };
  const otherActor: AppActor = { kind: "user", user: { id: other.id, email: other.email, displayName: "Contributor" } };
  const document = await createDocument(actor, { workspaceId: workspace.id, title: "Independent current document",
    source: "upload", storageKey: `synthetic/${randomUUID()}`, textContent: "Original document facts" });
  const source = await prisma.brainSource.findFirstOrThrow({ where: { workspaceId: workspace.id, metadata: { path: ["documentId"], equals: document.id } } });
  return { workspace, member, actor, otherActor, document, source };
}

describe("fresh document-source derivation", () => {
  it("rebuilds after source revoke/restore without promoting old receipts and preserves source policy", async () => {
    const f = await fixture();
    const originalRoots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "BrainSource", id: f.source.id }]);
    const originalManifest = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "BrainSource", artifactId: f.source.id } });
    await prisma.brainSource.update({ where: { id: f.source.id }, data: { accessDomain: "FINANCE" } });
    expect(await isArtifactInputProofReadable(f.otherActor, f.workspace.id, originalRoots)).toBe(false);
    await prisma.brainSource.update({ where: { id: f.source.id }, data: { accessDomain: "WORKSPACE" } });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, originalRoots)).toBe(false);
    const rebuilt = await rebuildDocumentBrainSource(f.actor, { workspaceId: f.workspace.id, sourceId: f.source.id });
    expect(rebuilt).toMatchObject({ id: f.source.id, sourceType: "DOC", accessDomain: "WORKSPACE", authorMemberId: f.member.id,
      title: f.document.title, content: `${f.document.title}\n\n${f.document.textContent}` });
    expect(await readableArtifactIds(f.otherActor, f.workspace.id, "BrainSource", [rebuilt])).toEqual(new Set([rebuilt.id]));
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, originalRoots)).toBe(false);
    expect(await prisma.artifactInputLineage.findUniqueOrThrow({ where: { id: originalManifest.id } })).toEqual(originalManifest);
    expect(await prisma.artifactInputSnapshot.findFirstOrThrow({ where: { sourceKind: "BrainSource", sourceId: f.source.id, origin: "UNKNOWN" } }))
      .toMatchObject({ contentJson: { content: f.source.content, title: f.source.title }, rootsJson: [] });
    expect(await prisma.document.findUniqueOrThrow({ where: { id: f.document.id } })).toEqual(f.document);
  });

  it("explicitly replaces an unknown copied slot from a proven document without carrying private semantic fields", async () => {
    const f = await fixture();
    const unknown = await prisma.brainSource.create({ data: { workspaceId: f.workspace.id, sourceType: "FILE_UPLOAD", tier: 3,
      authorMemberId: f.member.id, content: "PRIVATE unknown body", title: "PRIVATE title", ingestionGuidanceMd: "PRIVATE instructions",
      fileName: "PRIVATE filename", externalId: "PRIVATE id", metadata: { documentId: f.document.id, privateBody: "PRIVATE" } } });
    await expect(rebuildDocumentBrainSource(f.otherActor, { workspaceId: f.workspace.id, sourceId: unknown.id }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const rebuilt = await rebuildDocumentBrainSource(f.actor, { workspaceId: f.workspace.id, sourceId: unknown.id });
    expect(JSON.stringify(rebuilt)).not.toContain("PRIVATE");
    expect(rebuilt).toMatchObject({ id: unknown.id, sourceType: "FILE_UPLOAD", authorMemberId: f.member.id, accessDomain: "WORKSPACE",
      fileStorageKey: f.document.storageKey, fileName: null, ingestionGuidanceMd: null, externalId: null });
    const historical = await prisma.artifactInputSnapshot.findFirstOrThrow({ where: { sourceKind: "BrainSource", sourceId: unknown.id } });
    expect(historical).toMatchObject({ origin: "UNKNOWN", contentJson: { content: "PRIVATE unknown body", title: "PRIVATE title" } });
    expect(await readableArtifactIds(f.actor, f.workspace.id, "ArtifactInputSnapshot", [historical])).toEqual(new Set());
  });

  it("denies unknown/foreign documents and preserves independently authored original sources", async () => {
    const f = await fixture();
    const unknownDocument = await prisma.document.create({ data: { workspaceId: f.workspace.id, title: "Unknown document",
      source: "upload", storageKey: `synthetic/${randomUUID()}`, textContent: "UNKNOWN body" } });
    const unknown = await prisma.brainSource.create({ data: { workspaceId: f.workspace.id, sourceType: "DOC", tier: 1,
      content: "Unproven old copy", metadata: { documentId: unknownDocument.id } } });
    await expect(rebuildDocumentBrainSource(f.actor, { workspaceId: f.workspace.id, sourceId: unknown.id })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    const original = await prisma.brainSource.create({ data: { workspaceId: f.workspace.id, sourceType: "DOC", tier: 1,
      content: "Independently authored body", metadata: { documentId: f.document.id } } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
      artifact: { kind: "BrainSource", id: original.id }, content: original, origin: "HUMAN_ORIGINAL", inputs: [] }));
    await expect(rebuildDocumentBrainSource(f.actor, { workspaceId: f.workspace.id, sourceId: original.id })).rejects.toMatchObject({ code: "MANUAL_REBUILD_REQUIRED" });
    const foreign = await prisma.workspace.create({ data: { name: "Foreign", slug: `foreign-${randomUUID()}` } });
    const document = await prisma.document.create({ data: { workspaceId: foreign.id, title: "Foreign body", source: "upload",
      storageKey: `synthetic/${randomUUID()}`, textContent: "FOREIGN" } });
    await prisma.brainSource.update({ where: { id: unknown.id }, data: { metadata: { documentId: document.id } } });
    await expect(rebuildDocumentBrainSource(f.actor, { workspaceId: f.workspace.id, sourceId: unknown.id })).rejects.toMatchObject({ code: "MANUAL_REBUILD_REQUIRED" });
    expect(await prisma.brainSource.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect(await prisma.artifactInputSnapshot.count({ where: { sourceKind: "BrainSource" } })).toBe(0);
  });

  it("captures a fresh document permission episode without refreshing previous derived source vectors", async () => {
    const f = await fixture();
    const old = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "BrainSource", id: f.source.id }]);
    const changeOriginalDomain = (accessDomain: "FINANCE" | "WORKSPACE") => prisma.$transaction(async tx => {
      const before = await tx.document.findUniqueOrThrow({ where: { id: f.document.id } });
      const after = await tx.document.update({ where: { id: f.document.id }, data: { accessDomain } });
      expect(after.textContent).toBe(before.textContent);
      await advanceHumanArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
        artifact: { kind: "Document", id: before.id }, before, after });
    });
    await changeOriginalDomain("FINANCE");
    await expect(rebuildDocumentBrainSource(f.otherActor, { workspaceId: f.workspace.id, sourceId: f.source.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await changeOriginalDomain("WORKSPACE");
    const rebuilt = await rebuildDocumentBrainSource(f.actor, { workspaceId: f.workspace.id, sourceId: f.source.id });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, old)).toBe(false);
    expect(await readableArtifactIds(f.actor, f.workspace.id, "BrainSource", [rebuilt])).toEqual(new Set([rebuilt.id]));
  });
});
