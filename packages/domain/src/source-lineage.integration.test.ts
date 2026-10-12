import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { readableArtifactIds, recordArtifactInputLineage } from "./source-lineage";

describe("complete input lineage", () => {
  beforeEach(async () => { await truncateAllTables(); });

  it("isolates workspaces, private inputs, revocation, unknown lineage, and original articles", async () => {
    const [workspace, otherWorkspace] = await Promise.all([
      prisma.workspace.create({ data: { name: "Lineage fixture", slug: `lineage-${randomUUID()}` } }),
      prisma.workspace.create({ data: { name: "Other fixture", slug: `lineage-${randomUUID()}` } }),
    ]);
    const [owner, reader] = await Promise.all([
      prisma.user.create({ data: { email: `lineage-owner-${randomUUID()}@example.test`, passwordHash: "synthetic" } }),
      prisma.user.create({ data: { email: `lineage-reader-${randomUUID()}@example.test`, passwordHash: "synthetic" } }),
    ]);
    const [ownerMember] = await Promise.all([
      prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "CONTRIBUTOR" } }),
      prisma.member.create({ data: { workspaceId: workspace.id, userId: reader.id, role: "CONTRIBUTOR" } }),
      prisma.member.create({ data: { workspaceId: otherWorkspace.id, userId: reader.id, role: "ADMIN" } }),
    ]);
    const ownerActor: AppActor = { kind: "user", user: { id: owner.id, email: owner.email, displayName: "Owner" } };
    const readerActor: AppActor = { kind: "user", user: { id: reader.id, email: reader.email, displayName: "Reader" } };
    const agent: AppActor = { kind: "agent", authProvider: "bootstrap", label: "synthetic-lineage", workspaceIds: [workspace.id] };
    const source = await prisma.brainSource.create({ data: {
      workspaceId: workspace.id, sourceType: "DOC", tier: 1, title: "Private input", content: "Synthetic private fact",
    } });
    const privateOriginal = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "private-original", title: "Private original", type: "PROJECT",
      bodyMd: "Synthetic owner text", sourceIds: [], authority: "DRAFT", isPrivate: true, ownerMemberId: ownerMember.id,
    } });
    const derived = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "mixed-derived", title: "Mixed derived", type: "PROJECT",
      bodyMd: "Synthetic private fact and owner text", sourceIds: [source.id], authority: "REFERENCE",
    } });
    const unknown = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "unknown-legacy", title: "Unknown legacy", type: "PROJECT",
      bodyMd: "Could contain restricted text", sourceIds: [source.id], authority: "REFERENCE",
    } });
    await prisma.$transaction(async (tx) => {
      await recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
        artifact: { kind: "BrainArticle", id: privateOriginal.id }, content: privateOriginal,
        origin: "HUMAN_ORIGINAL", inputs: [],
      });
      await recordArtifactInputLineage({ tx, actor: agent, workspaceId: workspace.id,
        artifact: { kind: "BrainArticle", id: derived.id }, content: derived,
        origin: "DERIVED", inputs: [
          { kind: "BrainSource", id: source.id }, { kind: "BrainArticle", id: privateOriginal.id },
        ],
      });
    });
    const records = [privateOriginal, derived, unknown];
    expect(await readableArtifactIds(ownerActor, workspace.id, "BrainArticle", records))
      .toEqual(new Set([privateOriginal.id, derived.id]));
    expect(await readableArtifactIds(readerActor, workspace.id, "BrainArticle", records)).toEqual(new Set());
    expect(await readableArtifactIds(readerActor, otherWorkspace.id, "BrainArticle", records)).toEqual(new Set());

    // The original remains available when its unrelated source is withdrawn.
    await prisma.brainSource.update({ where: { id: source.id }, data: { archivedAt: new Date() } });
    expect(await readableArtifactIds(ownerActor, workspace.id, "BrainArticle", records))
      .toEqual(new Set([privateOriginal.id]));
    await prisma.brainSource.update({ where: { id: source.id }, data: { archivedAt: null, content: "Replaced fact" } });
    expect(await readableArtifactIds(ownerActor, workspace.id, "BrainArticle", records))
      .toEqual(new Set([privateOriginal.id]));
  });
});
